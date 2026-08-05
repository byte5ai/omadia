# 0006 — In-context surfacing for background chat streams (no toasts)

## Status

Accepted

- **Date:** 2026-07-02
- **Deciders:** Operator-UI maintainers
- **Supersedes:** —

## Context and Problem Statement

The operator web UI runs chat turns per session and lets the user switch tabs
or menu routes while a turn is still streaming (the runner is headless). The
first Lume integration (#284) shipped `StreamToasts` — bottom-right floating
cards — to tell the user a background turn had progressed or finished. But the
Lume visual spec (`byte5ai/omadia-ui` `docs/visual-spec.md`) forbids toasts:
§7.4 makes the canvas the *surface of record* ("errors live in the tree, in
context") and §7.6 lists "toasts / floating notifications" as a ship-blocking
anti-pattern. #284 restyled the toasts in Lume material but deliberately left
the mechanism in place, deferring the architecture call to #286. How should
background-stream state reach the user without violating §7.6?

## Decision Drivers

- §7.6 anti-patterns are ship-blockers (spec §10); reintroducing them must not ship.
- §7.4 intent: state lives in context, on the surface of record — here, the chat.
- The needed data already exists per-session in `streamStore` (`phase`,
  `previewTail`, `error`); no new persistence should be required.
- §8 accessibility floor: colour is never the sole signal.

## Considered Options

- **A — In-context surfacing.** Remove `StreamToasts`; surface background-stream
  state on the session's chat tab (a dot) and keep errors inline in the turn.
- **B — Sanctioned deviation.** Keep the toasts; document that the operator UI
  is not the canvas renderer the spec primarily governs (§9 scope), so the
  §7.6 ban does not bind it.

## Decision Outcome

Chosen option: **A**, because it honours the spec's intent rather than carving
an exception, and it is cheap — `streamStore` already holds everything the tab
needs, so the change is a relocation of existing state, not new machinery.

### Consequences

- 🟢 **Good:** No §7.6 violation; the tab is the surface of record for its session.
- 🟢 **Good:** No new store surface, persistence, or notification centre —
  `useStreamRecord` + the existing `dismiss()` cover display and clear-on-select.
- 🟢 **Good:** Active-session errors already render inline on the message, so no
  new error UI was needed.
- 🔴 **Bad:** Stopping a *background* stream now takes one extra click — open the
  tab, then use the existing in-chat stop button. The toast's inline abort is gone.
- 🔴 **Bad, accepted:** Background-stream state is now visible **only on
  `/chat`**. `StreamToasts` was mounted in the root layout and therefore
  rendered on every route; the tab strip renders only from the chat page. A
  user sitting on `/admin` or `/store` while a background turn finishes or
  fails now sees nothing until they navigate back. This is the direct cost of
  making the tab the surface of record — a cross-route surface would be a
  notification centre, i.e. option B under another name. Accepted: the state
  is not lost, only deferred; `streamStore` keeps terminal records for 5
  minutes, so the marker is waiting on return.
- ⚪ **Neutral:** The screen-reader announcement follows the same scope. The
  removed overlay carried `aria-live="polite"`; that region now lives on the
  tab strip (`StreamAnnouncer`), so it announces exactly where a sighted user
  gets the visual marker and nowhere else — the two channels stay in step
  rather than one silently outliving the other.
- ⚪ **Neutral:** The unread dot clears on tab select only. Select forgets a
  `done` record; `error` / `aborted` / running records are kept — the
  agent_unavailable recovery banner and inline error read them off the store,
  and dropping a running record would flip `isActive` off (stop button,
  composer lock). An unresolved background error therefore re-flags its dot if
  the user views then leaves the tab again, which is intended.

## Pros and Cons of the Options

### A — In-context surfacing

- 🟢 Matches §7.4/§7.6; no exception to defend or re-litigate later.
- 🟢 Reuses existing state; small, reviewable diff.
- 🔴 A dot is quieter than a floating card — the user must glance at the tab strip.

### B — Sanctioned deviation

- 🟢 Zero code change; toasts already Lume-styled.
- 🔴 Leans on a scope loophole the issue author themselves argued against; erodes
  the anti-pattern list and invites the next deviation.

## More Information

- Issue #286; base Lume integration #284; adoption tracking #282.
- Lume visual spec §7.4 (Errors / surface of record), §7.6 (anti-pattern list),
  §8 (accessibility floor) — `byte5ai/omadia-ui` `docs/visual-spec.md`.
- Implementation: `web-ui/app/_components/ChatTabs.tsx` (tab marker +
  `StreamAnnouncer` live region), `web-ui/app/_lib/streamStore.tsx`
  (`dismissSeenTurns`), `web-ui/app/chat/page.tsx` (`handleSelect`
  clear-on-switch), `web-ui/app/layout.tsx` (toast mount removed).
- §8 compliance: the three marker states differ by *shape*, not hue —
  hollow accent ring (running), solid accent disc (done), hollow danger ring
  carrying a `!` glyph (error). Fill separates running from done so the
  distinction survives `prefers-reduced-motion` disabling the pulse; the glyph
  separates error from running. An `aria-label` alone does not satisfy §8.
