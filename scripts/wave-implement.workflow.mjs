/**
 * Wave implementation workflow (Claude Code "Workflow" tool script).
 *
 * Takes an approved unit manifest for one wave of a large epic and implements
 * every unit on its own branch inside an isolated git worktree, then runs a
 * cross-family adversarial review over each diff before the branch is considered
 * fit for a pull request.
 *
 * WHY A UNIT MANIFEST. A wave spec is prose. A unit is one acceptance criterion
 * plus the smallest coherent file-set that satisfies it, with `touches` globs,
 * `dependsOn` edges, and the test that proves it. Decomposition is extraction from
 * the spec, not invention -- see scripts/wave-decompose.workflow.mjs.
 *
 * WHY CROSS-FAMILY REVIEW. The implementer and a same-family reviewer share a
 * training corpus and therefore share blind spots. A reviewer trained on a different
 * corpus is the cheapest way to find what both of them would agree to overlook.
 * Forge (GPT-5.4 via codex) refutes; Cato audits security-sensitive units. Neither
 * fixes anything -- they report, and a rejected branch goes back to its implementer.
 *
 * WHY SEQUENTIAL FOR COLLIDING UNITS. Two units whose non-hub `touches` intersect,
 * run as parallel worktrees, produce branches that each rewrite the same file and
 * revert one another. Those units run in topological order on one branch, one agent,
 * one pull request. Hub files (index.ts, config.ts, messages/*.json) are append-only
 * registration points and are subtracted from the collision signal -- the manifest
 * assigns all hub edits to a single wiring unit that dependsOn everything else, so a
 * merge conflict becomes a dependency edge.
 *
 * The workflow NEVER writes to GitHub and NEVER pushes. It creates local branches and
 * returns metadata; pushing and opening pull requests is the caller's job, so the
 * remote-write surface stays a single auditable choke point downstream of the human's
 * approval. A branch whose review failed is reported, never proposed as a pull request.
 * Branch refs created inside an agent's worktree live in the shared ref store, so the
 * caller can push them after teardown.
 *
 * This is NOT a standalone Node script -- it runs inside the Claude Code Workflow tool
 * (agent()/parallel()/pipeline()/phase()/log() are provided by that runtime).
 *
 *   Workflow({ scriptPath: "scripts/wave-implement.workflow.mjs", args: {
 *     repo:       "byte5ai/omadia",
 *     repoPath:   "/abs/path/to/checkout",
 *     baseSha:    "<sha>",                  // every branch is cut from this
 *     baseBranch: "main",
 *     manifestPath: "docs/dev-platform/w0-manifest.json",
 *     manifest:   { wave, specUrl, verifyCommand, hubFiles, units: [...] },
 *     maxUnits:   12,                       // hard-clamped to 16
 *     onlyUnits:  ["w0-schema"],            // optional: implement a subset
 *     audit:      "auto"                    // auto | required | off
 *   }})
 *
 * ITERATION. A rejected branch is not a dead end -- the reviewer has written a precise,
 * code-grounded spec of what is missing. Put `resumeBranch` and `fixFindings` on the
 * unit and the workflow fixes up that branch instead of cutting a new one from base.
 * The fixup agent commits on top, never rebases and never force-pushes.
 *
 * SPEC DRIFT. The specs are grounded but not perfect. An agent that must deviate does
 * the code-correct thing, records a `specDeltas` entry naming the spec line and the code
 * evidence, and flags `needsHumanDecision` when the deviation is more than mechanical.
 * Reviewers are told that declared deltas are expected and that an UNDECLARED divergence
 * from the spec is a review failure. That is how the spec and the code converge instead
 * of quietly forking.
 */

export const meta = {
  name: 'wave-implement',
  description: 'Implement an approved wave-unit manifest in isolated worktrees with cross-family review',
  whenToUse: 'After wave-decompose produced a unit manifest and a human approved it. Never run without that approval.',
  phases: [
    { title: 'Implement', detail: 'one worktree-isolated coding agent per unit, topological order' },
    { title: 'Review', detail: 'cross-family Forge (GPT-5.4) refutation per diff' },
    { title: 'Audit', detail: 'Cato security audit for security-sensitive units' },
  ],
}

const MAX_UNITS = 16;
const MAX_FIX_ROUNDS = 2;

const input = typeof args === 'string' ? JSON.parse(args) : args;
const {
  repo,
  repoPath,
  baseSha,
  baseBranch = 'main',
  manifest,
  manifestPath = '(inline)',
  onlyUnits = null,
  audit = 'auto',
} = input ?? {};

