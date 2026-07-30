# Dormant capabilities — activate, defer, or delete

Adversarial review of `acceptance.md` found capabilities the matrix listed as live that have
**never executed in production**. The count grew twice under scrutiny: three, then four, then
five. Each was designed as a proper feature; each stopped one wire short.

This document decides what happens to each — **before** the extraction, because deciding after
the move means paying a core release plus a plugin release for every answer.

The three verdicts are **not the same**, and that is the finding.

> ### Corrections from the verification pass
>
> A full check against the code found errors in the first draft of this document. The
> verdicts survive; several supporting arguments did not.
>
> | Claim | Correction |
> |---|---|
> | Cold-start costs "$150 unattended" | **$500.** Default budget is $5/job, page limit 100. I understated it by 3× |
> | "A dry run would spend real money" | **Overstated.** The supported route is `previewRun`, which explicitly stubs action steps. `startRun({isDryRun:true})` has no production caller. Still worth a defensive guard in C5b, but it is not a live exposure |
> | "Nobody has ever been able to author this step" | **Wrong.** Validation via `listActions` is bypassed on the raw `POST /` path. Zero demand may still hold; validation impossibility does not prove it |
> | "A poller with nothing to poll" | **Overstated.** `TrackerRegistry` has a built-in GitHub fallback needing no registration. `registerTracker` having no callers is true; "nothing to poll" is not |
> | Hook `DevJobStore.finishTerminal` for terminal events | **Wrong — contradicts our own contract.** `finalizeDevJob` is the documented choke point, and `core-decoupling-checklist.md` names it. Fix the split finalizer wiring instead of adding a second domain hook at the store layer |
> | Phase-engine terminals bypass `boundFinalize` | **Wrong.** They use it. Only the worker-driven terminals (stall, wall-clock, reap, provision, apply) bypass it |
> | PAT repos excluded from both paths | **Wrong** |
> | GitHub automatically redelivers missed webhooks | **Wrong** |
> | "No code path can write `source='plugin'`" | **Literally false** — `createJob` writes it. Correct: no *production-reachable* path, because the host service is never registered |
> | The widened index is "mandatory today" for multi-instance | **Wrong.** The existing webhook-only index already makes the live path replica-safe. Cross-source protection matters only once a second source can write |
> | The boot invariant "protects `ctx.mcp` today" | **Overstated.** MCP's provider *is* wired. The invariant catches missing providers; it does not enforce caller identity |
> | "Never executed in production" | **Unverifiable from source.** What is proven is current unreachability |
>
> **And a process failure worth naming:** this document proposed resolutions and did not
> propagate them. `acceptance.md` and `implementation.md` still said "three dead
> capabilities" and still listed polling, comment-back and `ctx.devJobs` as things the
> extraction must preserve. Writing a decision doc without updating what it contradicts
> leaves the spec set worse than before. Propagated below.

---

## The five

| # | Capability | Evidence it never runs | Verdict |
|---|---|---|---|
| 1 | **Conductor `dev.job` step** | Executor constructed with no `devJob` dep, so the dispatch branch is always false; the sweep is never scheduled | **DELETE** — 73 refs / ~600 LOC. Activating it is a NEW FEATURE, out of scope |
| 2 | **`ctx.devJobs`** | `provide('devJobs', …)` exists nowhere in `src/` | **DELETE** |
| 3 | **Tracker polling** | `TrackerPoller` never constructed or started | **DEFER-AND-HARDEN** — roadmap foundation; six fixes gate switch-on |
| 4 | **`TrackerRegistry`** | `registerTracker` has zero production callers | **DELETE** — the seam inverts, so there is nothing to move |
| 5 | **Comment-back** | `tracker/commentBack.ts` referenced only by its own test | **REWRITE at P3** against the tracker contract |

#4 and #5 were found while designing #3. `acceptance.md` §2.5 listed comment-back as live with
the probe *"result posted to the issue"* — it is not wired, so a polled job's result never
reaches the issue and the loop is half-open even if the poller ran.

All five verified directly, not taken on report.

---

## 1. Conductor `dev.job` step — DELETE (scope correction, 2026-07-30)

