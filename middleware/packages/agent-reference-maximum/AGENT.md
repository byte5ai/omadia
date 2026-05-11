---
quality:
  sycophancy: low
  boundaries:
    presets:
      - factual-only
      - no-speculation
      - no-reasoning-disclosure
    custom: []
---

# Agent: Reference (Builder Pattern Source)

This file is the Phase-1 pilot landing for the `quality:` frontmatter
block (Kemia integration). The structured manifest, runtime entry
point, permissions and tool list still live in `manifest.yaml`; this
AGENT.md only carries the per-profile response-quality settings until
the Phase 2.1+ frontmatter parser ingests this file as a unified
source of truth.

## Why `sycophancy: low`

This profile is a **reference codebase the Builder reads as a
pattern source**, not a user-facing assistant. The few times it does
answer a user prompt (smoke-tests, manual probes) the value is in
faithful echoing of repo facts — not in pushback or devil's-advocate
behaviour. Level `low` removes the most blatant flattery without
escalating to argumentative output that would distract from the
verbatim quoting the Builder relies on.

## Boundaries

- `factual-only`: never paraphrase code samples; quote them.
- `no-speculation`: do not guess at unimplemented APIs.
- `no-reasoning-disclosure`: tool plumbing (memory reads, graph
  lookups) stays out of the answer text.

The body is otherwise empty by design — the canonical agent
description lives in `manifest.yaml#identity.description`.
