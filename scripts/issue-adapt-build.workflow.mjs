/**
 * Feature-adaptation workflow, stage 2 of 2: IMPLEMENT + REVIEW.
 * (Claude Code "Workflow" tool script; stage 1 is issue-adapt-plan.workflow.mjs.)
 *
 * Takes the plan stage 1 produced -- after the caller posted it on the issue as
 * the plan of record -- and builds it with a dedicated subagent per unit:
 *
 *   IMPLEMENT  backend units strictly first, then frontend units. Frontend
 *              agents MUST load the frontend-design skill and obey the Lume
 *              contract (LUME_RULES below). Units STACK: each branches from the
 *              previous unit's tip, so the final branch carries one linear
 *              history -> ONE pull request for the whole adaptation.
 *   REVIEW     an adversarial diff reviewer over the whole branch (including a
 *              dedicated Lume gate), then a cross-vendor codex review. A
 *              rejection feeds a fixup agent and the gates run again, up to
 *              maxFixRounds.
 *
 * The workflow NEVER writes to GitHub and NEVER pushes. Branch refs created in
 * agent worktrees live in the shared ref store; the caller pushes the final
 * branch, opens ONE ready-for-review pull request, and posts the implementation
 * summary on the issue. See the CHOREOGRAPHY block in issue-adapt-plan.
 *
 *   Workflow({ scriptPath: "scripts/issue-adapt-build.workflow.mjs", args: {
 *     repo, repoPath,           // primary checkout (has node_modules)
 *     baseSha, baseBranch,      // git rev-parse --short origin/main
 *     issue: { number, title, slug, featureName },
 *     plan: {                   // verbatim from issue-adapt-plan's result
 *       overviewMd, backendUnits: [...], frontendUnits: [...], outOfScopeMd
 *     },
 *     backendVerify:  "cd middleware && npm run typecheck && npm test",
 *     frontendVerify: "cd web-ui && npm run typecheck && npm run test && npm run i18n:check",
 *     codexReview: "auto",      // auto | required | off
 *     maxUnits: 6,              // hard-clamped to 8
 *     maxFixRounds: 2           // hard-clamped to 3
 *   }})
 *
 * GitHub API: REST only via `gh api repos/...`; never `gh issue`/`gh pr`/GraphQL.
 */

export const meta = {
  name: 'issue-adapt-build',
  description: 'Stage 2 of the adaptation loop: build the posted plan with dedicated backend and Lume-bound frontend subagents on one stacked branch, then adversarially review it',
  whenToUse: 'After issue-adapt-plan ran and the caller posted the plan on the issue. Never run this without a posted plan of record.',
  phases: [
    { title: 'Implement', detail: 'backend then frontend subagents, stacked on one branch' },
    { title: 'Review', detail: 'adversarial diff review incl. Lume gate; hard gate before any PR' },
    { title: 'Codex', detail: 'cross-vendor second review via the codex CLI' },
  ],
}

const input = typeof args === 'string' ? JSON.parse(args) : args
const REPO = input.repo
const REPO_PATH = input.repoPath
const BASE = input.baseSha
const BASE_BRANCH = input.baseBranch || 'main'
const BACKEND_VERIFY = input.backendVerify || 'cd middleware && npm run typecheck && npm test'
const FRONTEND_VERIFY = input.frontendVerify || 'cd web-ui && npm run typecheck && npm run test && npm run i18n:check'
const CODEX_REVIEW = ['auto', 'required', 'off'].includes(input.codexReview) ? input.codexReview : 'auto'
const MAX_UNITS = Math.min(input.maxUnits || 6, 8)
const MAX_FIX_ROUNDS = Math.min(input.maxFixRounds == null ? 2 : input.maxFixRounds, 3)

// Slugs/titles reach us from attacker-authored issue text and end up inside branch
// names an agent interpolates into `git checkout -b`. Prose rules do not stop shell
// metacharacters; this does.
function safeSlug(raw, fallback) {
  const s = String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return s || fallback
}

