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

### Wave 2 — shipped after #548 landed

- **`.sql` in the ZIP allowlist** — unblocked once the traversal fix merged. Also adds
  `migrations` to both boilerplate `build-zip.mjs` INCLUDE lists, without which the
  directory is silently dropped and the install succeeds with no schema.
- **Migrator concurrency** — shipped on the third attempt. Two prior designs were rejected:
  an unbounded `pg_advisory_lock` inside a 10s `activate()` budget, and a retry that never
  read `pg_advisory_unlock`'s return value.

### Still held back

- **DynamicAgentRuntime rollback** — two attempts rejected. The current one does not cover
  the timeout path: `withTimeout` does not cancel, so after the rollback the orphaned
  `activate()` keeps running and re-registers.

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
rises, per zone**. Baseline **3,300**. It only ever falls; raising it needs a hand-edited baseline, so
a new coupling shows up in review instead of slipping in.

That is what makes the checklist's staleness survivable — a file inventory goes stale on
contact, but the count does not, and it cannot reach zero while a reference survives.

But it counts IDENTIFIERS, NOT BEHAVIOUR: zero is a necessary condition for done, not a
sufficient one. Sections 2 and 3 of `acceptance.md` cover the rest, and neither is automated.

**The baseline rises for two reasons, and only two.** (1) main legitimately adds dev-platform
code. (2) A refactor concentrates coupling into a namespace whose own name matches the
pattern — C3 is the one instance: collapsing 41 flat config keys into `config.devPlatform`
added a mapping layer that names each key a second time (+48 in config.ts, +36 in the new
type file, against −33 in index.ts). The net is **+62** — `middleware/src` +29 and
`middleware/test` +33 — and it measured identically against three successive mains (before
#554, after #554, after #555), which is what shows it is C3's own concentration and not
drift picked up from elsewhere. The test half is the same effect — a shared
`devPlatformConfig.harness.ts` plus the moved routers' new `src/devplatform/routes/…` import
paths. **Every one of the 212 added matching lines in the test zone sits inside
`middleware/test/devplatform/`; none is outside it**, so no core test acquired a
dev-platform dependency. All of it deletes at extraction. Everything else is a
regression. That has happened three
times (PR #529, then #537's embedding work): the guard fires, the raise is hand-edited, and the
reason is recorded in the commit. A rise is only wrong when *core* re-acquires a dependency.

**C2b is a third kind of rise, and the smallest: +5, all documentation of a removal.**
`middleware/packages` 84 → 89, from the new `packages/plugin-api/CHANGELOG.md`. A changelog
recording that the `DevJob*` types were deleted has to name them, or a consumer grepping its
own source for `DevJobDescriptor` finds nothing and the record is worthless. Three of the five
lines are literal strings that cannot be reworded at all — a spec path, a test filename, and
the future package name `@omadia/dev-platform-plugin-api`; the other two are the removal
heading and the six type names, deliberately collapsed onto one line each. The count was
first +31: the example capability in the new gate tests and a `perCallerService` docblock both
used `devJobs` gratuitously, and both were reworded to a neutral name rather than excused —
`middleware/test` is back at its baseline of 1,030, unchanged. Nothing in core references the
dev platform as a result of this PR; the residue is prose *about* code that left.

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
