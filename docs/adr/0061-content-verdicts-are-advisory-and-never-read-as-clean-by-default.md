# 0061 — Risk verdicts on skills and plugin packages are advisory; a failed scan never reads as clean

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; skill import guard in #411 (epic #391), skill verdicts in
  #452 (issue #436), plugin package scanning in #477 (issue #453). Recorded retroactively.
- **Supersedes:** —

## Context and Problem Statement

Two kinds of third-party content enter an instance. An imported `SKILL.md` is text that
becomes part of an agent's instructions. A plugin ZIP is code that runs in the middleware
process ([ADR-0001](0001-plugin-distribution-via-signed-zip.md); packages are pinned by hash,
not signed by a publisher). Operators want a warning before they trust either. Scanners for
both exist, and both are heuristics: they miss things and they raise false alarms.

This record is retroactive. What authority does a scan result have, and what does a scan that
did not run mean?

## Decision Drivers

- A heuristic must not become a gate that blocks legitimate work, nor a seal that suggests
  safety.
- "Not scanned" and "scan failed" must never look like "nothing found".
- A model's opinion may raise an alarm, never lower one.
- A verdict belongs to exact content; changed content needs a new verdict.
- Scanning must not make install or import depend on another service being up.

## Considered Options

- **A — Advisory verdicts keyed by content hash and verifier version; layered verifiers where
  later layers only escalate; operational states ranked so they neither hide findings nor pass
  as clean; a human decides and may acknowledge**
- **B — Blocking gate** (refuse import or install above a severity)
- **C — No scanning; rely on operator review**

## Decision Outcome

Chosen option: **A**, with the same model for both content kinds.

**Skills**

- **Import brings text only** (`skillImport.ts`): the SKILL.md body and frontmatter, plus
  bundled resource files as data. Executable code never enters this way; that is the plugin
  path. Import is preview (`dryRun`) then confirm, and converges on a content hash
  (`computeSkillHash`: identical content is `unchanged`, changed content updates in place).
  Frontmatter lines the flat parser cannot represent are reported, not dropped silently.
- **Deterministic layer** (`skillGuard.ts`): bilingual regex patterns for
  `instruction_override`, `system_prompt_reference`, `tool_coercion`, `data_exfiltration`,
  `hidden_content`, `credential_harvest`, `silent_permission_escalation`. It is warn-only and
  never blocks. `computeVerdict`: no finding `no_signals`; one or two `flagged`; three or
  more, or any of the three severe codes, `high_risk`.
- **Model layer** (`skillVerdictLlmVerifier.ts`): started only by an explicit operator action
  (`POST …/skills/:id/verdict/llm-scan`), run in the background as an operator job
  (`SKILL_VERIFICATION`). `combineWithLlmSeverity` takes the worse of both: a model's
  `no_signals` cannot soften a deterministic finding. Bodies above 20,000 characters are
  `too_large_to_scan`.
- **Severity order**: `no_signals` < `pending` < `scan_failed` < `too_large_to_scan` <
  `flagged` < `high_risk`. An operational gap is visible above "nothing found" and stays below
  a real finding.
- **Failures carry codes, not vendor text.** A failed model scan stores
  `scan_failed:<code>` (`auth`, `rate_limit`, `overloaded`, `timeout`, `malformed_json` …) in
  `rationale`; the raw provider error, including request ids, is logged on the server only.
- **Acknowledgement** is recorded per `(content_hash, verifier_version)` with who and when; it
  does not carry over to changed content or to a new `CURRENT_VERIFIER_VERSION`. The
  description is part of the hash when it differs from the frontmatter (#1219), so editing it
  recomputes the verdict.

**Plugin packages**

- **Optional sidecar** (`pluginScanner.ts`, `middleware/sidecars/skillspector`,
  `docker-compose.skillspector.yaml`): NVIDIA SkillSpector in deterministic `--no-llm` mode,
  reachable only inside the compose network, pinned to an exact upstream commit. With
  `SKILLSPECTOR_URL` unset no scanner and no scheduler are wired and no verdict row is written.
- **After ingest, never inline** (`pluginVerdict.ts`): `scheduleScan` runs fire-and-forget
  after a successful ingest of any origin (upload, Hub, Builder); the verdict is cached by ZIP
  sha256 and `PLUGIN_SCANNER_VERSION` and shown on the store page.
- **Fail closed on the result, open on the install.** `scan()` never throws; a sidecar
  outage, a timeout, a non-zero exit, non-JSON output or an unrecognised report schema is
  `scan_failed`, never `no_signals`. The install is unaffected. A `lifecycle.entry` the
  scanner's walk would skip is rejected at upload (`package.entry_unscannable`).

### Consequences

- 🟢 **Good:** Operators see a warning where it helps and are never locked out by a false
  positive or a scanner outage.
- 🟢 **Good:** The UI can tell "clean", "not scanned", "could not scan" and "acknowledged"
  apart.
- 🔴 **Bad:** Nothing stops an operator from attaching a `high_risk` skill or keeping a
  flagged plugin; there is no policy for who may acknowledge, because omadia has one operator
  role (noted at the ack route in `routes/agentBuilder.ts`).
- 🔴 **Bad:** The plugin scan runs after the code is installed and possibly activated; it
  informs, it does not prevent.
- 🔴 **Bad:** The deterministic skill layer is regex over prose: easy to evade, noisy on
  security-related skills.
- ⚪ **Neutral:** One verifier version per deployed binary (`CURRENT_VERIFIER_VERSION`), not a
  shared setting; a rolling deploy can briefly hold verdicts of two versions.

## Pros and Cons of the Options

### A — Advisory, layered, escalate-only

- 🟢 Honest about heuristics; no new availability dependency.
- 🔴 Relies on the operator reading the badge.

### B — Blocking gate

- 🟢 Stops known-bad content.
- 🔴 False positives block work; a scanner outage blocks installs; a pass reads as a
  guarantee.

### C — No scanning

- 🟢 Nothing to maintain.
- 🔴 Prompt injection in imported skills goes unnoticed until it acts.

## More Information

- Related: [ADR-0001](0001-plugin-distribution-via-signed-zip.md),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md) (skill verification as operator
  job); [ADR-0068](0068-skills-are-scope-owned-with-a-signed-lifecycle.md). Border: plugin-runtime (ingest),
  agents (the Agent Builder serves the skill routes), auth-security (`docs/security-architecture.md`).
- Paths: `middleware/src/services/{skillGuard,skillImport,skillVerdict,skillVerdictLlmVerifier,pluginScanner,pluginVerdict}.ts`,
  `middleware/packages/harness-orchestrator/src/registry/skillHash.ts`,
  `middleware/sidecars/skillspector/`, `middleware/migrations/0007_skill_verdict.sql`,
  `middleware/src/routes/agentBuilder.ts` (skill routes).
- Tests: `middleware/test/{skillGuard,skillImport,skillHash,skillVerdict,skillVerdictLlmVerifier,skillVerdictLlmErrorLeak,skillVerdictAckReadPath,skillVerdictReadPathRedaction,skillDescriptionRescan,pluginScanner,pluginVerdict}.test.ts`.