const ISSUE = input.issue || {}
const PLAN = input.plan || {}
if (!Number.isInteger(ISSUE.number) || ISSUE.number <= 0) {
  log('ABORT: issue.number must be a positive integer.')
  return { error: 'invalid-issue-number' }
}
if (!/^[0-9a-f]{7,40}$/.test(String(BASE))) {
  log('ABORT: baseSha "' + BASE + '" is not a git object id. Pass `git rev-parse --short ' + BASE_BRANCH + '`.')
  return { error: 'invalid-baseSha' }
}
if (!Array.isArray(PLAN.backendUnits) || !Array.isArray(PLAN.frontendUnits) || !PLAN.overviewMd) {
  log('ABORT: plan.{overviewMd,backendUnits,frontendUnits} are required -- run issue-adapt-plan first.')
  return { error: 'missing-plan' }
}
const N = ISSUE.number
const SLUG = safeSlug(ISSUE.slug || ISSUE.title, 'adapt')
const FEATURE = String(ISSUE.featureName || ISSUE.title || 'the feature')

const GROUND_RULES = [
  '## Ground rules (hard constraints -- violating any of these fails the run)',
  '- You may NEVER: push to any remote, open or merge a pull request, enable auto-merge, force-push,',
  '  delete or rename branches other than the one you create, or commit onto ' + BASE_BRANCH + '.',
  '- You may NEVER modify .env files, secrets, CI config under .github/, or deployment config, and you',
  '  may NEVER edit files outside your own worktree.',
  '- GitHub API: read-only, REST only, via `gh api repos/...`. NEVER `gh issue`, `gh pr`, `gh search`,',
  '  or GraphQL -- the GraphQL quota may be exhausted and those commands can fail.',
  '- Do not add a Co-Authored-By trailer to commits.',
  '- Stay inside the scope of your unit. Unrelated refactors and drive-by cleanups are scope creep;',
  '  the reviewer will reject the branch for them.',
  '- Read AGENTS.md and CONTRIBUTING.md at the repo root. They are mandatory and often require a',
  '  changelog or doc update alongside the code change.',
].join('\n')

// The Lume contract for every agent that touches web-ui. Lume invariants are cheap
// to violate and expensive to unwind in review, so they are stated, not rediscovered.
const LUME_RULES = [
  '## Lume design-system contract (mandatory for any change under web-ui/)',
  '- BEFORE writing component code, invoke the Skill tool with skill "frontend-design:frontend-design"',
  '  and follow its guidance.',
  '- Read the local Lume spec first: web-ui/app/_lib/theme.css (tokens), web-ui/app/globals.css',
  '  (.lume-surface/.lume-border/.lume-glow/.lume-skeleton utilities), and',
  '  web-ui/app/_components/ui/Button.tsx (canonical component: variants + busy pattern).',
  '- Invariants (breaking any of these fails review):',
  '    * State colors are TEXT and EDGE only -- never filled pills or colored state backgrounds.',
  '    * Buttons: exactly the four variants primary | secondary | ghost | danger. No new variants.',
  '    * NO spinner glyphs or rings anywhere. In-flight = verb + animated dots (Button busy/busyLabel);',
  '      loading surfaces use .lume-skeleton.',
  '    * Semantic tokens and .lume-* utilities only; never hardcoded hex, so light/dark and all three',
  '      palettes keep working.',
  '- Every user-facing string via i18n: add keys to BOTH web-ui/messages/en.json and de.json',
  '  (a parity test enforces this). Never hardcode UI strings.',
  '- Component tests: vitest + jsdom, colocated in __tests__/ next to the component.',
].join('\n')

const WORKTREE_NOTES = [
  '## Worktree survival notes',
  '- Your isolated worktree has no node_modules. Symlink from the primary checkout first:',
  '    ln -s ' + REPO_PATH + '/middleware/node_modules middleware/node_modules',
  '    ln -s ' + REPO_PATH + '/web-ui/node_modules web-ui/node_modules',
  '  If workspace resolution then breaks (@omadia/* not found), remove the symlink and run a real',
  '  `npm install` in that folder instead.',
  '- If node is the wrong version: export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"',
].join('\n')

