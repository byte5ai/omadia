# Dormant capabilities — activate, defer, or delete

Adversarial review of `acceptance.md` found capabilities the matrix listed as live that have
**never executed in production**. The count grew twice under scrutiny: three, then four, then
five. Each was designed as a proper feature; each stopped one wire short.

This document decides what happens to each — **before** the extraction, because deciding after
the move means paying a core release plus a plugin release for every answer.

The three verdicts are **not the same**, and that is the finding.

> ### Corrections from the verification pass
>
> A full check against the code found errors in the first draft of this document. The
> verdicts survive; several supporting arguments did not.
>
> | Claim | Correction |
> |---|---|
> | Cold-start costs "$150 unattended" | **$500.** Default budget is $5/job, page limit 100. I understated it by 3× |
> | "A dry run would spend real money" | **Overstated.** The supported route is `previewRun`, which explicitly stubs action steps. `startRun({isDryRun:true})` has no production caller. Still worth a defensive guard in C5b, but it is not a live exposure |
> | "Nobody has ever been able to author this step" | **Wrong.** Validation via `listActions` is bypassed on the raw `POST /` path. Zero demand may still hold; validation impossibility does not prove it |
> | "A poller with nothing to poll" | **Overstated.** `TrackerRegistry` has a built-in GitHub fallback needing no registration. `registerTracker` having no callers is true; "nothing to poll" is not |
> | Hook `DevJobStore.finishTerminal` for terminal events | **Wrong — contradicts our own contract.** `finalizeDevJob` is the documented choke point, and `core-decoupling-checklist.md` names it. Fix the split finalizer wiring instead of adding a second domain hook at the store layer |
> | Phase-engine terminals bypass `boundFinalize` | **Wrong.** They use it. Only the worker-driven terminals (stall, wall-clock, reap, provision, apply) bypass it |
> | PAT repos excluded from both paths | **Wrong** |
> | GitHub automatically redelivers missed webhooks | **Wrong** |
> | "No code path can write `source='plugin'`" | **Literally false** — `createJob` writes it. Correct: no *production-reachable* path, because the host service is never registered |
> | The widened index is "mandatory today" for multi-instance | **Wrong.** The existing webhook-only index already makes the live path replica-safe. Cross-source protection matters only once a second source can write |
> | The boot invariant "protects `ctx.mcp` today" | **Overstated.** MCP's provider *is* wired. The invariant catches missing providers; it does not enforce caller identity |
> | "Never executed in production" | **Unverifiable from source.** What is proven is current unreachability |
>
> **And a process failure worth naming:** this document proposed resolutions and did not
> propagate them. `acceptance.md` and `implementation.md` still said "three dead
> capabilities" and still listed polling, comment-back and `ctx.devJobs` as things the
> extraction must preserve. Writing a decision doc without updating what it contradicts
> leaves the spec set worse than before. Propagated below.

---

## The five

| # | Capability | Evidence it never runs | Verdict |
|---|---|---|---|
| 1 | **Conductor `dev.job` step** | Executor constructed with no `devJob` dep, so the dispatch branch is always false; the reconciliation sweep is never scheduled | **ACTIVATE as its own PR — or delete.** Not as a side-effect of C5 |
| 2 | **`ctx.devJobs`** | `provide('devJobs', …)` exists nowhere in `src/` | **DELETE** |
| 3 | **Tracker polling** | `TrackerPoller` never constructed or started | **DEFER — move dormant** |
| 4 | **`TrackerRegistry`** | `registerTracker` has zero production callers; no tracker of any kind is registered | **DEFER — moves with #3** |
| 5 | **Comment-back** | `tracker/commentBack.ts` referenced only by its own test | **DEFER — moves with #3** |

#4 and #5 were found while designing #3. `acceptance.md` §2.5 listed comment-back as live with
the probe *"result posted to the issue"* — it is not wired, so a polled job's result never
reaches the issue and the loop is half-open even if the poller ran.

All five verified directly, not taken on report.

---

## 1. Conductor `dev.job` step — ACTIVATE as C5b, or delete

### The diagnosis was too optimistic by half

"The dependency isn't wired" suggests a two-line fix. It is not. **The launch half of the port
has no implementation at all:**

- `createConductorJob`, `setAwaitId`, `getAwaitId` exist only as interface members
- `dev_jobs.conductor_await_id` was added in migration `0024` and **`devJobStore.ts` never
  selects it and has no writer** — verified
- `DevJobOutcomeEmitter.emit()` is called by nobody in `src/`

So wiring the dep is two lines that produce a runtime crash. Real activation is **≈400–600 LOC**
plus store columns, an idempotent job-creation path, a step-input schema and a bundled template.

### There is zero evidence of demand

No bundled template references `dev.job`. No Designer reference. And it would **fail validation
anyway**: `listActions` does not contain `dev.job`, so any authored graph is rejected with
`unknown_action_ref`. **Nobody has ever been able to author this step.**

