# 0191 — Memory notes are restored on write and re-masked on read

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** maintainers (owner decision taken on the sweep's recommendation, reversible; #1841)
- **Supersedes:** —

## Context and Problem Statement

With `mask_user_prompt` on ([ADR-0095](0095-prompt-masking-wire-substitution-fail-closed.md)),
the model reads `PLATZHALTER-CUSTOM-1` where the user wrote "Projekt Falkenstein". The
`memory` tool is intern-exempt and its input was deliberately kept on the placeholders
(#1544), so notes were stored with them. A surrogate is unique within ONE turn only
(spec 001 FR-003, research C1): the next turn mints the same surrogate for whatever value it
meets first. A note about Falkenstein therefore read, in a later turn about "Projekt Zebra",
as a fact about Zebra, and the model answered with the wrong fact. How should notes written
under prompt masking keep their meaning across turns?

## Decision Drivers

- ADR-0095 "restore": what is persisted carries real values; the model only ever sees
  surrogates.
- FR-003: the real-to-surrogate map stays turn-scoped; no persistent cross-turn map.
- Fail closed: a value the shield cannot vouch for never reaches the model in clear, and a
  note is never read as a fact about a different value.
- Masking off (the default) must stay byte-identical.

## Considered Options

- **A — Restore on write, re-mask on read**
- **B — Turn-unique stored surrogates (a nonce per turn)**
- **C — Document the limit and refuse memory writes that carry surrogates**

## Decision Outcome

Chosen option: **A**, because it is the reading of ADR-0095 that also covers the `memory`
tool, keeps the map turn-scoped, and keeps notes useful.

With `mask_user_prompt` on, in every dispatch seam that runs `memory` (orchestrator,
`LocalSubAgent`, `ToolDispatchService`; `memoryNoteSurrogates.ts`):

- **Write.** Every string of the tool input (path, file text, `old_str`/`new_str`, …) is
  restored with the turn's full map (`restorePromptPseudonyms`) before the handler runs. If a
  surrogate of the turn is still present afterwards (a rewrite restore cannot map), or restore
  throws, the call is refused with a PII-free notice and nothing is stored.
- **Read.** Every `memory` result and the kernel's prefetched `/memories` index are masked
  through the READING turn's map (`maskUserPrompt`, origin `context`): a value the user named
  in this turn gets this turn's surrogate, another detected value a fresh one. A blocked or
  failing mask withholds the text (the index is then skipped).
- **Old notes.** A stored text that carries a surrogate the reading turn has minted (a note
  written before this change) is withheld with a notice telling the model to treat it as
  unknown, instead of being read as a fact about the wrong value.

With masking off nothing changes: the model saw the user's values and wrote them; reads only
get the #1544 echo re-mask, as before.

### Consequences

- 🟢 **Good:** A note means the same real value in every turn; the repro of #1841 answers
  "unknown" instead of the wrong department.
- 🟢 **Good:** Stored notes hold real values, like every other persisted text (ADR-0095).
- 🔴 **Bad:** Notes stored before this change with surrogates stay ambiguous. A surrogate of
  the `PLATZHALTER-*` or pool-address shape is caught once the reading turn has minted it;
  a pool person name the reading turn did not mint is not recognisable and reads as a name.
- 🔴 **Bad:** A note now holds real values, so on read it is only as masked as the reading
  turn's mask makes it. A value the writing turn masked but the reading turn's detectors miss
  (a C1 name found in the prompt context but not in the note text, or a reading turn that
  runs on C0 after a C1 outage, which ADR-0095 allows without blocking) reaches the model in
  clear. Before this change such a note held only surrogates. This is the same residual as
  recalled turns, which also store real values and are masked on read.
- 🔴 **Bad:** Each `memory` call costs one preview mask call and, on read, one mask pass (C1
  detector included when configured).
- ⚪ **Neutral:** Stored processes (`write_process`, `run_stored_process`) are also
  intern-exempt and keep the placeholders; they are not covered here.
- ⚪ **Neutral:** With masking off, surrogates the always-on tier puts into recalled context
  can still reach a note (residual, as before).

## Pros and Cons of the Options

### A — Restore on write, re-mask on read

- 🟢 Conforms to ADR-0095 and FR-003; notes stay readable.
- 🔴 Old notes need the fail-closed withhold; one extra mask pass per read.

### B — Turn-unique stored surrogates

- 🟢 No real value ever stored.
- 🔴 The model cannot resolve a nonce surrogate in a later turn, so a note about the asked
  term is useless; surrogate shapes change for every consumer.

### C — Document and refuse

- 🟢 Smallest change.
- 🔴 Memory stops working for any message that contained a masked value.

## More Information

- Issue #1841; related #1544 (tools get real values; `memory` was excluded on purpose).
- Code: `middleware/packages/harness-orchestrator/src/memoryNoteSurrogates.ts`;
  tests `middleware/test/orchestrator/memoryNoteSurrogates1841.test.ts`.
- `docs/security-architecture.md`, prompt masking: "Tools get the real values".
