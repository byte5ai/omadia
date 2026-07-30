# Acceptance — is it all extracted, and does it install?

Two questions the other two documents do **not** answer:

- `core-decoupling-checklist.md` enumerates **files**. You can move all ~200 of them and
  still silently lose a feature — a file inventory cannot tell you a capability survived.
- `plan.md` states success criteria in prose. Prose is not a probe.

This file is the functional contract: every capability the Dev Platform provides today,
who owns it after extraction, and **how you check it still works**. Extraction is done when
every row passes *and* the decoupling ratchet reads zero.

---

## 1. What is automated today

| Guard | What it proves | Status |
|---|---|---|
| `scripts/check-core-decoupling.mjs` + CI job `core decoupling ratchet (#470)` | Core does not re-acquire Dev Platform references while the extraction is in flight | **In place.** Baseline **3,293** across **14** zones, per-zone regression check |
| `middleware/test/devplatform/**` (54 files) | The behaviour itself, at unit/integration level. These **move with the plugin** and must stay green in the new repo | In place, moves in P4 |
| §2 capability matrix below | Nothing is silently dropped in the move | **Written here; not yet automated** |
| §3 install/uninstall | The result is genuinely installable | **Not yet built** — needs P3/P4 |

Run the ratchet:

```bash
node scripts/check-core-decoupling.mjs            # verify (CI runs this)
node scripts/check-core-decoupling.mjs --report   # per-zone breakdown
node scripts/check-core-decoupling.mjs --update   # lower the baseline (never raises)
```

The count may only fall, **per zone** — an aggregate-only check would pass while one zone
fell and another rose, which is what a half-finished move looks like. Raising a baseline
requires hand-editing the committed file, so a new coupling shows up in review.

### What the ratchet does NOT prove — corrected after review

The earlier claim that "zero is a machine-checked definition of completion" was too strong.
Two flaws were found and fixed, and one limitation is inherent:

- **Fixed — a zone gap.** `middleware/.env.example` (19 references) was covered by no zone,
  so the count could have read 0 while it still documented `DEV_*` keys. Two more zones
  added; baseline moved 3,171 → 3,181.
- **Fixed — overlapping zones.** A root-config zone rescanned the whole `web-ui` tree and
  double-counted `web-ui/app`. Overlapping zones make the total meaningless; all zones are
  now depth-bounded and disjoint.
- **Inherent — it counts identifiers, not behaviour.** Zero means "core names nothing
  dev-platform-shaped". It does **not** mean the plugin works, that nothing was lost, or
  that a coupling expressed without a matching identifier is gone. §2 and §3 are what
  cover those, and neither is automated yet.

So: the ratchet is a necessary condition for done, not a sufficient one.

---

## 2. Capability matrix

> ### ⚠️ FIVE of these capabilities are UNREACHABLE IN PRODUCTION TODAY
>
> Found by adversarial review of this document, verified against the code. The matrix
> below was written from the *source*, and source presence is not production reality.
> **Decisions are made in `dormant-capabilities.md`** — this is the summary.
>
> | Capability | Why it never runs | Verdict |
> |---|---|---|
> | **Conductor `dev.job` step** | Executor built with no `devJob` dep; the launch half of the port has **no implementation at all** | **DELETE** — 73 refs / ~600 LOC. Wanting it back is a *new feature*, its own epic |
> | **`ctx.devJobs` plugin service** | `provide('devJobs', …)` exists nowhere in `src/`. Zero consumers on disk | **DELETE** — registering it would be a *security regression* while `services.get` is ungated |
> | **Tracker polling** | `TrackerPoller` never constructed or started | **DEFER-AND-HARDEN** — Jira/Linear is on the roadmap; six fixes gate switch-on |
> | **`TrackerRegistry`** | `registerTracker` has zero production callers | **DELETE** — the seam inverts (plugin provides, dev-platform consumes) |
> | **Comment-back** | `tracker/commentBack.ts` referenced only by its own test | **REWRITE at P3** against the tracker contract |
>
> **Do not "preserve" them.** Extraction acceptance that certifies these would be
> certifying capabilities the operator never had — which is exactly the failure this
> matrix exists to prevent, in the opposite direction.
>
> Note the count grew twice under scrutiny (three → four → five), and "never executed in
> production" is **unverifiable from source**; what is proven is current unreachability.
>
> This is the failure mode a file-level checklist cannot catch, and it is also one the
> capability matrix got wrong in the opposite direction: listing dead things as live.
> Every remaining row below needs a *production* probe, not a source reference.