### Why it still might be worth it

It is the one thing Conductor cannot express today: a step that takes minutes, costs money, and
has a branchable outcome. Today a workflow can only fire-and-forget via the `dev_job_start` chat
tool — no parking, no branch on the PR result. The value is entirely the *await*, and that
machinery is ~90% written and carefully designed.

### Why it must NOT ride along inside C5

`implementation.md` C5 proposes re-registering core's dev-job through the new step-kind registry
"to prove the registry with a real consumer." **Re-registering something that still never
executes proves the registry compiles, not that it works.** The registry's hardest question —
what happens to a run parked on a step kind whose provider deactivates — is invisible unless
something actually parks.

So: **C5 = mechanism** (must ship regardless; P3 depends on it). **C5b = the live consumer**,
its own PR, between C5 and the C8 abandonment checkpoint, behind
`CONDUCTOR_DEV_JOB_STEP_ENABLED` defaulting **off**. If C5b is not staffed when C5 lands,
delete the whole thing rather than carry a never-executed capability across a repo boundary.

### A contradiction in our own plan, now resolved

`implementation.md` P3 says *"delete `devJobConductorBridge.ts` — dead code, don't carry it into
a published package."* C5 says core's dev-job re-registers through the registry. **Both cannot
hold.** Resolution: C5 registers the *kind*; C5b supplies the *implementation*; P3 moves it only
if C5b shipped, deletes it otherwise.

### What breaks on activation — verified

- **A dry run would spend real money.** `isDryRun` is consulted only in `finalizeIfEnded`, not
  in the step dispatcher — verified. `startRun({isDryRun:true})` would launch a real runner.
  C5b must branch on it *first*.
- **The obvious terminal hook misses the majority path.** `devJobWorker.ts` builds its own
  `finalizeDevJob` deps and bypasses the wiring's `boundFinalize`, so stall, wall-clock and
  phase-engine terminals would never emit. Hook `DevJobStore.finishTerminal` instead — it is
  brand-gated, so it is the true choke point.
- **Parked forever is the default failure.** Dev-job awaits carry `deadlineAt: null` and the run
  is `waiting`, so no deadline worker and no resume claim ever touch them. The *only* wakeups
  are the edge-triggered emit and the sweep. Scheduling the sweep is **mandatory**, not
  optional.
- **Run-cancel does not abort the job.** A live runner keeps burning budget for an abandoned
  run. Add `abort?(jobId)` to the port or document the leak.
- **Two-level park.** A dev job can itself park on a human gate — then the run waits on a job
  waiting on a human in a *different* inbox, with no path from one to the other.

---

## 2. `ctx.devJobs` — DELETE

### Zero consumers, and five dead layers

Searched this repo, `omadia-byte5-plugins` (six production private plugins), and 33 sibling
`omadia-*` repos: **zero `permissions.devJobs` declarations anywhere.** This is speculative API
built ahead of demand, and the demand never arrived.

It is not one missing wire but five: no provider, **no grant writer**
(`DevRepoPluginGrantStore` is never constructed — verified, so `dev_repo_plugin_grants` has no
writer at all), no grant API, no consent surface (`PermissionsBlock` does not render `dev_jobs`,
so an operator would see *nothing*), and no consumer. Plus two orphans nobody counted: migration
`0025` exists solely to admit `source = 'plugin'`, which no code path can write.

### The decisive finding: activating it would be a security regression

Every access gate lives in the *accessor*, and **every identity is a parameter the caller
passes** — `listGrantedRepoIds(pluginId)`, `cancelJob(jobId, requestedByPluginId)`,
`createdBy: {kind:'plugin', id}`. Verified. The host service itself verifies nothing.

Combined with B1 (`ctx.services.get` is an ungated pass-through), the moment **anyone** registers
`devJobs` — core today or the extracted plugin tomorrow — any installed plugin can call
`ctx.services.get('devJobs')` with **no manifest declaration and no operator consent**, pass an
arbitrary `pluginId`, and bypass the permission gate, the repo-grant scope, the creator check on
cancel, *and* the audit attribution — while framing another plugin.

**The current dead state is safer than the wired state.** "It throws on every call" is
load-bearing today.

This also sharpens `implementation.md` §2.2 by one notch: that section says *removing*
`ctx.devJobs` without replacing its gate opens the hole. True — but **adding the provider opens
it too.** `provide` is the dangerous operation, not `remove`. C2 bundles the gate fix with the
removal; that bundling is a **correctness requirement**, not a convenience.

### The test that passed while describing the bug

`pluginDevJobsAccessor.test.ts` has a case literally titled *"throws a clear error when the host
service is unregistered"* — it **asserts the production behaviour as the error path** and stays
green. Its fake registry is a two-line literal; no test in the repo ever boots a real
`ServiceRegistry` and asks whether anything provided `devJobs`.

