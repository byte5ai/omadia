/**
 * Wave verification workflow (Claude Code "Workflow" tool script).
 *
 * Proves a wave is done. Runs after the wave's branches are merged: it walks the
 * wave's acceptance-criteria checklist against the merged tree, then has an
 * independent cross-vendor auditor re-check the epic's security invariants.
 *
 * Two phases, and the second one matters more than the first. Checking a criterion
 * is easy to do optimistically -- an agent that wrote the code will find reasons why
 * it passes. So the check and the adversarial verification are separate agents from
 * different model families, and a criterion is only `pass` when both agree. This is
 * the same check-then-adversarially-verify shape as issue-triage's checklist mode.
 *
 * Green unit tests do not prove a wave. The end-to-end criteria (a real repo, a real
 * issue, a real pull request) cannot be faked by a test suite, so they are reported
 * as `manual` with the exact command to run rather than silently marked pass.
 *
 * The workflow NEVER writes to GitHub. It returns a per-criterion table; the caller
 * shows it to a human, who greenlights the next wave.
 *
 *   Workflow({ scriptPath: "scripts/wave-verify.workflow.mjs", args: {
 *     repoPath:     "/abs/path/to/checkout",
 *     manifest:     { wave, specUrl, verifyCommand, units: [...] },
 *     mergedSha:    "<sha>",              // the tree to verify
 *     runCommands:  true                  // false = static review only, no test execution
 *   }})
 */

const input = typeof args === 'string' ? JSON.parse(args) : args;
const { repoPath, manifest, mergedSha, runCommands = true } = input ?? {};

if (!manifest?.units?.length) throw new Error('wave-verify: manifest.units is required');

const wave = manifest.wave ?? 'wave';
const verifyCommand = manifest.verifyCommand ?? 'npm run build';

const CRITERION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unitId', 'criterion', 'verdict', 'evidence'],
  properties: {
    unitId: { type: 'string' },
    criterion: { type: 'string' },
    verdict: {
      type: 'string',
      enum: ['pass', 'fail', 'manual', 'unverifiable'],
      description: 'manual = needs a human to run it (end-to-end, UI). unverifiable = the criterion is not testable as written.',
    },
    evidence: { type: 'string', description: 'The command output, file:line, or reason. Never assert without one.' },
  },
};

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria', 'buildPassed', 'testsPassed'],
  properties: {
    buildPassed: { type: 'boolean' },
    testsPassed: { type: 'boolean' },
    commandLog: { type: 'string' },
    criteria: { type: 'array', items: CRITERION_SCHEMA },
  },
};

const REFUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overturned', 'summary'],
  properties: {
    overturned: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unitId', 'criterion', 'why'],
        properties: { unitId: { type: 'string' }, criterion: { type: 'string' }, why: { type: 'string' } },
      },
      description: 'Criteria the checker called pass that do not actually hold.',
    },
    summary: { type: 'string' },
  },
};

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['invariantsHold', 'summary', 'violations'],
  properties: {
    invariantsHold: { type: 'boolean' },
    summary: { type: 'string' },
    violations: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['invariant', 'file', 'detail'],
            properties: { invariant: { type: 'string' }, file: { type: 'string' }, detail: { type: 'string' } },
          },
        },
      },
    },
  },
};

const allCriteria = manifest.units.flatMap((u) =>
  (u.acceptance ?? []).map((c) => ({ unitId: u.id, criterion: c })),
);

log(`${wave}: verifying ${allCriteria.length} acceptance criteria across ${manifest.units.length} units`);

phase('Check');

const check = await agent(
  [
    `Verify wave ${wave} of epic #${manifest.epic ?? '?'} against the merged tree at ${mergedSha ?? 'HEAD'} in ${repoPath}.`,
    ``,
    `Spec: ${manifest.specUrl ?? '(inline manifest)'}`,
    ``,
    runCommands
      ? `First run \`${verifyCommand}\`. Paste the real output tail into \`commandLog\`. If it fails, say so — a failing build makes every criterion moot.`
      : `Do NOT run commands. Verify statically, by reading code and tests.`,
    ``,
    `Then walk EVERY criterion below. For each, give a verdict and the evidence that supports it:`,
    `- \`pass\` requires evidence: a command output line, or a file:line where the behavior is implemented AND a test that exercises it.`,
    `- \`manual\` for anything needing a human (an end-to-end run against a real repo, a real UI check). Name the exact command.`,
    `- \`unverifiable\` if the criterion as written cannot be checked. Say why; that is a spec defect worth reporting.`,
    `- \`fail\` otherwise.`,
    ``,
    `Do not mark a criterion \`pass\` because the code looks like it would work. An untested`,
    `implementation is not a passing criterion.`,
    ``,
    `## Criteria`,
    ...allCriteria.map((c) => `- [${c.unitId}] ${c.criterion}`),
  ].join('\n'),
  { label: `check:${wave}`, phase: 'Check', schema: CHECK_SCHEMA, effort: 'high' },
);