if (!manifest?.units?.length) throw new Error('wave-implement: manifest.units is required');
if (!baseSha) throw new Error('wave-implement: baseSha is required');

const wave = manifest.wave ?? 'wave';
const verifyCommand = manifest.verifyCommand ?? 'npm run build';
const hubFiles = manifest.hubFiles ?? [];

// ---------------------------------------------------------------- schemas

const SPEC_DELTA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specRef', 'specSays', 'codeRequires', 'actionTaken', 'needsHumanDecision'],
  properties: {
    specRef: { type: 'string', description: 'Spec section or line the deviation departs from' },
    specSays: { type: 'string' },
    codeRequires: { type: 'string', description: 'What the actual codebase forces instead, with evidence' },
    actionTaken: { type: 'string' },
    needsHumanDecision: {
      type: 'boolean',
      description: 'false for mechanical fixes (a migration number bump); true for design changes',
    },
  },
};

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unitId', 'committed', 'verified', 'blocked', 'summary', 'specDeltas'],
  properties: {
    unitId: { type: 'string' },
    committed: { type: 'boolean' },
    verified: { type: 'boolean', description: 'true only if the verify command and the unit test both passed' },
    blocked: { type: 'boolean' },
    blockedReason: { type: 'string' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    verifyLog: { type: 'string', description: 'Tail of the actual command output. Never fabricate.' },
    specDeltas: { type: 'array', items: SPEC_DELTA_SCHEMA },
  },
};

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'file', 'issue'],
  properties: {
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
    file: { type: 'string' },
    line: { type: 'number' },
    issue: { type: 'string' },
    suggestion: { type: 'string' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prReady', 'scopeClean', 'acceptanceMet', 'summary', 'findings'],
  properties: {
    prReady: { type: 'boolean' },
    scopeClean: { type: 'boolean', description: 'false if the diff touches files outside the unit\'s `touches`' },
    acceptanceMet: { type: 'boolean', description: 'every acceptance criterion of the unit is demonstrably satisfied' },
    undeclaredDrift: { type: 'boolean', description: 'the diff departs from the spec without a matching specDelta' },
    summary: { type: 'string' },
    findings: { type: 'array', items: FINDING_SCHEMA },
  },
};

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prReady', 'summary', 'findings'],
  properties: {
    prReady: { type: 'boolean' },
    summary: { type: 'string' },
    findings: { type: 'array', items: FINDING_SCHEMA },
  },
};

// ---------------------------------------------------------------- helpers

/** Hub files are append-only registration points. Two units appending to index.ts
 *  are not coupled; leaving them in the collision signal makes every unit look
 *  dependent and collapses the fan-out. */
function nonHub(touches) {
  return (touches ?? []).filter((t) => !hubFiles.includes(t));
}

function collides(a, b) {
  const bs = new Set(nonHub(b.touches));
  return nonHub(a.touches).some((t) => bs.has(t));
}

/** Kahn over dependsOn, restricted to the units we are actually running. */
function topoSort(units) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const pending = new Set(units.map((u) => u.id));
  const out = [];
  while (pending.size) {
    const ready = [...pending].filter((id) =>
      (byId.get(id).dependsOn ?? []).every((d) => !pending.has(d)),
    );
    if (!ready.length) throw new Error(`wave-implement: dependency cycle among ${[...pending].join(', ')}`);
    ready.sort();
    for (const id of ready) {
      out.push(byId.get(id));
      pending.delete(id);
    }
  }
  return out;
}

