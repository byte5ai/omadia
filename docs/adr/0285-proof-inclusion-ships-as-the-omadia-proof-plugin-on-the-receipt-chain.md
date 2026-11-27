# 0285 — Proof inclusion (anp) ships as the omadia-proof plugin on top of the receipt chain

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers. Design record for #442 (wave 6, W36). Nothing is built
  with it; it waits for the owner's confirmation.

## Context and Problem Statement

#442 ("anp implementation: proof inclusion") was a placeholder with no agreed meaning. It
has since been scoped outside this repository: `byte5ai/anp` holds the protocol
specification ("an open, DLT-neutral trust layer for agent-to-agent contracting,
notarization, and dispute resolution"), and `byte5ai/omadia-proof` is the omadia plugin
meant to embed it. The plugin is at design stage; nothing runs. omadia main has no anp
code (`git grep -nIwE "anp|ANP"` finds nothing).

The closest kernel substrate exists: the tamper-evident receipt chain with signed
checkpoints and an external anchor ([ADR-0096](0096-tamper-evident-receipt-chain.md)).

The question: where does proof inclusion live, and what does the kernel owe it?

## Decision Drivers

- Plugins are the delivery form for capabilities; the kernel offers generic seams
  ([ADR-0014](0014-plugins-are-only-the-delivery-form.md)).
- The kernel's audit evidence must stay the kernel's: a plugin may read and attest it, not
  rewrite it (ADR-0096, [ADR-0100](0100-admin-audit-trail-one-actor-rule.md)).
- A proof sent to another organisation must not carry pre-masking content. No existing
  record covers content leaving the instance this way, so this record sets the rule below.
- Agent-to-agent work inside one instance is consultation
  ([ADR-0018](0018-consultation-instead-of-delegation.md)); anp is cross-organisation and
  outside that record.
- No kernel work before a concrete consumer names the hook it needs (precedent:
  [ADR-0063](0063-dev-platform-is-an-external-plugin-core-keeps-only-generic-extension-points.md)).

## Considered Options

- **A — Plugin first.** `omadia-proof` implements anp. The kernel adds generic, read-only
  seams only when the plugin's plan names them: a capability to read receipt-chain entries
  and checkpoints of the calling scope, and an event when a checkpoint is anchored.
- **B — Kernel subsystem.** anp identities, notarisation and inclusion proofs are built into
  the middleware next to the receipt chain.
- **C — Park.** Close #442 without a direction.

## Decision Outcome

Chosen option: **A** (recommended; owner confirmation pending).

- **#442 moves to `byte5ai/omadia-proof`.** After confirmation it is closed as "moved"; the
  plugin repository tracks the work.
- **Kernel seams follow the plugin's plan, not the other way round.** Each seam is its own
  omadia issue and, if it adds a contract, its own ADR. The expected first seam is a
  read-only `receiptChain@1` capability (entries, checkpoints, verification verdict of
  ADR-0096) scoped to what the caller may see.
- **The kernel never stores anp state.** Keys, DIDs, contracts and notarisation records are
  plugin state in the plugin's own database tables
  ([ADR-0255](0255-granted-graphpool-covers-only-the-plugins-own-tables.md)).
- **Outbound proofs pass the shield.** A proof leaves the instance only with masked content
  or hashes; raw turn text never does.
- **Cross-instance agent-to-agent traffic needs its own ADR.** If anp messages start turns
  in omadia, that is a channel (ADR-0014) and routing rules (ADR-0012) apply.

### Consequences

- 🟢 **Good:** No speculative kernel code; anp can evolve at its own pace.
- 🟢 **Good:** The receipt chain becomes the single anchor for "this happened" — internal
  verification and external proofs read the same data.
- 🔴 **Bad:** Proof features wait until the plugin's plan is concrete enough to name kernel
  seams.
- ⚪ **Neutral:** Follow-up: a kernel issue for `receiptChain@1` once omadia-proof needs it.

## Pros and Cons of the Options

### A — Plugin first

- 🟢 Matches ADR-0014 and the dev-platform precedent (ADR-0063).
- 🔴 Two repositories to coordinate.

### B — Kernel subsystem

- 🟢 Direct access to the receipt chain.
- 🔴 Large, cross-cutting, security-sensitive code for a protocol still in design.

### C — Park

- 🟢 No work.
- 🔴 Loses the link between the protocol work and its kernel anchor.

## More Information

- Issue: [#442](https://github.com/byte5ai/omadia/issues/442)
- Related: ADR-0096 (receipt chain), ADR-0014, ADR-0018, ADR-0063, ADR-0255.
- #584's transcripts are stored append-only and hashable per segment so a later proof can
  attest them ([ADR-0287](0287-audio-meeting-source-is-a-teams-plugin-joining-as-the-agents-tenant-user.md)).