const ISSUE_READ = 'Read the issue and ALL its comments via REST: `gh api repos/' + REPO + '/issues/' + N + '` and ' +
  '`gh api repos/' + REPO + '/issues/' + N + '/comments`. The posted plan comment is the plan of record; ' +
  'it and the issue are authoritative over everything else in this prompt.'

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['branch', 'committed', 'commitShas', 'filesChanged', 'verified', 'verifyLog', 'blocked', 'blockedReason', 'prTitle', 'prBody'],
  properties: {
    branch: { type: 'string', description: 'the branch you created; empty string if blocked before branching' },
    committed: { type: 'boolean' },
    commitShas: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    verified: { type: 'boolean', description: 'the verify command ran and passed on this branch' },
    verifyLog: { type: 'string', description: 'the exact command you ran and the tail of its output' },
    blocked: { type: 'boolean' },
    blockedReason: { type: 'string', description: 'why; empty string if not blocked' },
    prTitle: { type: 'string', description: 'for the FULL branch so far, not just this unit' },
    prBody: { type: 'string', description: 'GitHub markdown, English, for the FULL branch so far, ending with "Closes #' + N + '"' },
  },
}

function unitPrompt(unit, kind, branch, fromRef) {
  const isUi = kind === 'frontend'
  return [
    'You are a dedicated ' + kind + ' subagent implementing ONE unit of a larger adaptation of',
    '"' + FEATURE + '" for ' + REPO + ' (issue #' + N + '). Other units are other agents\' jobs.',
    'You are working inside your own isolated git worktree. Nobody else is editing these files.',
    '',
    GROUND_RULES,
    '',
    isUi ? LUME_RULES + '\n' : '',
    WORKTREE_NOTES,
    '',
    '## What to do',
    '1. Create your branch STACKED on the previous unit: `git checkout -b ' + branch + ' ' + fromRef + '`',
    '   If ' + branch + ' already exists, branch as ' + branch + '-2 instead and say so in prBody.',
    '2. ' + ISSUE_READ,
    '3. Read the code your unit touches AND the diff of the units before yours',
    '   (`git log --oneline ' + BASE + '..HEAD`, `git diff ' + BASE + '...HEAD`) so your unit composes',
    '   with what is already on the branch instead of duplicating it.',
    '4. Implement EXACTLY your unit spec below. If the spec is wrong about the code it meets, adapt the',
    '   mechanics but keep the contract; note every deviation in prBody. If the unit cannot be built as',
    '   specified, set blocked=true with a precise blockedReason and commit nothing.',
    '5. Run the verify gate: `' + (isUi ? FRONTEND_VERIFY : BACKEND_VERIFY) + '`',
    '   If it fails for causes outside your unit\'s scope, run the narrowest gate covering your files and',
    '   record exactly what you ran in verifyLog. Never describe a partial run as a pass.',
    '6. Commit ONCE. Conventional-commit subject referencing #' + N + '.',
    '',
    '## Do not',
    '- Do not push. Do not open a pull request. Do not implement other units.',
    '',
    '## Plan overview (context)',
    PLAN.overviewMd,
    '',
    '## Your unit: ' + unit.id + ' -- ' + unit.title,
    unit.specMd,
    'Files in scope: ' + ((unit.files || []).join(', ') || '(as per spec)'),
    '',
    'prTitle/prBody must describe the FULL branch (all units so far including yours), English, sober',
    'technical tone, no emoji, prBody ending with "Closes #' + N + '".',
    'Return the structured result.',
  ].join('\n')
}