function implementPrompt(unit, branch) {
  return [
    `Implement unit \`${unit.id}\` of wave ${wave} for epic #${manifest.epic ?? '?'} in ${repoPath}.`,
    ``,
    `## The spec`,
    `Read it in full before writing code: ${manifest.specUrl ?? manifestPath}`,
    `Use \`gh api repos/${repo}/issues/comments/<id>\` if it is a GitHub comment. Do not work from this prompt alone.`,
    ``,
    `## This unit`,
    `Title: ${unit.title}`,
    `Files it may touch: ${(unit.touches ?? []).join(', ')}`,
    `Test that proves it: ${unit.verifiedBy}`,
    unit.notes ? `Implementation notes from the spec author: ${unit.notes}` : '',
    ``,
    `## Acceptance criteria — all must hold`,
    ...(unit.acceptance ?? []).map((a) => `- ${a}`),
    ``,
    `## How to work`,
    `0. WORKSPACE SETUP — DO THIS FIRST. Your isolated worktree is cut from the repo's DEFAULT`,
    `   branch, which is usually the WRONG base for this unit. Run:`,
    `       git checkout -b ${branch} ${baseSha}`,
    `   (all refs are available — the worktree shares the repo's ref store). Then VERIFY the base:`,
    `       git merge-base --is-ancestor ${baseSha} HEAD   # must succeed`,
    `   and confirm the wave's existing code is present in your tree. If checkout or verification`,
    `   fails, STOP and return blocked with the evidence — never build on the default branch.`,
    `   A fresh worktree has no node_modules: run the workspace installs you need before the gate.`,
    `1. You are then on branch \`${branch}\`, cut from ${baseSha}.`,
    `2. Read the surrounding code first. Match its conventions, its error handling, its test style.`,
    `3. Write the code AND the test named in \`verifiedBy\`.`,
    `4. Run \`${verifyCommand}\` and the unit's test. Paste the real output tail into \`verifyLog\`.`,
    `   A branch that does not build never advances. Do not claim \`verified: true\` without output.`,
    `5. Commit with an English message. Never \`--force\`, never rebase, never push.`,
    ``,
    `## Spec drift`,
    `If the spec says X and the code requires Y, do Y and record a \`specDeltas\` entry with the`,
    `spec reference, the code evidence, and \`needsHumanDecision: true\` when the deviation is more`,
    `than mechanical. Silent divergence is a review failure. Undeclared drift will be caught.`,
    ``,
    `## Repo rules`,
    `Files under 500 lines. TypeScript ESM. No Co-Authored-By trailer. English commit messages.`,
    `Never commit secrets. Read AGENTS.md / CONTRIBUTING.md if present.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function fixupPrompt(unit, branch, findings) {
  return [
    `Branch \`${branch}\` (unit \`${unit.id}\`) was rejected in review. Fix it on the same branch.`,
    ``,
    `WORKSPACE SETUP FIRST: your isolated worktree is cut from the repo's default branch.`,
    `Run \`git checkout ${branch}\` (the ref is in the shared store) and verify you see the`,
    `branch's commits before touching anything. If checkout fails, STOP and return blocked.`,
    ``,
    `## Blocking findings — each is a precise spec of what is missing`,
    ...findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.issue}${f.suggestion ? ` (suggested: ${f.suggestion})` : ''}`),
    ``,
    `Commit on top. Never rebase, never force-push, never amend a pushed commit.`,
    `Re-run \`${verifyCommand}\` and ${unit.verifiedBy}; paste the real output into \`verifyLog\`.`,
    `If a finding is wrong, say so in \`summary\` with evidence rather than silently ignoring it.`,
  ].join('\n');
}

function reviewPrompt(impl, unit, branch) {
  return [
    `Review branch \`${branch}\` against ${baseBranch} (\`git diff ${baseSha}...${branch}\`) in ${repoPath}.`,
    `Read-only: do not check out, do not edit, do not commit.`,
    ``,
    `Assume the branch is NOT ready until the diff proves otherwise. Order your attention by blast radius:`,
    `1. Secrets or credentials in the diff, in logs, in tests, in fixtures.`,
    `2. Scope: files touched outside \`${(unit.touches ?? []).join(', ')}\` (hub files ${hubFiles.join(', ')} are off-limits to every unit except the wiring unit).`,
    `3. Forbidden paths: .github/**, Dockerfile*, lockfiles — none of these belong in this unit.`,
    `4. Correctness. For each defect, name a concrete failing input or state. A defect you cannot make fail is a hypothesis, not a finding.`,
    `5. Verify-log honesty: does \`verifyLog\` look like real command output, and does it correspond to the diff?`,
    `6. Acceptance: walk each criterion and say whether the diff demonstrably satisfies it.`,
    `   ${(unit.acceptance ?? []).map((a) => `- ${a}`).join('\n   ')}`,
    `7. Spec drift: the implementer declared ${impl.specDeltas?.length ?? 0} delta(s). Declared deltas are expected and fine.`,
    `   An UNDECLARED divergence from the spec is a finding — set \`undeclaredDrift: true\`.`,
    ``,
    `The implementer claims: ${impl.summary}`,
    `Declared deltas: ${JSON.stringify(impl.specDeltas ?? [])}`,
    ``,
    `Report only. Do not fix anything. \`prReady\` is false if any blocker or major finding stands.`,
  ].join('\n');
}

