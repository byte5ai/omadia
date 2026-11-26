# 0239 — Builder generates bilingual setup text while preserving draft values

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** W21 cluster lead
- **Related:** [ADR-0054](0054-setup-fields-typed-secrets-in-per-plugin-vault-validated-server-side.md), [ADR-0064](0064-plugin-builder-spec-and-slots-into-boilerplate-templates.md), [ADR-0159](0159-web-ui-i18n-plain-json-catalogs-and-ratchets.md)

## Context and Problem Statement

The Setup Store expects bilingual labels, help, and enum labels. Builder drafts historically stored one string for each label and help text, and they used the enum value as the label.

## Decision Outcome

A Builder setup field may specify `label_localized` and `help_localized` as nonempty English and German strings. `enum_labels` maps a value in `enum_values` to the same bilingual shape. Existing drafts and integrations can still send strings. Codegen emits the bilingual manifest shape in either case and copies existing single-language text to both entries when a translation was never supplied. Missing labels derive from the field key or enum value. The Builder prompt authors translations for new fields. Stored keys, option values, and secrets retain their existing handling.

The setup editor edits the field text in the current UI locale and preserves
an existing translation in the other locale. The workspace confirms text on
blur. Its spec PATCH optionally carries the last-read setup array to detect a
concurrent edit. The server guards the update using the specification read
for that request, and the client may reload and retry against the new state.

## Considered Options

- Require bilingual draft values before building. This would break older drafts at their next build.
- Extend the draft additively and keep a deterministic fallback. Chosen to make bilingual publication available without requiring a migration or model call.

## More Information

Issues #1798 and #1427.
