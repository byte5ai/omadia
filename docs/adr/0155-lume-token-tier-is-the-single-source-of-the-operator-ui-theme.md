# 0155 — Lume is the operator UI's design language; one token file carries the whole theme

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** Operator-UI maintainers (recorded retroactively from `docs/design.md` and
  `web-ui/app/_lib/theme.css`; first Lume integration #284, token bridge extracted in epic
  #470 C8)

## Context and Problem Statement

This record is retroactive: it documents a design that is implemented on main.

The operator UI started with an editorial look and its own colour names (`--paper`, `--ink`,
`--oxblood`). omadia's canvas app is built on Lume, a visual language specified in
`byte5ai/omadia-ui` (`docs/visual-spec.md`). ADR-0006 and ADR-0010 each apply a single Lume
rule (no toasts; icons and state glyphs) and both presuppose that the operator UI follows Lume
at all. That base decision was never written down. Which design language does the operator UI
speak, and where does its theme live so that a restyle does not become a sweep through every
component?

## Decision Drivers

- The operator UI and the canvas app share one identity.
- A palette or mode switch happens at runtime, per operator, without a rebuild.
- Components name roles, not colours.
- Plugin UIs must follow the same theme (see [ADR-0066](0066-plugin-ui-runs-in-a-same-origin-frame-with-a-fixed-style-vocabulary.md)).

## Considered Options

- **A — Adopt Lume; keep every token in one CSS file with three tiers; map it onto Tailwind
  through one shared bridge.**
- **B — Keep an own operator-UI look, separate from the canvas app.**
- **C — Adopt Lume through per-component styles or a component library theme.**

## Decision Outcome

Chosen option: **A**.

- **Lume is the language.** The spec is upstream (`byte5ai/omadia-ui`, visual spec v0.4 as
  named in `theme.css`); this repo implements it and does not redefine it. Four recipes carry
  it: surfaces as gradient pairs, one accent slot with glow sub-tokens, directional borders,
  soft corners.
- **One token file.** `web-ui/app/_lib/theme.css` is the CSS source of truth, in three tiers:
  PRIMITIVE (raw Lume tokens), SEMANTIC (role names such as `--bg`, `--fg`, `--accent`,
  `--border`, which components consume) and COMPAT (the earlier editorial aliases, remapped
  onto Lume so old component code keeps working). New code uses SEMANTIC names.
- **Three palettes, two modes, at runtime.** Petrol, Atelier and Lagoon bind to the single
  accent slot through `[data-palette]` on `<html>`; Lagoon is the default. Light and dark
  resolve through CSS `light-dark()` and `color-scheme`, forced with `[data-theme]`.
- **One Tailwind bridge.** `web-ui/app/_lib/tailwind-bridge.css` maps the tokens onto
  Tailwind's `--color-*`, `--font-*`, `--radius-*` and `--shadow-*` namespace with
  `@theme inline`, so utilities such as `bg-accent` follow the live palette. The shell and the
  generated plugin stylesheet both import this one file; a second copy is forbidden by its
  header.
- **A TypeScript mirror only where CSS variables do not reach.**
  `web-ui/app/_lib/design-tokens.ts` holds a static Lagoon-light snapshot for Cytoscape and
  chart canvases. Surfaces that must follow the live theme read the custom properties from
  `getComputedStyle` instead.

### Consequences

- 🟢 **Good:** A restyle is a change at the token tier (`docs/design.md`).
- 🟢 **Good:** Palette and mode switch without a rebuild, and plugin UIs follow.
- 🔴 **Bad:** The spec lives in another repository. A spec change reaches this UI only when
  someone carries it over, and this repo cannot test conformance against it.
- 🔴 **Bad:** The COMPAT tier keeps two vocabularies alive in component code.
- 🔴 **Bad:** `design-tokens.ts` is kept in sync by hand ("KEEP IN SYNC" in its header) and
  shows one palette only.
- ⚪ **Neutral:** Lume rules that forbid a pattern are recorded one by one where they bite:
  [ADR-0006](0006-in-context-background-stream-surfacing.md) (no toasts),
  [ADR-0010](0010-lume-icon-and-state-glyph-adoption.md) (icons, state as glyph).

## Pros and Cons of the Options

### A — Lume through one token file

- 🟢 One identity, one place to change, runtime theming.
- 🔴 Dependency on an upstream spec; compat aliases linger.

### B — Own look

- 🟢 No upstream dependency.
- 🔴 Two visual identities for one product.

### C — Per-component theming

- 🟢 No global token layer to design.
- 🔴 A palette change touches every component; plugin UIs could not share it.

## More Information

- Docs: `docs/design.md`.
- Code: `web-ui/app/_lib/theme.css`, `web-ui/app/_lib/tailwind-bridge.css`,
  `web-ui/app/_lib/design-tokens.ts`, `web-ui/app/globals.css`.
- Related: ADR-0006, ADR-0010, [ADR-0066](0066-plugin-ui-runs-in-a-same-origin-frame-with-a-fixed-style-vocabulary.md).