> **Marcel: "Der Conductor ist eine neue Funktion. Was hat das mit der Dev Platform zu tun?"**
> Correct, and it exposes a scope error in everything below this box.
>
> **Why the Conductor is in this epic at all:** not as a feature. Core's conductor currently
> holds **73 dev-platform references across 4 files** — `devJobStepEffect.ts` (122 LOC, entirely
> dev-job), 31 in `runExecutor.ts`, 6 in `awaitStore.ts` (incl. the `AND channel_type <>
> 'dev_job'` literal), 1 in `routes.ts`. They must go or the ratchet never reaches 0. *That* is
> the legitimate scope.
>
> **What I turned it into:** "build a generic long-running step-kind registry (H2/C5) and then
> activate the step (C5b)". That is a **new platform capability plus a new feature**, neither of
> which anyone asked for, and it propagated through the plan as a hard blocker.
>
> **The correct treatment.** There are two ways to remove a dev-platform reference from core:
> genericise it, or delete it. Genericising is only justified when something real needs the
> generic version. Here nothing does — the capability is dead, has no demand, no template, and
> no consumer. So: **delete the ~600 LOC**, all 73 references go with it, and:
>
> - **H2 collapses.** It stops being "design a step-kind registry" and becomes "delete dead code".
> - **C5 disappears** from the critical path. It was a hard blocker; it is now not required.
> - **C5b disappears.** It was always a new feature wearing an extraction costume.
> - The `await_kind` migration, the registry-deactivation-semantics question, the cross-kind
>   guard, the principal-ref namespacing — all of it goes away unbuilt.
>
> **If the `dev.job` step is ever genuinely wanted**, it is a new feature, built in the plugin
> repo, and *then* a generic registry is justified — designed against a real consumer instead of
> frozen as an interface that has never executed. That is strictly better than building it now.
>
> The analysis below is kept because it is the record of what activation would cost, should the
> question ever be reopened. **It is no longer the recommendation.**

### (Superseded) The activate-or-delete analysis

### The diagnosis was too optimistic by half

"The dependency isn't wired" suggests a two-line fix. It is not. **The launch half of the port
has no implementation at all:**

- `createConductorJob`, `setAwaitId`, `getAwaitId` exist only as interface members
- `dev_jobs.conductor_await_id` was added in migration `0024` and **`devJobStore.ts` never
  selects it and has no writer** — verified
- `DevJobOutcomeEmitter.emit()` is called by nobody in `src/`

So wiring the dep is two lines that produce a runtime crash. Real activation is **≈400–600 LOC**
plus store columns, an idempotent job-creation path, a step-input schema and a bundled template.

### There is zero evidence of demand

No bundled template references `dev.job`. No Designer reference. And it would **fail validation
anyway**: `listActions` does not contain `dev.job`, so any authored graph is rejected with
`unknown_action_ref`. **Nobody has ever been able to author this step.**

### Why it still might be worth it

It is the one thing Conductor cannot express today: a step that takes minutes, costs money, and
has a branchable outcome. Today a workflow can only fire-and-forget via the `dev_job_start` chat
tool — no parking, no branch on the PR result. The value is entirely the *await*, and that
machinery is ~90% written and carefully designed.

### Why it must NOT ride along inside C5

`implementation.md` C5 proposes re-registering core's dev-job through the new step-kind registry
"to prove the registry with a real consumer." **Re-registering something that still never
executes proves the registry compiles, not that it works.** The registry's hardest question —
what happens to a run parked on a step kind whose provider deactivates — is invisible unless
something actually parks.

So: **C5 = mechanism** (must ship regardless; P3 depends on it). **C5b = the live consumer**,
its own PR, between C5 and the C8 abandonment checkpoint, behind
`CONDUCTOR_DEV_JOB_STEP_ENABLED` defaulting **off**. If C5b is not staffed when C5 lands,
delete the whole thing rather than carry a never-executed capability across a repo boundary.

### A contradiction in our own plan, now resolved

`implementation.md` P3 says *"delete `devJobConductorBridge.ts` — dead code, don't carry it into
a published package."* C5 says core's dev-job re-registers through the registry. **Both cannot
hold.** Resolution: C5 registers the *kind*; C5b supplies the *implementation*; P3 moves it only
if C5b shipped, deletes it otherwise.

### What breaks on activation — verified

- **A dry run would spend real money.** `isDryRun` is consulted only in `finalizeIfEnded`, not
  in the step dispatcher — verified. `startRun({isDryRun:true})` would launch a real runner.
  C5b must branch on it *first*.
- **The obvious terminal hook misses the majority path.** `devJobWorker.ts` builds its own
  `finalizeDevJob` deps and bypasses the wiring's `boundFinalize`, so stall, wall-clock and
  phase-engine terminals would never emit. Hook `DevJobStore.finishTerminal` instead — it is
  brand-gated, so it is the true choke point.
- **Parked forever is the default failure.** Dev-job awaits carry `deadlineAt: null` and the run
  is `waiting`, so no deadline worker and no resume claim ever touch them. The *only* wakeups
  are the edge-triggered emit and the sweep. Scheduling the sweep is **mandatory**, not
  optional.
