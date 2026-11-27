# 0237 — Builder publish reviews the generated manifest and reports activation

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** W21 cluster lead
- **Related:** [ADR-0014](0014-plugins-are-only-the-delivery-form.md), [ADR-0048](0048-one-ingest-pipeline-and-error-contract.md), [ADR-0058](0058-builder-drafts-owner-scoped-and-installed-through-the-upload-ingest.md), [ADR-0065](0065-plugin-self-extension-is-operator-gated-and-non-escalating.md)

## Context and Problem Statement

Builder publish can upload a new package or replace the package of an installed plugin. A publish dialog needs the permissions from the generated package and an accurate account of the activation outcome.

## Decision Outcome

The owner-scoped manifest review uses code generation for the draft and the matching installed version from the local catalog when available. It displays the package declarations, including permissions, and states when the installed manifest is unavailable. Generated external reads and UI routes are listed for the draft. The review is bound to the draft contents, installed version, and available installed manifest, and a later change requires a fresh review.

The publish endpoint uses the same ingest as ZIP upload. A downgrade requires an explicit confirmation of the plugin ID, current package version, and requested version. Ingest checks the pair inside its per-plugin swap lock. The lock coordinates concurrent uploads in the same process. If ingest stored the package but its activation failed, publish returns HTTP 422 with `builder.activation_failed` and leaves the draft's publish state intact. On success, `activated: true` confirms that ingest started the package. The Store is the entry point for first activation and explicit grants. Store detail advertises Builder editing only when the current operator has a source draft, and template proposals only when the plugin exposes templates.

## Considered Options

- Compare selected input fields in the browser and equate successful ingest with successful publish.
- Review the generated manifest and surface activation separately. Chosen to reflect the package the kernel receives and the package's runtime state.

## More Information

Issues #1732, #1784, #1785, #1794, #1796, and #1797.
