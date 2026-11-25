# 0036 — Agent names are not personal data; a human's name vetoes the exemption

## Status

Accepted

- **Date:** 2026-11-24
- **Deciders:** Owner instruction for round G1 of epic #2042 ("Agent names of the roster are
  not personal data; they must stay clear in both A's and B's turns"); PRs #2190, #2193 and
  #2195, issues #2191 and #2192.

## Context and Problem Statement

The Privacy Shield masks detected person names before text reaches a model and restores them
in the answer. Agents are virtual employees with human-like names (ADR-0012), so the detector
tags them as persons.

Live on 2026-11-23, agent "Dark Clippy" kept apologising for having introduced itself as Dark
Clippy. The shield had masked its own name in its recalled context; the model saw "I am
<surrogate>" next to a system prompt saying Dark Clippy and "corrected" itself. The same
masking hid agent B's name from agent A in a consultation (#2192) and from background memory
jobs (#2191).

An exemption opens the opposite gap: agent "Karen" would let a mention of a colleague named
Karen reach the model in clear. Which names may stay clear, and who wins when an agent and a
person share one?

## Decision Drivers

- An agent must be able to name itself and its colleagues (ADR-0012, ADR-0018).
- Masking errs on the safe side: when in doubt, a person's name is masked.
- The exemption must be deterministic (ADR-0021) and fail safe when its inputs are unknown.

## Considered Options

- **A — Exempt the roster's agent names in every turn and job, exact match only, with a veto
  from the names of active users.**
- **B — Exempt only the speaking agent's own names in its own turn.**
- **C — Exempt agent names only in consultations.**

## Decision Outcome

Chosen option: **A**.

- **What is exempt.** Slugs, display names and identity names of every existing agent, enabled
  or not, published as kernel service `agentNames@1` (plugin-api 1.91.0). Deleted agents are not
  included, so their names are masked again. The speaking agent's own names (plus the platform
  assistant name when it signs with that) travel per turn as `ownNames`.
- **How it matches.** A detected span is exempt only when it equals a name exactly; case,
  surrounding quotes and trailing punctuation are ignored. Partial names and possessives stay
  masked. The operator deny-list always wins. Exempt names are not booked in the receipt.
- **Human veto.** `humanNames@1` is fed from the users table: `display_name` and each of its
  words, active users only. A name a human bears is never exempt; masking wins. Comparison uses
  the guard's normalisation.
- **Fail safe.** Before the first load, after a failed load or without the service, the
  snapshot is `null` and nothing is exempt. A turn reads the roster once, so a change in the
  middle of a turn cannot unmask a value it already masked.
- **Everywhere.** Every turn and every background job (`openStoredTextScope`) applies the
  same rule; jobs need no knowledge of which agent a text belongs to.

### Consequences

- 🟢 **Good:** Agents name themselves and each other correctly; consultations and memory jobs
  keep agent names as written, while humans in the same text stay masked.
- 🔴 **Bad (accepted residual):** A person without an omadia login (Odoo partner, customer,
  directory person) who bears an agent's name exactly is unmasked in every agent's turns and in
  the jobs. Documented in `docs/security-architecture.md` §6f.
- 🔴 **Bad:** Only active users veto; a disabled colleague's name is no longer protected by the
  veto.
- ⚪ **Neutral:** `humanNames@1` caches per process with `UserStore.onChange` invalidation and a
  5-minute TTL as the safety net across instances.

## Pros and Cons of the Options

### A — Roster names everywhere, human veto

- 🟢 One rule for turns and jobs; fixes self-naming, consultations and jobs together.
- 🔴 Widest exemption, so the namesake residual reaches every agent.

### B — Own names in own turn only

- 🟢 Narrowest exemption (#2190 as first step).
- 🔴 A consulted colleague's name and background jobs stay masked (#2191, #2192).

### C — Consultations only

- 🟢 Narrow.
- 🔴 Jobs would need to know which agent a text belongs to; inconsistent across paths.

## More Information

- Code: `middleware/src/platform/agentNamesService.ts`, `middleware/src/auth/humanNameDirectory.ts`,
  privacy-guard `ownNames.ts` (0.16.4).
- Tests: `privacyAgentOwnNames.test.ts`, `humanNamesFromUsers.test.ts`,
  `humanNamesRegistryWiring.test.ts`, `humanNamesFromUsers.pg.test.ts`.
- Related: ADR-0012, ADR-0018, ADR-0019.