- **Run-cancel does not abort the job.** A live runner keeps burning budget for an abandoned
  run. Add `abort?(jobId)` to the port or document the leak.
- **Two-level park.** A dev job can itself park on a human gate — then the run waits on a job
  waiting on a human in a *different* inbox, with no path from one to the other.

---

## 2. `ctx.devJobs` — DELETE

### Zero consumers, and five dead layers

Searched this repo, `omadia-byte5-plugins` (six production private plugins), and 33 sibling
`omadia-*` repos: **zero `permissions.devJobs` declarations anywhere.** This is speculative API
built ahead of demand, and the demand never arrived.

It is not one missing wire but five: no provider, **no grant writer**
(`DevRepoPluginGrantStore` is never constructed — verified, so `dev_repo_plugin_grants` has no
writer at all), no grant API, no consent surface (`PermissionsBlock` does not render `dev_jobs`,
so an operator would see *nothing*), and no consumer. Plus two orphans nobody counted: migration
`0025` exists solely to admit `source = 'plugin'`, which no code path can write.

### The decisive finding: activating it would be a security regression

Every access gate lives in the *accessor*, and **every identity is a parameter the caller
passes** — `listGrantedRepoIds(pluginId)`, `cancelJob(jobId, requestedByPluginId)`,
`createdBy: {kind:'plugin', id}`. Verified. The host service itself verifies nothing.

Combined with B1 (`ctx.services.get` is an ungated pass-through), the moment **anyone** registers
`devJobs` — core today or the extracted plugin tomorrow — any installed plugin can call
`ctx.services.get('devJobs')` with **no manifest declaration and no operator consent**, pass an
arbitrary `pluginId`, and bypass the permission gate, the repo-grant scope, the creator check on
cancel, *and* the audit attribution — while framing another plugin.

**The current dead state is safer than the wired state.** "It throws on every call" is
load-bearing today.

This also sharpens `implementation.md` §2.2 by one notch: that section says *removing*
`ctx.devJobs` without replacing its gate opens the hole. True — but **adding the provider opens
it too.** `provide` is the dangerous operation, not `remove`. C2 bundles the gate fix with the
removal; that bundling is a **correctness requirement**, not a convenience.

### The test that passed while describing the bug

`pluginDevJobsAccessor.test.ts` has a case literally titled *"throws a clear error when the host
service is unregistered"* — it **asserts the production behaviour as the error path** and stays
green. Its fake registry is a two-line literal; no test in the repo ever boots a real
`ServiceRegistry` and asks whether anything provided `devJobs`.

**Ship the generalisation regardless of this decision:** a boot-level invariant that enumerates
every `permissions_summary` flag gating an accessor and asserts its backing service is either
resolvable or explicitly declared optional. That is what stops the *next* dead accessor, and it
protects `ctx.mcp` today.

### It collapses G8 almost entirely

All three G8 items exist only to serve this capability. Remove it and G8 has no independent
residue — and the "SemVer-major break for third-party plugins" framing downgrades to hygiene,
because there are no third-party consumers on disk in 34 repos.

**One correction to C2:** do not create `@omadia/dev-platform-plugin-api` in Phase A. Core code
that stays until P4 still needs these types. Move them to a local
`src/devplatform/devJobTypes.ts` that travels with the tree at P4. Standing up a package for a
non-existent third party is the same speculative generality we rejected for the LLM proxy.

**And the delete makes the survivor smaller:** `devJobsHostService.ts` has a real consumer (the
chat surface) and can shed every stub that consumer already fakes.

---

## 3–5. Tracker polling, registry, comment-back — DEFER, move dormant

### The stated gaps do not hold

The poller's own header says it is **not** a GitHub fallback — it drives *plugin* trackers
(Jira etc.). And **no tracker of any kind is registered**: `registerTracker` has zero production
callers, verified. It is a poller with nothing to poll.

Of the three candidate justifications, only one is real and it is empty in practice:

| Gap | Real? |
|---|---|
| Repos without a webhook | **No** — PAT repos are excluded from *both* paths |
| Missed deliveries | **Weakly** — GitHub redelivers, and deliveries are recorded with outcomes. A reconciliation backstop would be a different feature |
| Non-GitHub trackers | **Real in principle, zero in practice** |

### Activating in core is worse than throwaway

It would add config, registry construction and a schema column — all raising the ratchet count
the epic exists to drive to zero — and Phase B would delete every line.

### But one piece IS worth shipping now, and it is a real latent bug

