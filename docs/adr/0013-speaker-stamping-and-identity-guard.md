# 0013 — Speaker stamping, one typed emitter and a fail-closed identity guard

## Status

Accepted

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** —

## Context and Problem Statement

Today nothing prevents an agent from answering "as" another agent: no harness guard, no
prompt rule. The fact verifier checks claims against tool traces, not speakers, and is
off by default. User-visible output leaves the kernel on many paths (model loop, fast
path, deterministic actions, Conductor `say`, notices, errors), and not all of them know
who is speaking. Web chat shows no speaker per message.

How do we guarantee that every message names its real speaker and that no agent text
claims to be someone else, or to be human?

## Decision Drivers

- No model output may ever change who a message is from (INV-3, INV-4).
- Every output path must be covered, including streaming and deterministic paths.
- The guard must not depend on optional components (verifier mode, configuration).
- AI disclosure stays: agents are humanised transparently, never deceptively.

## Considered Options

- **A — Harness-stamped speaker, one typed emitter, mandatory identity guard**
- **B — Prompt rules plus the existing fact verifier**
- **C — Speaker stamping only, no textual guard**

## Decision Outcome

Chosen option: **A**.

- **Speaker.** `SemanticAnswer` carries
  `speaker: { kind: 'agent', agentId, slug, displayName, avatarUrl? } | { kind: 'system' }`,
  set from the routing decision, never from model output. Channels render it natively
  (own bot, chat UI name and avatar); the channel SDK's `speakerLine()` adds a plain name
  line only where the speaker would otherwise be unclear.
- **Single emitter, typed.** Every user-visible output goes through one emitter that
  stamps the speaker; a path that cannot name its speaker cannot emit. Each emission
  declares a type that decides its checks:

  | Type | Content | Checks |
  |---|---|---|
  | `prose` | model-generated text | identity guard (deterministic, then model layer on masked text) |
  | `template` | registered template with typed engine values | template id and value types, no model |
  | `data` | side-channel data ([ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md)) | discretion and audience only, never seen by a model |
  | `system` | management-layer notice | template rules, speaker `system` |

- **Identity guard (mandatory, fail-closed).** Independent of the fact verifier. Blocks
  claims to be human and claims to be or quote another agent outside a harness
  consultation reference; deterministic check against the directory of names and aliases
  first, model layer second. Streaming releases complete sentences only after each passes
  together with all text so far; a failure or timeout blocks the rest and appends an
  honest `system` notice.
- **Honest strength.** Structural attribution is guaranteed; textual claims are guarded,
  with coverage defined by tests. We do not call the guard a proof.

### Consequences

- 🟢 **Good:** Speaker is a structural fact available to every channel, audit and receipt.
- 🟢 **Good:** One emitter is the single place to enforce disclosure, discretion and
  decoration rules.
- 🔴 **Bad:** Sentence-wise release adds latency to streamed answers.
- 🔴 **Bad:** The model layer of the guard costs a model call per `prose` emission.
- ⚪ **Neutral:** Issues #2045 (speaker, emitter) and #2046 (identity guard); channel
  rendering in the channel repos ([ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md)).

## Pros and Cons of the Options

### A — Stamped speaker, typed emitter, guard

- 🟢 Structural guarantee plus a textual guard with defined coverage.
- 🔴 Every output path must be migrated onto the emitter.

### B — Prompt rules plus verifier

- 🟢 Cheap.
- 🔴 Prompts are not enforcement; the verifier is optional and checks facts, not speakers.

### C — Stamping only

- 🟢 Simple and deterministic.
- 🔴 An agent can still write "Mira says …" or "I am Anna from sales" in its own text.

## More Information

- Spec §3 INV-3, INV-4; §5.5; acceptance criteria 2, 5, 33, 34.
- Related: [ADR-0012](0012-agents-are-virtual-employees.md),
  [ADR-0018](0018-consultation-instead-of-delegation.md) (contributions are referenced, not quoted).