function auditPrompt(unit, branch) {
  return [
    `Security audit of branch \`${branch}\` (unit \`${unit.id}\`) in ${repoPath}. Read-only.`,
    ``,
    `This unit is security-sensitive. The epic's structural invariants — verify each against the diff:`,
    `- No git credential in any process env, in argv, or in .git/config. Credential files are mode 0600 and deleted.`,
    `- No \`git push\` anywhere in the runner path. The middleware applies the reviewed diff server-side.`,
    `- No \`--force\`. No token with merge or admin scope, ever.`,
    `- The runner token is stored only as a hash; comparison is timing-safe.`,
    `- Terminal transitions go through finalizeDevJob, not through the store directly.`,
    `- Untrusted input (ticket text, repo content) is framed as data and never used as authorization.`,
    `- Policy (env, egress allowlist, token scope) is derived server-side, never taken from a caller.`,
    ``,
    `Unit notes: ${unit.notes ?? '(none)'}`,
    ``,
    `Report only. A single confirmed violation of an invariant means \`prReady: false\`.`,
  ].join('\n');
}

// ---------------------------------------------------------------- the loop

async function runUnit(unit) {
  const branch = `feat/${wave.toLowerCase()}-${unit.id}`;
  // Implementers run as the DEFAULT workflow subagent. The custom personas repeatedly
  // finish long implementation runs without the StructuredOutput call (observed with
  // Engineer and Anvil; Anvil additionally lacks MOONSHOT_API_KEY on this machine), which
  // loses the unit report even when the code was committed. The default agent is reliable
  // here; cross-family diversity lives in the review (Forge) and audit (Cato) stages.
  const agentType = undefined;
  const prompt = unit.fixFindings?.length
    ? fixupPrompt(unit, unit.resumeBranch ?? branch, unit.fixFindings)
    : implementPrompt(unit, branch);

  let impl = null;
  try {
    impl = await agent(prompt, {
      label: `impl:${unit.id}`,
      phase: 'Implement',
      schema: IMPLEMENT_SCHEMA,
      isolation: 'worktree',
      agentType,
    });
  } catch (e) {
    log(`${unit.id}: implementer crashed (${String(e).slice(0, 120)}) — unit reported failed, pipeline continues`);
  }

  if (!impl || impl.blocked || !impl.committed) {
    log(`${unit.id}: no branch (${impl?.blockedReason ?? 'agent returned nothing'})`);
    return { unit: unit.id, branch, prReady: false, impl, review: null, audit: null };
  }

  // Forge is a different model family from the implementer. That is the entire point:
  // a same-family reviewer shares the implementer's blind spots.
  let review = null;
  try {
    review = await agent(reviewPrompt(impl, unit, branch), {
      label: `review:${unit.id}`,
      phase: 'Review',
      schema: REVIEW_SCHEMA,
      agentType: 'Forge',
      effort: 'high',
    });
  } catch (e) {
    log(`${unit.id}: Forge review crashed (${String(e).slice(0, 120)}) — retrying with default agent + codex CLI`);
    try {
      review = await agent(
        reviewPrompt(impl, unit, branch) +
          `\n\nRun the cross-family review through the codex CLI yourself: \`codex exec --cd <repo> -c model_reasoning_effort=high "<review question>" </dev/null\` and base your verdict on codex's findings plus your own reading of the diff.`,
        { label: `review-fallback:${unit.id}`, phase: 'Review', schema: REVIEW_SCHEMA, effort: 'high' },
      );
    } catch (e2) {
      log(`${unit.id}: review fallback also failed (${String(e2).slice(0, 120)}) — review missing, unit not pr-ready`);
    }
  }

  const reviewOk =
    Boolean(review?.prReady) && review.scopeClean && review.acceptanceMet && !review.undeclaredDrift && impl.verified;

  const wantsAudit = audit === 'required' || (audit === 'auto' && unit.securitySensitive);
  if (!reviewOk || !wantsAudit) {
    if (!reviewOk) log(`${unit.id}: review rejected — ${review?.summary ?? 'no verdict'}`);
    return { unit: unit.id, branch, prReady: reviewOk, impl, review, audit: null };
  }

  // Cato (codex-driven) sometimes ends its turn without the StructuredOutput call, which
  // would kill the whole pipeline. Catch that and fall back to the default workflow agent
  // running codex itself; if that also fails, the unit is NOT pr-ready (fail closed).
  let auditResult = null;
  try {
    auditResult = await agent(auditPrompt(unit, branch), {
      label: `audit:${unit.id}`,
      phase: 'Audit',
      schema: AUDIT_SCHEMA,
      agentType: 'Cato',
    });
  } catch (e) {
    log(`${unit.id}: Cato audit crashed (${String(e).slice(0, 120)}) — retrying with default agent + codex CLI`);
    try {
      auditResult = await agent(
        auditPrompt(unit, branch) +
          `\n\nRun the audit through the codex CLI yourself: \`codex exec --cd <repo> -c model_reasoning_effort=high "<audit question>" </dev/null\` (the trailing </dev/null matters — codex hangs on open stdin). Base your verdict on codex's findings plus your own reading of the diff.`,
        { label: `audit-fallback:${unit.id}`, phase: 'Audit', schema: AUDIT_SCHEMA },
      );
    } catch (e2) {
      log(`${unit.id}: audit fallback also failed (${String(e2).slice(0, 120)}) — failing closed`);
      auditResult = null;
    }
  }

  const prReady = reviewOk && Boolean(auditResult?.prReady);
  if (!prReady) log(`${unit.id}: security audit rejected — ${auditResult?.summary ?? 'no verdict'}`);
  return { unit: unit.id, branch, prReady, impl, review, audit: auditResult };
}

