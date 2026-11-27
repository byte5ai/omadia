# 0242 — Routine runs and trigger firings are unattended turns

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (wave 5, W22-23)
- **Supersedes:** —

## Context and Problem Statement

A routine run or a trigger firing is a full agent turn that nobody reads while it runs.
The kernel ran it like a chat turn: it offered `ask_user_choice` (the web chat then dropped
the question, #1770), handed the model the routine's earlier runs as "recent turns" to be
trusted fully (#1771), and a smart-card "run now" inside a chat turn ran the routine with
the clicking turn's routines principal, so the run could create, pause and delete routines
(#1772). How does a turn know that nobody is there, and what changes for it?

## Decision Drivers

- ADR [0020](0020-proactive-agents-with-bounded-triggers.md): a trigger turn runs under the
  same rules as any turn, but nobody asked in it.
- ADR [0016](0016-least-privilege-and-the-agent-envelope.md): a scheduled run must not gain
  tools from whatever context started it.
- One flag the kernel sets, read by both tool loops; channel input can never set it.

## Considered Options

- **A — `ChatTurnInput.unattended`, set by the routine runner and the trigger executors**
- **B — let each caller filter tools and write its own hint**
- **C — reuse `freshCheck`**

## Decision Outcome

Chosen option: **A**.

- `ChatTurnInput.unattended` (`@omadia/channel-sdk`) marks a turn nobody attends. The routine
  runner (`routineRunner.ts`) and the trigger turn executor (`triggers/kernelExecutors.ts`)
  set it; nothing else does.
- An unattended turn **offers no interactive tool** (`ask_user_choice`,
  `suggest_follow_ups`; `toolsForTurn`, both tool loops), runs no card router, and gets the
  static `UNATTENDED_DIRECTIVE`: no questions, state an assumption and go on, fetch current
  data instead of relying on earlier runs.
- It **gets no "recent turns" context block** (#1771): earlier runs of the same routine or
  trigger are not facts of this one. Memory reads stay allowed (unlike `freshCheck`, which
  is the user's explicit "ignore memory" and says so in its prompt).
- A routine turn **runs outside any routines principal** (`routineTurnContext.outside`):
  started by cron, by the operator route or by a smart-card click inside a chat turn, it is
  never offered `manage_routine`.
- A routine run is told the current time in its zone (ADR
  [0240](0240-schedules-run-in-a-named-time-zone.md)); the turn context carries only the date.

### Consequences

- 🟢 **Good:** a run never asks a question nobody sees, and never manages routines.
- 🟢 **Good:** a run does not repeat or contradict its own last run from a trusted block.
- 🔴 **Bad:** on the subscription CLI the tool list is the CLI's; it gets the directive but
  `ask_user_choice` is still listed there (a call is answered and dropped, as before).
- ⚪ **Neutral:** a future unattended caller (a Conductor agent step) sets the same flag.

## Pros and Cons of the Options

### A — one flag

- 🟢 Both loops read it; one test pins the tool set.
- 🔴 A channel-sdk field (optional, additive).

### B — per caller

- 🟢 No contract change.
- 🔴 Two callers, two tool loops: four places to drift.

### C — `freshCheck`

- 🟢 Exists.
- 🔴 Its prompt says the user pressed a button and forbids memory reads; wrong for a run.

## More Information

Issues #1770, #1771, #1772.