**35 HTTP endpoints (36 concrete handlers), 3 chat tools, 1 plugin service, 3 live
background loops (+1 dead), 4 UI screens, 1 chat surface, 1 CLI, 1 conductor step kind.**
Every row must have an owner and a probe after extraction.

Corrected from "34 endpoints / 4 loops" after review. The miscount hid a real omission:
the LLM proxy has **two** handlers, and only one was listed — `GET /api/v1/dev-runner/llm/`
is a **liveness probe the CLI depends on**, and it was absent from the matrix entirely.
A missing capability is the dangerous direction; this is the one the matrix missed. `→` marks a capability whose *mechanism* has to exist in core first —
those are the H1/H2/H3 blockers from the checklist.

### 2.1 Operator REST — jobs (`/api/v1/admin/dev-platform`)

| Capability | Endpoint | Probe |
|---|---|---|
| List jobs, filtered | `GET /jobs` | `curl` returns the seeded job |
| Job detail | `GET /jobs/:id` | shape matches `DevJobDescriptor` |
| Start a job | `POST /jobs` | row lands in `dev_jobs`, status `queued` |
| Cancel | `POST /jobs/:id/cancel` | terminal status, runner torn down |
| Retry | `POST /jobs/:id/retry` | new job with `retry_of` set |
| Apply a diff | `POST /jobs/:id/apply` | diff policy still rejects a protected path |
| Artifacts list / fetch | `GET /jobs/:id/artifacts`, `GET /artifacts/:id` | sha256 matches |
| **Live job event tail** | `GET /jobs/:id/events` (SSE) | stream opens, replays from `Last-Event-ID`, closes on terminal |

### 2.2 Operator REST — repos & credentials

| Capability | Endpoint | Probe |
|---|---|---|
| CRUD repos | `GET/POST /repos`, `GET/PATCH/DELETE /repos/:id` | round-trip |
| Branch-protection re-check | `POST /repos/:id/check` | verdict rows render |
| List open issues | `GET /repos/:id/issues` | proxies the forge |
| GitHub device flow | `POST /github/connect/{start,poll}` | user code issued, token vaulted |
| Bind a GitHub App credential | `POST /repos/:repoId/credential` | credential kind flips to `github_app` |
| GitHub App manifest onboarding | `POST /github-app/manifest/start`, `GET /github-apps` | app row created |
| **App callback / setup** → | `GET /github-app/{callback,setup}` | **unauthenticated by design** — needs H1 |

### 2.3 Human gates

| Capability | Endpoint | Probe |
|---|---|---|
| Gate inbox | `GET /gates?status=waiting` | parked job appears |
| Approve / reject | `POST /gates/:gateId/resolve` | non-holder gets 403; holder resumes the job |
| Gate deadline sweep | background loop | an expired gate transitions without an operator |

### 2.4 Runner phone-home (`/api/v1/dev-runner`) →

**All seven need H1** — they authenticate with a `djr_` job token and no session, so they
depend on a plugin being able to declare a public path *and* own its prefix exclusively.

| Capability | Endpoint | Probe |
|---|---|---|
| Fetch job spec | `GET /jobs/:id/spec` | wrong token → 401 |
| Scoped SCM token | `GET /jobs/:id/scm-token` | short-lived, revoked on terminal |
| Stream events | `POST /jobs/:id/events` | appears in the SSE tail |
| Heartbeat | `POST /jobs/:id/heartbeat` | missed heartbeat reaps the job |
| Upload diff | `POST /jobs/:id/diff` | secret scan runs |
| Phase / final result | `POST /jobs/:id/{phase-result,result}` | phase engine advances |
| Daemon job policy | `GET /internal/job-policy/:jobId` | daemon token only; runner token rejected |
| **LLM proxy — liveness** | `GET /api/v1/dev-runner/llm/` | the CLI probes this before use; **was missing from this matrix** |
| **LLM proxy — messages** | `POST /api/v1/dev-runner/llm/v1/messages` | model allowlist + token cap enforced, usage accounted |

