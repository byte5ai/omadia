# 0252 — Conductor templates map people at instantiation

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers, Wave 5 Conductor (#1718)
- **Extends:** [ADR-0132](0132-conductor-workflow-templates-are-slot-parameterized-data.md)

## Context and Problem Statement

Saving a workflow as a template copied user principals into the draft. Sharing that draft exposed the original principal and sent approvals from new workflows to that person.

## Decision Drivers

- Preserve workflows that address a named person.
- Keep slot substitution structural and resolve it before publish.

## Considered Options

- **A — Add a person slot for user principals**
- **B — Refuse to derive templates that target users**

## Decision Outcome

Chosen option **A**. `people` declarations map `slot:person:<key>` in `human.principal.ref` when the principal kind is `user`. Each distinct source principal gets a neutral key and label. The operator maps it to a routable principal when instantiating the template. The builder leaves person slots unfilled. Strict distributed manifests must slot concrete user references. Existing non-strict manifests can keep an intentionally pinned recipient.

Derivation suggests an unused slug based on the template's English name. It identifies action inputs containing HTTP(S) URLs by step ID, and the editor asks the author to confirm keeping them.

### Consequences

- A shared derived template requires a fresh choice of recipient.
- Portable templates can contain action input URLs after the author acknowledges them.

## More Information

`conductor-core/template.ts`, `templateRoutes.ts`, `TemplateInstantiateForm.tsx`.
