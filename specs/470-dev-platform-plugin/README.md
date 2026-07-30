# Epic #470 — Dev Platform → installable plugin in its own repository

Single source of truth for the extraction: the plan, the work-list, the acceptance
contract, and the automated guard. Implementation lands against these documents.

**Goal.** Turn the Dev Platform from a hard-wired core subsystem into an installable,
uninstallable plugin living in **its own repository** — its own backend, database schema,
configuration, UI and menu entries — until the `omadia` repository contains no reference to
it at all.

---

## The documents

| File | Answers | Read it when |
|---|---|---|
| **`plan.md`** | *What are we building, and why this way?* Architecture decisions, the capability gaps (G1–G10), the three hard couplings (H1–H3), phases P2a→P6, risks | Before touching anything |
| **`dormant-capabilities.md`** | *What happens to the five capabilities that never ran?* Per-capability verdict (activate / defer / delete) with the security finding that makes `ctx.devJobs` a delete | Before P2b |
| **`implementation.md`** | *In what order, and what did the detailed design change?* Six design passes synthesised: the five corrected decisions, six verified live bugs, the C1→C13 / P0→P6 PR sequence, and the six blocking decisions | Before starting a phase |
| **`core-decoupling-checklist.md`** | *What is still coupled?* 276 items across 18 zones, ~49,100 LOC / ~200 files, with `file:line` and DELETE / MOVE / GENERICISE per item | While doing the removal |
| **`acceptance.md`** | *Did every capability survive, and does it install?* 35 endpoints, 3 chat tools, 3 live background loops, 4 UI screens, CLI — each with a probe, plus FIVE capabilities marked unreachable. Plus install/uninstall/upgrade criteria | Before claiming a phase is done |
| **`plugin-tailwind-subset.probe.css`** | *Can a distributed plugin ship a UI without shipping CSS?* Measured reference artifact (7.7 KB gzip) — not built, not shipped | When implementing P3b |
| **`decoupling-baseline.json`** | The committed reference count the CI ratchet enforces | Never by hand — use `--update` |

---

## Status

### Done — merged via PR #536

- **Nav contribution API.** `ctx.uiRoutes.registerNav(...)`, `UiRouteCatalog.registerNav/listNav`,
  `GET /api/v1/ui/navigation` (session-gated, labels resolved server-side), and the
  static/dynamic merge in `Nav.tsx`. Dev Platform is its first consumer: its menu entry and
  `/admin` card now come from a registration, not a hardcoded literal.
- **Stale-plugin-route fix.** `ToolPluginRuntime.deactivate()` never disposed Express
  routers, so uninstalled plugins kept serving and shadowed later mounts. Disposal now also
  runs *before* the plugin-controlled `close()`, and `activate()` rolls back its own
  registrations when a plugin registers and then throws.
- **`appJwt` reverse dependency removed** → `middleware/src/services/githubAppJwt.ts`. Core's
  builder was importing out of the dev-platform tree, which made that tree a dependency of
  core and blocked extraction outright.

### In flight — this PR (#539)

- Tailwind-for-plugins (§4.3a) + the measured probe.
- The core-decoupling ratchet, the acceptance matrix, and the implementation plan.
- `dormant-capabilities.md` — five capabilities that never ran, each with a verdict.
- **Shipped code:** `ServiceRegistry` now disposes plugin-provided services on deactivate
  (owner-tracked, LIFO unwind, before the awaited `close()`), mirrored into both runtimes.

### Landed separately

- **PR #548** — path traversal in the plugin install pipeline. Unvalidated `identity.id`
  reached `path.join` and then a recursive `fs.rm`; reachable from remote registry ZIPs and
  imported profile bundles. Kept out of this PR so it does not wait on epic decisions.

### Held back after review

Two fixes were implemented, reviewed, and **not shipped** — the review caught real harm:

- **`.sql` in the ZIP allowlist** — would have escalated the #548 traversal from
  delete/replace to arbitrary SQL execution. Blocked until #548 lands.
- **Advisory lock on the 8 migrators** — an unbounded wait, but three migrators run inside a
  plugin `activate()` capped at 10s, so it would convert a rare race into a deterministic
  boot failure. Redesign needed (bounded wait); a second attempt also failed review because
  it never read `pg_advisory_unlock`'s return value.
- **DynamicAgentRuntime rollback** — the attempt left a zombie entry in `active`, and its
  by-source rollback tore down the winner's registrations under two concurrent activations
  of the same id.

### Next — decisions before code

Two are genuinely blocking and belong to the maintainer, not the implementer:

1. **H3 — the chat card.** `chat/page.tsx` hardcodes `tool.name === 'dev_job_start'` and
   renders a core-compiled React card. An iframe per tool call is not acceptable. Either a
   declarative card schema, or an accepted degradation to a plain `ToolRow` for
   out-of-repo plugins. This is the one place "no hardcoding" and "no downgrade" conflict.
2. **G7 fallback.** If fixing the plugin asset pipeline proves too costly, option E is an
   npm-published UI package that web-ui optionally installs — which weakens "no hardcoding"
   to "no source in core". Worth deciding deliberately rather than drifting into.

Then P3's extension points (H1 public paths + prefix ownership, H2 conductor step-kind
registry, G2/G3/G4), which everything else waits on.

---

## How we know it is complete

Three different jobs; none of them is sufficient alone.

```bash
node scripts/check-core-decoupling.mjs            # verify (CI runs this)
node scripts/check-core-decoupling.mjs --report   # per-zone breakdown
node scripts/check-core-decoupling.mjs --update   # lower the baseline
```

The ratchet counts Dev Platform references across 14 disjoint zones and **fails if the count
rises, per zone**. Baseline **3,220**. It only ever falls; raising it needs a hand-edited baseline, so
a new coupling shows up in review instead of slipping in.

That is what makes the checklist's staleness survivable — a file inventory goes stale on
contact, but the count does not, and it cannot reach zero while a reference survives.

But it counts IDENTIFIERS, NOT BEHAVIOUR: zero is a necessary condition for done, not a
sufficient one. Sections 2 and 3 of `acceptance.md` cover the rest, and neither is automated.

**The baseline rises when main legitimately adds dev-platform code.** That has happened three
times (PR #529, then #537's embedding work): the guard fires, the raise is hand-edited, and the
reason is recorded in the commit. A rise is only wrong when *core* re-acquires a dependency.

**Definition of done:** ratchet reads `0`, every row of `acceptance.md` §2 passes, and the
install/uninstall criteria in `acceptance.md` §3 pass.

---

## Working agreement for this PR

- **One commit per phase**, so a ~49k-LOC epic stays reviewable and revertible even though
  it lives in one PR.
- **Wire paths are frozen.** No phase may change `/api/v1/dev-runner`,
  `/api/v1/admin/dev-platform`, `/api/webhooks/github`, or `RUNNER_PROTOCOL_VERSION` —
  deployed runner images phone home to literal URLs and a rename bricks in-flight jobs with
  no compile-time signal.
- **Do not delete the `publicPaths` exemptions** until H1's mechanism is proven on the live
  runner path. Deleting them early 401s every phone-home.
- **Abandonment checkpoint:** after P3/P3b the platform capabilities stand alone and the
  Dev Platform can stay in core with no partial-move debt. Half-moved is the only genuinely
  bad end state.