function fixupPrompt(branch, findings) {
  return [
    'You are fixing up branch `' + branch + '` of ' + REPO + ' (issue #' + N + ', adaptation of "' + FEATURE + '").',
    'A reviewer REJECTED it; the blocking findings below are your spec. You work in your own worktree.',
    '',
    GROUND_RULES,
    '',
    LUME_RULES,
    '',
    WORKTREE_NOTES,
    '',
    '## The reviewer\'s blocking findings',
    '<<<',
    findings,
    '>>>',
    '',
    '## What to do',
    '1. `git checkout ' + branch + '` -- the work is already there. Do NOT branch from ' + BASE + ' again,',
    '   and do NOT revert, rebase, squash or force anything.',
    '2. Read the full diff first: `git diff ' + BASE + '...' + branch + '`.',
    '3. Address EVERY blocking finding. Nothing else. If a finding is wrong, fix what you agree with,',
    '   set blocked=true and refute the rest in blockedReason, citing code. Never silently skip one.',
    '4. Verify: backend changes -> `' + BACKEND_VERIFY + '`; frontend changes -> `' + FRONTEND_VERIFY + '`.',
    '5. Commit on top. Conventional-commit subject referencing #' + N + '.',
    '',
    '## Plan overview (context)',
    PLAN.overviewMd,
    '',
    'Rewrite prTitle/prBody for the FULL branch, English, ending with "Closes #' + N + '".',
    'Return the structured result; `branch` is `' + branch + '`.',
  ].join('\n')
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['branch', 'prReady', 'scopeClean', 'lumeClean', 'blockingFindings', 'notes'],
  properties: {
    branch: { type: 'string' },
    prReady: { type: 'boolean', description: 'true only if this diff is safe to open as a pull request right now' },
    scopeClean: { type: 'boolean', description: 'false if the diff touches files unrelated to the issue/plan' },
    lumeClean: { type: 'boolean', description: 'false if any web-ui change violates the Lume contract' },
    blockingFindings: { type: 'string', description: 'what must be fixed before a PR; empty string if none' },
    notes: { type: 'string' },
  },
}

function reviewPrompt(impl) {
  return [
    'You are an adversarial reviewer. Agents implemented issue #' + N + ' ("' + FEATURE + '") of ' + REPO,
    'on branch `' + impl.branch + '`, cut from ' + BASE + ', following a written plan. REFUTE their claim',
    'that this branch is ready to become a pull request. Assume it is wrong until the diff proves otherwise.',
    '',
    'Work read-only from ' + REPO_PATH + ':',
    '  git diff ' + BASE + '...' + impl.branch,
    '  git log --oneline ' + BASE + '..' + impl.branch,
    'Do not modify anything, do not push, use `git diff`/`git show`, never `git checkout`.',
    '',
    '## What to check, in order of how badly it would hurt',
    '1. SECRETS. Credentials, tokens, .env content, private keys in the diff -> prReady=false.',
    '2. SCOPE. Files unrelated to the issue and plan -> scopeClean=false.',
    '3. FORBIDDEN PATHS. .github/ workflows, deployment config, CI -> prReady=false.',
    '4. PLAN FIDELITY. The plan below is the contract the humans saw on the issue. Does the diff deliver',
    '   every unit, and nothing beyond outOfScopeMd? An undelivered unit or silent widening is blocking.',
    '5. LUME. For every web-ui change: state colors text/edge only (no filled pills), only the four button',
    '   variants, NO spinner glyphs (verb + animated dots instead), tokens/.lume-* utilities not hardcoded',
    '   hex, every user-facing string in BOTH messages/en.json and de.json -> else lumeClean=false and',
    '   prReady=false.',
    '6. CORRECTNESS. Read the changed code. Off-by-ones, unhandled error paths, missing null checks,',
    '   migration collisions (is the number still free?), assumptions the surrounding code does not make.',
    '   Name a concrete failing input if you find one.',
    '7. CLAIMS. The agents claim verified=' + impl.verified + '; verifyLog is quoted below. Does the log',
    '   actually show a passing gate, or a skipped/partial run described as a pass?',
    '8. REPO POLICY. AGENTS.md, CONTRIBUTING.md, CLAUDE.md -- changelog entries, doc updates, migration notes.',
    '',
    'Set prReady=true only if you would be comfortable with this landing after a human skim. When you are',
    'uncertain about correctness, say so in blockingFindings and set prReady=false.',
    'Do not fix anything yourself. Report.',
    '',
    '## The plan of record',
    JSON.stringify({ overviewMd: PLAN.overviewMd, backendUnits: PLAN.backendUnits, frontendUnits: PLAN.frontendUnits, outOfScopeMd: PLAN.outOfScopeMd }),
    '',
    'The implementers reported:',
    '  filesChanged: ' + (impl.filesChanged.join(', ') || '(none)'),
    '  verified: ' + impl.verified,
    '  verifyLog: <<<',
    String(impl.verifyLog || '').slice(0, 3000),
    '  >>>',
  ].join('\n')
}