**Cross-source dedupe.** `hasActiveTriggerJob` filters on `source`, and the unique index
`dev_jobs_webhook_one_active` is scoped `WHERE source = 'webhook'`. A repo with both triggers
enabled gets **two jobs for one labelled issue** — two runners, two LLM budgets, two PRs.
Latent only because no tracker job has ever been created.

Fix: widen the probe to a trigger *family* and replace the index with one covering both sources.
**Not safe as a drop-in:** it needs a preflight for existing active duplicates (the CREATE would
abort), a deterministic conflict policy, create-new-then-drop-old, and a snapshot test. It also
should land AFTER the migrator advisory-lock fix (B3) — shipping a migration citing
multi-replica risk while the migrator itself races is backwards. It hardens the **live**
webhook path against a future tracker and is the only artifact here that is not thrown away.

### Blockers that must land before it is ever switched on

- **Cold-start stampede.** With a NULL cursor, the first sweep creates a job for *every* open
  labelled ticket up to the page limit. At the default budget that is **$500 unattended from one repo-row PATCH** (100 tickets x $5 default budget). Fix: seed the cursor and create zero jobs on first poll, plus a
  max-jobs-per-sweep fuse.
- **It bypasses the webhook path's authorization entirely.** The webhook path requires a sender
  allowlist *and* a first-source human gate. The poller passes `requireGate: false` and consults
  no allowlist. On a public repo, anyone who can get the label applied gets an ungated agent run
  — polling is *less* authorized than webhooks for identical input.
- **It fires on any update, not on the label** — a comment on a still-labelled issue mints
  another job once the previous one goes terminal.

### Expiry

If no tracker plugin registers within the plugin's first release cycle, delete. Dead code with a
factory and a green test suite is cheap to keep and expensive to believe in.

---

## What ships now

| # | Change | Why now |
|---|---|---|
| 1 | Cross-source trigger dedupe + widened unique index | Real latent bug in the **live** webhook path; the only non-throwaway artifact |
| 2 | Boot-level accessor/provider invariant test | Generalises the whole finding; protects `ctx.mcp` today; independent of #470 |
| 3 | `acceptance.md` — mark all five dormant, add comment-back and tracker-registry rows | Stops the extraction certifying capabilities the operator never had |
| 4 | `implementation.md` — resolve the P3-vs-C5 contradiction; C2 keeps types local | Two implementers would otherwise build incompatible boundaries |

## Answered by Marcel — 2026-07-29

**Q: Does any customer-side or unreleased plugin declare `permissions.devJobs`?** → **No.**

`ctx.devJobs` **DELETE is confirmed.** There is no consumer anywhere — not in this repo, not
in `omadia-byte5-plugins`, not customer-side. The one fact that could have inverted the verdict
does not exist. Consequences: G8 collapses almost entirely (all three of its items exist only
to serve this capability), and the `@omadia/plugin-api` SemVer-major bump becomes hygiene
rather than a break with downstream cost.

**Q: Is a Jira/Linear tracker on the roadmap?** → **Yes, and it is considered important.**

This **changes the tracker verdict's meaning**, though not its direction. "Defer and move
dormant" stays right, but "and forget about it" was wrong: `TrackerRegistry` is not dead weight
being tolerated, it is the **extension point for a roadmap feature**. Three consequences:

1. **The blockers stop being hypothetical.** Cold-start ($500 ceiling), `requireGate: false`
   with no sender allowlist, firing on any ticket update rather than on label application, and
   the cross-source dedupe gap are now *must-fix before a Jira tracker ever runs* — not
   "things to note if anyone ever activates this".
2. **A new architectural question, in no document until now.** After extraction the registry
   lives in the dev-platform **plugin** repo. A Jira tracker would therefore be *a plugin
   registering into another plugin's registry* — cross-plugin extension. That seam has to be
   designed, and it constrains the extraction: it may argue for keeping a generic
   "job trigger source" extension point in **core** rather than moving the registry out.
3. **It inherits the B1 security hole.** A tracker registry is a *write* surface — registering
   a tracker influences which issues become code-execution jobs. With `ctx.services.get`
   ungated, any plugin could register one. The per-caller-factory fix in C2 is a prerequisite,
   not an optional hardening.

### The seam design — invert it

The obvious reading is "dev-platform provides `trackerRegistry@1`, the Jira plugin requires it
and registers into it." That fails on four counts, and the fix is to **turn the direction
around**:

- **Jira plugin = provider**: `provides: ["devTracker.jira@1"]`, `ctx.services.provide(...)`.
- **Dev-platform = consumer**: declares **no** tracker `requires`, resolves late —
  `ctx.services.get('devTracker.' + repo.trackerKind)` per repo per sweep.