**Ship the generalisation regardless of this decision:** a boot-level invariant that enumerates
every `permissions_summary` flag gating an accessor and asserts its backing service is either
resolvable or explicitly declared optional. That is what stops the *next* dead accessor, and it
protects `ctx.mcp` today.

### It collapses G8 almost entirely

All three G8 items exist only to serve this capability. Remove it and G8 has no independent
residue — and the "SemVer-major break for third-party plugins" framing downgrades to hygiene,
because there are no third-party consumers on disk in 34 repos.

**One correction to C2:** do not create `@omadia/dev-platform-plugin-api` in Phase A. Core code
that stays until P4 still needs these types. Move them to a local
`src/devplatform/devJobTypes.ts` that travels with the tree at P4. Standing up a package for a
non-existent third party is the same speculative generality we rejected for the LLM proxy.

**And the delete makes the survivor smaller:** `devJobsHostService.ts` has a real consumer (the
chat surface) and can shed every stub that consumer already fakes.

---

## 3–5. Tracker polling, registry, comment-back — DEFER, move dormant

### The stated gaps do not hold

The poller's own header says it is **not** a GitHub fallback — it drives *plugin* trackers
(Jira etc.). And **no tracker of any kind is registered**: `registerTracker` has zero production
callers, verified. It is a poller with nothing to poll.

Of the three candidate justifications, only one is real and it is empty in practice:

| Gap | Real? |
|---|---|
| Repos without a webhook | **No** — PAT repos are excluded from *both* paths |
| Missed deliveries | **Weakly** — GitHub redelivers, and deliveries are recorded with outcomes. A reconciliation backstop would be a different feature |
| Non-GitHub trackers | **Real in principle, zero in practice** |

### Activating in core is worse than throwaway

It would add config, registry construction and a schema column — all raising the ratchet count
the epic exists to drive to zero — and Phase B would delete every line.

### But one piece IS worth shipping now, and it is a real latent bug

**Cross-source dedupe.** `hasActiveTriggerJob` filters on `source`, and the unique index
`dev_jobs_webhook_one_active` is scoped `WHERE source = 'webhook'`. A repo with both triggers
enabled gets **two jobs for one labelled issue** — two runners, two LLM budgets, two PRs.
Latent only because no tracker job has ever been created.

Fix: widen the probe to a trigger *family* and replace the index with one covering both sources.
**Not safe as a drop-in:** it needs a preflight for existing active duplicates (the CREATE would
abort), a deterministic conflict policy, create-new-then-drop-old, and a snapshot test. It also
should land AFTER the migrator advisory-lock fix (B3) — shipping a migration citing
multi-replica risk while the migrator itself races is backwards. It hardens the **live**
webhook path against a future tracker and is the only artifact here that is not thrown away.

### Blockers that must land before it is ever switched on

- **Cold-start stampede.** With a NULL cursor, the first sweep creates a job for *every* open
  labelled ticket up to the page limit. At the default budget that is **$500 unattended from one repo-row PATCH** (100 tickets x $5 default budget). Fix: seed the cursor and create zero jobs on first poll, plus a
  max-jobs-per-sweep fuse.
- **It bypasses the webhook path's authorization entirely.** The webhook path requires a sender
  allowlist *and* a first-source human gate. The poller passes `requireGate: false` and consults
  no allowlist. On a public repo, anyone who can get the label applied gets an ungated agent run
  — polling is *less* authorized than webhooks for identical input.
- **It fires on any update, not on the label** — a comment on a still-labelled issue mints
  another job once the previous one goes terminal.

### Expiry

If no tracker plugin registers within the plugin's first release cycle, delete. Dead code with a
factory and a green test suite is cheap to keep and expensive to believe in.

---

## What ships now

| # | Change | Why now |
|---|---|---|
| 1 | Cross-source trigger dedupe + widened unique index | Real latent bug in the **live** webhook path; the only non-throwaway artifact |
| 2 | Boot-level accessor/provider invariant test | Generalises the whole finding; protects `ctx.mcp` today; independent of #470 |
| 3 | `acceptance.md` — mark all five dormant, add comment-back and tracker-registry rows | Stops the extraction certifying capabilities the operator never had |
| 4 | `implementation.md` — resolve the P3-vs-C5 contradiction; C2 keeps types local | Two implementers would otherwise build incompatible boundaries |

## Decisions for Marcel

1. **Is there a named first workflow for the conductor step?** If nobody can name it, take the
   delete — writing one bundled template is the cheapest possible demand test, and if that is not
   worth doing, activation is not either.
2. **Does any customer-side or unreleased plugin declare `permissions.devJobs`?** Zero on disk
   across 34 repos. This is the single fact that would invert the delete, and the only one not
   verifiable from here.
3. **Is a Jira/Linear tracker on the roadmap?** If no — delete #3–#5 now and stop paying
   attention tax. If yes, defer-and-move is right and the timeline sets the expiry date.
4. **Does middleware ever run more than one instance?** If yes, the widened index is mandatory
   *today*, independent of everything else here.
