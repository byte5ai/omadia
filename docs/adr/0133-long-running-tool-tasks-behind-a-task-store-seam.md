# 0133 — Long-running tools return a handle: one task-store seam, leased, resumed where safe, failed where not

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; the seam from #543 (W2-2; first commit on these paths is #550), the durable store and
  resume driver from #560 (#663), reap-metric fencing from #561 (#670), the carried
  execution context from spec 2042 §5.10 (recorded retroactively from the code on main)

## Context and Problem Statement

A chat turn is a streaming response that ends when the model loop ends; there is no
park and resume for a turn. A tool that takes minutes, such as a helper running its own
multi-turn loop, either blocks the turn into proxy idle timeouts and Teams activity expiry,
or needs another shape. The first tool that needed it hand-rolled a job store. What is the
one shape for tools that outlive a turn, and what happens to their work across a restart?
This record is retroactive.

## Decision Drivers

- A turn must never be held open for minutes.
- A status poll must tell the truth; `working` forever is a lie.
- A partially executed, non-idempotent executor must not be re-run blindly.
- A result must not reach the model or a card around the privacy shield.
- The work must stay attributed to the agent that started it
  ([ADR-0017](0017-model-gateway-and-execution-contexts.md)).

## Considered Options

- **A — A generic `TaskStore` seam: `_start` / `_status` / `_list`, lease-fenced writes,
  an in-memory reference and a Postgres twin held to one conformance suite**
- **B — The MCP Tasks extension**
- **C — Block the turn** behind a long dispatch deadline
- **D — A bespoke job store per tool**

## Decision Outcome

Chosen option: **A**.

- **Any tool can opt in** (`longRunningTool.ts`) and gets `<tool>_start`, `<tool>_status`
  and `<tool>_list`. `_start` returns a handle at once; the work runs in a detached runner;
  the model answers "started, I'll report back" and a later turn polls. The blocking
  `ask_<name>` helper tool stays beside it; the deferred shape is opt-in per helper.
- **Model-facing payloads.** `_start` returns
  `{"status":"task_started","taskId":…,"tool":…,"kind":…,"phase":"queued"}` and its prompt doc
  says it does not answer the question. `_status` returns status, phase, result or error and
  recent events; `_list` returns tasks with kind, status and phase.
- **The dispatch deadline has nothing to cancel.** `_start` returns in milliseconds, far
  inside `OMADIA_TOOL_DISPATCH_TIMEOUT_MS` (default 240 s), and the work never runs inside the
  dispatch call. Because the runner outlives the starting request, it decides its tool calls
  on a replay ledger of its own (`runDetachedFromRequestLedger`), never on the request's.
- **A lost lease does not lose the outcome.** A runner whose terminal write finds its lease
  gone reports the real outcome through `onOutcomeLost` instead of overwriting; the default
  handler logs metadata only, never `result`, because the log is outside the privacy shield.
- **Four statuses, chosen to project onto MCP Tasks:** `working`, `input_required`,
  `completed`, `failed`. A richer vocabulary projects down; `phase` carries the detail.
- **Read and write halves are separate interfaces** (`TaskReadStore`, `TaskStore`), so a
  consumer can expose reads to a tool while its terminal write passes its own gate.
- **Lease fencing.** Every lease-bound write is guarded by
  `claimed_by = <lease> AND status NOT IN ('completed','failed')`; zero rows is
  `TaskLeaseLostError`. Terminal rows are immutable. Claims use `FOR UPDATE SKIP LOCKED`.
- **Two stores, one contract.** `InMemoryTaskStore` is the reference; `DurableTaskStore`
  (tables `tasks`, `task_events`, migration 0034) is used when Postgres is present. Both run
  the same assertions from `test/tasks/taskStoreConformance.ts`.
- **Resume what is safe, fail what is not.** The resume driver (at boot and every 5 min, at
  most 100 per source per sweep) claims only `working` tasks with no lease: never-claimed
  rows and rows un-parked by `provideInput`. It never steals a stale lease. A task orphaned
  mid-execution is force-failed by the reaper after `LONG_RUNNING_TASK_STALE_MS` (15 min);
  terminal rows are purged after `LONG_RUNNING_TASK_RETAIN_MS` (1 h).
- **A parked task has no heartbeat** and is not reaped by the liveness window; it expires
  only under the explicit opt-in `parkedStaleAfterMs`.
- **Results reach the model only through `_status`,** an ordinary tool call in a live later
  turn, so that turn's privacy pass applies. Two invariants are tested: a task card carries
  no result and no input, and there is no push channel from a finished task into a
  conversation.
- **The starting agent turn travels with the task.** The runner executes inside that
  stored execution context from a fresh root: model calls stay the agent's, while the
  turn's deadline, abort signal and budget end with the turn. A task started outside an
  agent turn carries none, and the gateway refuses its model calls.
- **Listing is owner-scoped;** callers without an identity share one literal owner rather
  than dropping the filter.

### Consequences

- 🟢 **Good:** Slow tools no longer block or break turns; tasks survive a restart where
  Postgres is present.
- 🟢 **Good:** One contract, one conformance suite, no second job store per tool.
- 🔴 **Bad:** The model must poll; a user gets the answer only in a later turn.
- 🔴 **Bad:** Work orphaned mid-execution is lost and reported failed, never resumed.
- 🔴 **Bad:** Accepted limitation named in the code: work inside the detached runner that
  bypasses the privacy shield cannot be recorded against the originating turn, and the
  owning plugin's privacy mode is not available to the runner (it then does not bypass).
- 🔴 **Bad:** Without Postgres every task dies with the process.
- ⚪ **Neutral:** Not the MCP Tasks wire protocol; a later projection is a mapping.

## Pros and Cons of the Options

### A — Task-store seam

- 🟢 Generic, durable, truthful under failure.
- 🔴 A second lease mechanism beside Conductor runs.

### B — MCP Tasks

- 🟢 A standard.
- 🔴 Internal helper dispatches never cross an MCP boundary; the code comment records that
  the redesigned extension (SEP-2663) was not shipped in the SDK at the time.

### C — Block the turn

- 🟢 One turn, one answer.
- 🔴 Idle timeouts, activity expiry, reaped connections.

### D — Bespoke store per tool

- 🔴 The state this replaced.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/tasks/{taskTypes,longRunningTool,subAgentTaskTool,inMemoryTaskStore,taskReaper,taskResumeDriver}.ts`,
  `middleware/src/tasks/durableTaskStore.ts`, `middleware/migrations/0034_tasks.sql`,
  wiring in `middleware/src/index.ts`.
- Deferred-result privacy posture: `describeDeferredPrivacyPosture()` in `longRunningTool.ts`.
- Tests: `middleware/test/tasks/` (`taskStoreConformance.ts`, `.mem.test.ts`,
  `durableTaskStore.pg.test.ts`, `taskReaper.test.ts`, `taskResumeDriver.test.ts`,
  `longRunningTool.test.ts`, `subAgentTaskTool.test.ts`).
- Related: ADR-0016 (internal helpers), ADR-0017, ADR-0034,
  [ADR-0128](0128-conductor-durable-runs-lease-fencing-and-reconcile.md). Border: agent runtime, privacy shield.