- **`TrackerRegistry` is deleted, not moved.** Its plugin-map half becomes the `services.get`
  lookup; its GitHub-fallback half folds into dev-platform's own resolver.

Why the naive direction fails: it hands a **mutable registry** through an ungated accessor;
`registerTracker(kind, factory)` has no caller attribution (the identity is the key the caller
picks); `services.replace()` is an exposed MITM primitive; and the ABI is `DevRepo`-shaped —
a ~40-field internal type that moves to the plugin repo at P4, paired with a return type from
a core route file deleted at C10. Both sides of that signature cease to exist where a third
party can reach them.

Under the inversion the object crossing the seam is a **read-only, stateless service** — the
same risk class as `graphPool@1`, which this org already ships.

**And it is what makes C2's per-caller factory actually pay off.** The credential owner decides
who may use its credentials: `provide('devTracker.jira', (consumerId) => consumerId ===
'@omadia/dev-platform' ? impl : undefined)`. Applied to a shared registry instead, the factory
would gate *who may register* — the wrong question.

Capability names must carry the kind (`devTracker.jira@1`, not `devTracker@1`), or Jira and
Linear become mutually exclusive twice over: `provide` throws on duplicate, and the provider
index throws at boot.

### Three verified findings that change other decisions

1. **The hot-install path bypasses capability resolution entirely.** `index.ts` routes
   `case 'extension'` straight to `toolPluginRuntime.activate(agentId)` — no
   `resolveEligiblePlugins`, no topo-sort. Verified. So `requires`-based ordering only applies
   on the **boot** path; for the normal case (operator installs from the hub at runtime) it
   does nothing. **Any design leaning on activation ordering is already broken for that path**
   — which weakens several ordering arguments elsewhere in these documents, including the
   `ctx.devJobs` inversion discussion.
2. **`findDependents` checks `depends_on` only**, never capability `requires` — verified. So an
   operator can uninstall a capability provider with live consumers and get no 409. Small,
   independently valuable core fix.
3. **`source_ref` is `owner/name#N`** — verified. A Jira `PROJ-123` coerced to `123` collides
   with GitHub issue #123.

### Correction to "what ships now"

Finding 3 **inverts the ship order I recommended.** Widening the unique index to cover
`source IN ('webhook','tracker')` *before* namespacing `source_ref` would ship a false-**positive**
dedupe: a Jira ticket silently suppressing an unrelated GitHub issue. Namespace first
(`jira:PROJ-123`), widen second.

And the dedupe fix is **less load-bearing than I claimed.** `listPollableRepos` selects
`WHERE 'tracker' = ANY(allowed_triggers) AND (tracker_kind IS NOT NULL OR credential_kind =
'github_app')`. That `OR` is what drags webhook-covered GitHub repos into the poll set — the
sole source of the double-job risk. **Delete the built-in GitHub fallback and poll only repos
with a resolvable plugin tracker**, and no repo is ever both polled and webhooked for the same
ticket. The widened index drops from "the one thing worth shipping now" to defence-in-depth —
still worth having, since migration `0025`'s `source='plugin'` is a third potential writer.

### The verdicts change

- **Tracker polling: DEFER → DEFER-AND-HARDEN.** Move behind a flag, freeze the contract, keep
  an expiry (delete if the Jira plugin is not staffed by the plugin repo's second release).
  P3's exit condition becomes *"cannot be switched on without all six hardening fixes"*.
- **Comment-back: no longer "moves with #3"** — it is **rewritten** against the tracker contract
  at P3. Its transport becomes `comment(binding, ticketId, body)` on the provider interface;
  only the marker/idempotency logic survives.
- **`TrackerRegistry`: DEFER → DELETE.** Nothing to move once the seam is inverted, and that is
  what lets the ratchet legitimately reach 0 without an allowlist entry.

### The contract must be frozen before the poller is hardened

`Ticket` needs `ticketId: string` (opaque) + `displayKey`, `labels[]`, **`labelAppliedAt`**, and
`updatedSince` as a *provider parameter* rather than a client-side filter. Without
`labelAppliedAt` the "fires on any update" bug is unfixable at the consumer — so the interface
has to land first. Home: `middleware/src/devplatform/trackerContract.ts` in Phase A, travelling
with the tree at P4, exactly the treatment already agreed for `devJobTypes.ts`.

## Remaining decisions for Marcel

1. **Is there a named first workflow for the conductor step?** If nobody can name it, take the
   delete — writing one bundled template is the cheapest possible demand test, and if that is not
   worth doing, activation is not either.
2. **Does middleware ever run more than one instance?** Relevant to migration sequencing, though
   the widened index is NOT mandatory today — the existing webhook-only index already makes the
   live path replica-safe.