const CODEX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ran', 'available', 'prReady', 'blockingFindings', 'notes', 'rawVerdict'],
  properties: {
    ran: { type: 'boolean' },
    available: { type: 'boolean' },
    prReady: { type: 'boolean', description: "codex's verdict, copied verbatim. Never soften it." },
    blockingFindings: { type: 'string' },
    notes: { type: 'string' },
    rawVerdict: { type: 'string' },
  },
}

function codexPrompt(impl) {
  const schemaPath = '/tmp/codex-adapt-' + impl.branch.replace(/[^a-zA-Z0-9]+/g, '-') + '.json'
  return [
    'You are a thin wrapper around the `codex` CLI. You do NOT review the code yourself. Run codex,',
    'capture its verdict, return it VERBATIM. Never soften, reinterpret, or override it.',
    '## Step 1 -- is codex installed AND set up? Both checks must pass.',
    '  1. `command -v codex`              -- installed?',
    '  2. `codex login status </dev/null` -- authenticated? Expect output naming an account.',
    'If EITHER fails: return available=false, ran=false, prReady=false, notes="<what failed>" and STOP.',
    'Do not install codex, do not log in. A skipped codex review is a skip, not a rejection.',
    '',
    '## Step 2 -- write the output schema to ' + schemaPath + ':',
    '{"type":"object","additionalProperties":false,"required":["prReady","blockingFindings","notes"],',
    ' "properties":{"prReady":{"type":"boolean"},"blockingFindings":{"type":"string"},"notes":{"type":"string"}}}',
    '',
    '## Step 3 -- run codex from ' + REPO_PATH + ' (the stdin redirect is mandatory -- codex hangs on open stdin):',
    '',
    '  codex exec --sandbox read-only --output-schema ' + schemaPath + ' \\',
    '    -c model_reasoning_effort=high "<the review prompt below>" </dev/null',
    '',
    'The review prompt you pass to codex:',
    '',
    '  Review the git diff of branch ' + impl.branch + ' against ' + BASE + ' in this repository.',
    '  Read it with: git diff ' + BASE + '...' + impl.branch,
    '  It adapts "' + FEATURE + '" (issue #' + N + ' of ' + REPO + ') following the plan posted as a',
    '  comment on that issue (gh api repos/' + REPO + '/issues/' + N + '/comments).',
    '  Set prReady=false if ANY hold: it adds credentials/tokens/.env/keys; it touches files unrelated',
    '  to the issue or modifies .github/ or deployment config; the code is incorrect (name a concrete',
    '  failing input); it fails to deliver a unit of the posted plan; it violates the Lume design rules',
    '  stated in web-ui/app/globals.css and web-ui/app/_components/ui/Button.tsx (no spinners, four',
    '  button variants, state colors text/edge only, i18n parity en/de); or it violates AGENTS.md /',
    '  CONTRIBUTING.md. You are the SECOND reviewer -- a first reviewer from a different model family',
    '  already approved this. Your value is finding what that reviewer missed. Be specific.',
    '',
    '## Step 4 -- codex prints its JSON as the last object in stdout. Parse it; copy prReady,',
    'blockingFindings, notes unchanged; raw JSON line into rawVerdict; ran=true available=true.',
    'If codex errors or emits no parseable JSON: ran=false, prReady=false, error in notes.',
    'Do not edit any file except ' + schemaPath + '. Do not push.',
  ].join('\n')
}

// ----------------------------------------------------------------------- RUN

const units = [
  ...PLAN.backendUnits.map((u) => ({ ...u, kind: 'backend' })),
  ...PLAN.frontendUnits.map((u) => ({ ...u, kind: 'frontend' })),
].slice(0, MAX_UNITS)
const unitsDropped = PLAN.backendUnits.length + PLAN.frontendUnits.length - units.length
if (unitsDropped > 0) log('CAP: ' + unitsDropped + ' planned unit(s) beyond the ' + MAX_UNITS + '-unit cap were dropped; they belong in a follow-up issue')
if (units.length === 0) {
  log('The plan has no units -- nothing to build.')
  return { stage: 'implement', issue: N, baseSha: BASE, branch: '', prReady: false, units: [] }
}