const claimedPass = (check?.criteria ?? []).filter((c) => c.verdict === 'pass');
log(`checker: ${claimedPass.length} pass, ${(check?.criteria ?? []).length - claimedPass.length} not-pass`);

phase('Verify');

// Two independent adversaries, run concurrently. The refuter attacks the checker's
// optimism; the auditor ignores the checklist entirely and goes after the epic's
// structural security invariants, which no acceptance criterion fully captures.
const [refute, securityAudit] = await parallel([
  () =>
    agent(
      [
        `A previous agent verified wave ${wave} in ${repoPath} and marked these criteria as PASSING.`,
        `Your job is to refute. Assume each is wrong until the code proves otherwise.`,
        `Read-only. Do not fix anything.`,
        ``,
        ...claimedPass.map((c) => `- [${c.unitId}] ${c.criterion}\n  claimed evidence: ${c.evidence}`),
        ``,
        `For each: does the cited evidence actually establish the criterion? Is the test real, does it`,
        `assert what it claims, and would it fail if the behavior were removed? A test that passes`,
        `whether or not the feature exists proves nothing.`,
        ``,
        `List only the ones you can overturn, with a concrete reason. If they all hold, return an empty list —`,
        `do not invent findings to look useful.`,
      ].join('\n'),
      { label: `refute:${wave}`, phase: 'Verify', schema: REFUTE_SCHEMA, agentType: 'Forge', effort: 'high' },
    ),
  () =>
    agent(
      [
        `Security audit of wave ${wave} in ${repoPath} at ${mergedSha ?? 'HEAD'}. Read-only.`,
        ``,
        `Ignore the acceptance checklist. Check the epic's structural invariants directly:`,
        `- No git credential in any process env, in argv, or in .git/config.`,
        `- No \`git push\` in the runner path; the middleware applies the reviewed diff server-side.`,
        `- No \`--force\`; no token with merge or admin scope.`,
        `- Runner tokens stored only as hashes; timing-safe comparison.`,
        `- Every terminal transition passes through finalizeDevJob.`,
        `- Policy (env, egress allowlist, token scope) derived server-side, never from a caller.`,
        `- Untrusted input (ticket text, repo content) is data, never authorization.`,
        `- Secrets are absent from log lines, event payloads, and error messages.`,
        ``,
        `A single confirmed violation means \`invariantsHold: false\`. Cite file:line for each.`,
      ].join('\n'),
      { label: `audit:${wave}`, phase: 'Verify', schema: AUDIT_SCHEMA, agentType: 'Cato' },
    ),
]);

const overturned = new Set((refute?.overturned ?? []).map((o) => `${o.unitId}::${o.criterion}`));

const table = (check?.criteria ?? []).map((c) => {
  const key = `${c.unitId}::${c.criterion}`;
  return overturned.has(key)
    ? { ...c, verdict: 'fail', evidence: `overturned on verification: ${(refute.overturned.find((o) => `${o.unitId}::${o.criterion}` === key) ?? {}).why}` }
    : c;
});

const failed = table.filter((c) => c.verdict === 'fail');
const manual = table.filter((c) => c.verdict === 'manual');
const unverifiable = table.filter((c) => c.verdict === 'unverifiable');
const passed = table.filter((c) => c.verdict === 'pass');

const violations = securityAudit?.violations?.items ?? [];
const waveDone =
  Boolean(check?.buildPassed) &&
  Boolean(check?.testsPassed) &&
  failed.length === 0 &&
  violations.length === 0;

log(`${wave}: ${passed.length} pass, ${failed.length} fail, ${manual.length} manual, ${unverifiable.length} unverifiable`);
if (overturned.size) log(`${overturned.size} criterion/criteria overturned by the refuter`);
if (violations.length) log(`SECURITY: ${violations.length} invariant violation(s)`);
if (manual.length) log(`${manual.length} criteria need a human: end-to-end and UI checks are not agent-verifiable`);

// The caller shows this to a human. `waveDone` is necessary, not sufficient — the
// manual criteria still have to be run by a person before the next wave starts.
return {
  wave,
  mergedSha,
  waveDone,
  buildPassed: check?.buildPassed ?? false,
  testsPassed: check?.testsPassed ?? false,
  securityInvariantsHold: violations.length === 0,
  securityViolations: violations,
  refuterSummary: refute?.summary ?? '',
  auditSummary: securityAudit?.summary ?? '',
  criteria: table,
  needsHuman: manual,
  specDefects: unverifiable,
};