// ---------------------------------------------------------------- main

const selected = manifest.units
  .filter((u) => !onlyUnits || onlyUnits.includes(u.id))
  .slice(0, Math.min(MAX_UNITS, input.maxUnits ?? MAX_UNITS));

const selectedIds = new Set(selected.map((u) => u.id));

// A unit is sequential if it has a dependsOn edge inside this run, or if its non-hub
// touches intersect another selected unit's. Everything else fans out.
const sequential = selected.filter(
  (u) =>
    (u.dependsOn ?? []).some((d) => selectedIds.has(d)) ||
    selected.some((v) => v.id !== u.id && collides(u, v)),
);
const seqIds = new Set(sequential.map((u) => u.id));
const parallelUnits = selected.filter((u) => !seqIds.has(u.id));

log(`${wave}: ${selected.length} unit(s) — ${parallelUnits.length} parallel, ${sequential.length} sequential`);
if (parallelUnits.length) log(`parallel: ${parallelUnits.map((u) => u.id).join(', ')}`);
if (sequential.length) log(`sequential: ${topoSort(sequential).map((u) => u.id).join(' -> ')}`);

phase('Implement');

// pipeline(): no barrier. An independent unit can be under Forge review while another
// is still being implemented. A barrier here would waste the fast units' wall clock.
const parallelResults = parallelUnits.length ? await pipeline(parallelUnits, (u) => runUnit(u)) : [];

// Sequential units share files or depend on one another. Order matters; they run one
// at a time so the second does not revert the first.
const seqResults = [];
for (const unit of topoSort(sequential)) {
  seqResults.push(await runUnit(unit));
}

const results = [...parallelResults, ...seqResults].filter(Boolean);
const ready = results.filter((r) => r.prReady);
const blocked = results.filter((r) => !r.prReady);
const deltas = results.flatMap((r) => (r.impl?.specDeltas ?? []).map((d) => ({ unit: r.unit, ...d })));
const needsDecision = deltas.filter((d) => d.needsHumanDecision);

log(`${wave}: ${ready.length} branch(es) ready, ${blocked.length} blocked, ${deltas.length} spec delta(s)`);
if (needsDecision.length) log(`${needsDecision.length} spec delta(s) need a human decision`);

// The caller pushes, opens the pull requests, and posts the spec deltas to the epic.
// This workflow deliberately writes nothing to GitHub.
return {
  wave,
  baseSha,
  baseBranch,
  specUrl: manifest.specUrl,
  results,
  readyBranches: ready.map((r) => ({ unit: r.unit, branch: r.branch, summary: r.impl.summary })),
  blockedUnits: blocked.map((r) => ({
    unit: r.unit,
    branch: r.branch,
    findings: [...(r.review?.findings ?? []), ...(r.audit?.findings ?? [])].filter(
      (f) => f.severity !== 'minor',
    ),
  })),
  specDeltas: deltas,
  maxFixRounds: MAX_FIX_ROUNDS,
};