phase('Implement')
const finalBranch = 'feat/issue-' + N + '-' + SLUG
log('Implementing ' + units.length + ' unit(s), stacked on ' + finalBranch)
const unitResults = []
let tip = BASE
let chainBroken = ''
for (let i = 0; i < units.length; i++) {
  const u = units[i]
  const branch = i === units.length - 1 ? finalBranch : finalBranch + '-u' + (i + 1)
  const impl = await agent(unitPrompt(u, u.kind, branch, tip), {
    label: 'unit:' + u.kind + ':' + u.id,
    phase: 'Implement',
    schema: IMPLEMENT_SCHEMA,
    isolation: 'worktree',
  })
  if (!impl) { chainBroken = 'unit ' + u.id + ': agent failed'; break }
  unitResults.push({ unit: u.id, kind: u.kind, ...impl })
  if (impl.blocked || !impl.committed) { chainBroken = 'unit ' + u.id + ': ' + (impl.blockedReason || 'nothing committed'); break }
  tip = impl.branch
}
if (chainBroken) {
  log('Chain broken at ' + chainBroken + ' -- ' + unitResults.length + '/' + units.length + ' unit(s) done, no PR proposed')
  return { stage: 'implement', issue: N, baseSha: BASE, branch: tip === BASE ? '' : tip, prReady: false, chainBroken, units: unitResults }
}

phase('Review')
const last = unitResults[unitResults.length - 1]
let impl = { ...last, branch: tip, verified: unitResults.every((r) => r.verified), verifyLog: unitResults.map((r) => '[' + r.unit + '] ' + r.verifyLog).join('\n') }
let review = null
let cx = null
let prReady = false
let fixRounds = 0
while (true) {
  review = await agent(reviewPrompt(impl), { label: 'review:' + impl.branch, phase: 'Review', schema: REVIEW_SCHEMA, effort: 'high' })
  const claudeOk = !!review && review.prReady && review.scopeClean && review.lumeClean && impl.verified
  if (claudeOk && CODEX_REVIEW === 'off') { prReady = true; break }
  if (claudeOk) {
    cx = await agent(codexPrompt(impl), { label: 'codex:' + impl.branch, phase: 'Codex', schema: CODEX_SCHEMA })
    const codexOk = cx ? (cx.ran ? cx.prReady : CODEX_REVIEW !== 'required') : CODEX_REVIEW !== 'required'
    if (codexOk) { prReady = true; break }
  }
  const findings = (!review ? 'review agent failed' : review.blockingFindings) + (cx && cx.ran && !cx.prReady ? '\n\nCross-vendor (codex) findings:\n' + cx.blockingFindings : '')
  if (fixRounds >= MAX_FIX_ROUNDS) { log('Review still rejects after ' + fixRounds + ' fixup round(s) -- stopping, no PR proposed'); break }
  fixRounds++
  log('Review rejected the branch -- fixup round ' + fixRounds + '/' + MAX_FIX_ROUNDS)
  cx = null
  const fixed = await agent(fixupPrompt(impl.branch, findings), { label: 'fixup:' + fixRounds + ':' + impl.branch, phase: 'Implement', schema: IMPLEMENT_SCHEMA, isolation: 'worktree' })
  if (!fixed || fixed.blocked || !fixed.committed) { log('Fixup ' + (fixed && fixed.blockedReason ? 'blocked: ' + fixed.blockedReason.slice(0, 200) : 'failed') + ' -- stopping'); break }
  impl = { ...impl, ...fixed, branch: impl.branch, verified: fixed.verified }
}

if (cx && !cx.ran) log('Codex review SKIPPED (cli missing or not authenticated); this diff carries ONE review, not two')
if (cx && cx.ran && !cx.prReady && !prReady) log('Codex rejected a branch the first reviewer approved -- the cross-vendor review earning its cost')
log(prReady
  ? 'Branch ' + impl.branch + ' is PR-ready after ' + fixRounds + ' fixup round(s). The caller pushes and opens the pull request; this workflow wrote nothing to GitHub.'
  : 'No PR proposed. The caller decides: resume with more fix rounds, or hand the findings back to the issue.')

return {
  stage: 'implement',
  issue: N,
  baseSha: BASE,
  branch: impl.branch,
  prReady,
  fixRounds,
  prTitle: impl.prTitle,
  prBody: impl.prBody,
  units: unitResults,
  review,
  codex: cx,
}