### 2.5 Triggers

| Capability | Surface | Probe |
|---|---|---|
| **GitHub webhook** → | `POST /api/webhooks/github` | **needs G3 raw body** — HMAC verifies, replayed delivery GUID dedupes, per-repo/sender rate limit holds |
| Issue-tracker polling | background loop | a labelled issue creates a job |
| Comment-back | forge client | result posted to the issue |

### 2.6 Chat & plugin surfaces

| Capability | Surface | Probe |
|---|---|---|
| `dev_job_start` / `dev_job_status` / `dev_job_list` | orchestrator native tools | tool call creates/reads a job |
| **`ctx.devJobs`** (create/get/list/listEvents) → | plugin service | **needs the G8 contract decision** — a third-party plugin still reaches dev jobs, scoped to granted repos |
| **Chat job card** → | `chat/page.tsx` | **needs H3** — either the rich card still renders, or the accepted `ToolRow` degradation is what ships |
| **Conductor `dev.job` step** → | workflow step kind | **needs H2** — a workflow parks on a dev job and resumes on its terminal outcome |

### 2.7 Operator UI

| Screen | Probe |
|---|---|
| Hub (`/admin/dev-platform`, tabs repos/jobs/apps/gates) | renders, deep-links per `?tab=` |
| Job detail + phase rail + live log | SSE drives the rail |
| Repo detail (budget, webhook, bind-app) | settings persist |
| Add-repo wizard (`/repos/new`) | device flow completes |
| Nav entry + admin card | **already dynamic** — contributed via `registerNav`, gone when inactive |

### 2.8 Operations

| Capability | Surface | Probe |
|---|---|---|
| Claim/lease/reap worker loop | background | a crashed job is re-adoptable |
| Retention sweep | cron `17 3 * * *` | aged events pruned, audit retained |
| Transcript / purge CLI | `scripts/dev-transcript.ts` | redaction applied |
| **Boot safety refusals** | `SUBSCRIPTION_MODE`+`ACK`, `UNSAFE_LOCAL`+`UID` | **must become activation refusals** — misconfiguration must still fail closed, not silently activate |

---

## 3. Install / uninstall acceptance

None of this is built yet. It is the definition of "installable" and belongs in P4.

**Not installed**
1. Middleware boots with no `DEV_*` config present.
2. `GET /api/v1/admin/dev-platform/jobs` → 404.
3. `GET /api/v1/ui/navigation` contains no dev-platform entry; `/admin` shows no card.
4. No `dev_*` table is required for boot.
5. `node scripts/check-core-decoupling.mjs` → **0**.

**Install**
6. Install from the plugin repo's artifact; setup fields render from the manifest.
7. Plugin runs its own migrations; the 9 tables appear.
8. Public-path grant is shown to the operator and consented to (H1).
9. Nav entry and admin card appear.
10. Every §2 row passes.

**Uninstall**
11. Routers stop answering — the fix in PR #536 makes this real, and its test pins it.
12. Nav entry and card disappear.
13. Background loops stop.
14. Public-path grant is revoked — `/api/v1/dev-runner` is no longer exempt.
15. **Data lifecycle decision required:** what happens to 9 tables of rows, to
    `dev_repo_plugin_grants` when a *granted* plugin is removed, and to jobs still
    `running` whose runner holds a valid token. Currently unanswered.

**Upgrade**
16. Reinstall a newer version with jobs in flight; no duplicate routes, no orphaned nav
    entry (both now covered by the disposal fix).

---

## 4. Honest gaps

1. **§2 is not automated.** It is a review checklist. The strongest cheap improvement is a
   smoke suite in the plugin repo that walks §2.1–§2.4 against a running stack; until then
   completeness depends on someone working the table.
2. **§3 does not exist yet.** Install/uninstall cannot be tested before P3 and P4.
3. **The inventory came from one sweep.** The ratchet compensates: even if a reference was
   missed here, it is counted there, and the count cannot reach zero while it survives.
4. **Cross-repo drift has no guard.** Once the plugin leaves, nothing in this repo verifies
   the plugin still satisfies §2 — that becomes the plugin repo's CI, against a published
   core contract.
