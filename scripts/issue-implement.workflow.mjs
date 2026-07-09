/**
 * Issue implementation workflow (Claude Code "Workflow" tool script).
 *
 * Stage 2 of the interactive issue loop. Takes the issues a human explicitly
 * greenlit for one cluster, implements each on a branch inside an isolated git
 * worktree, and runs an adversarial reviewer over every diff before the branch
 * is considered fit for a pull request.
 *
 * The cluster's `cohesion` flag (from issue-cluster.workflow.mjs) selects the
 * strategy, and that is the whole reason the flag exists:
 *
 *   'dependent'    Issues overlap the same files. ONE agent implements them in
 *                  priority order on ONE branch -> one pull request closing all.
 *                  Fanning these out yields parallel branches that each rewrite
 *                  the same file and revert one another.
 *   'independent'  Disjoint files. One worktree-isolated agent per issue, in
 *                  parallel -> one branch and one pull request each.
 *
 * The workflow NEVER writes to GitHub and NEVER pushes. It creates local branches
 * and returns metadata; pushing and opening pull requests is the caller's job, so
 * the remote-write surface stays a single auditable choke point downstream of the
 * human's per-issue greenlight. A branch whose review failed is reported, never
 * proposed as a pull request. Branch refs created inside an agent's worktree live
 * in the shared ref store, so the caller can push them after teardown.
 *
 * This is NOT a standalone Node script -- it runs inside the Claude Code Workflow
 * tool (agent()/parallel()/pipeline()/log() are provided by that runtime).
 *
 *   Workflow({ scriptPath: "scripts/issue-implement.workflow.mjs", args: {
 *     repo:        "<owner>/<name>",
 *     repoPath:    "/abs/path/to/checkout",
 *     baseSha:     "<short-sha>",            // the sha every branch is cut from
 *     baseBranch:  "main",
 *     clusterSlug: "auth-session",
 *     cohesion:    "dependent" | "independent",
 *     verifyCommand: "npm run build",        // the repo's real gate; run in the worktree
 *     maxIssues:   5,                        // hard-clamped to 8
 *     codexReview: "auto",                   // auto | required | off
 *     issues: [ { number, title, slug, summary, touchedFiles: [], keySymbols: [] }, ... ]
 *   }})
 *
 * ITERATION. A rejected branch is not a dead end -- the reviewer has just written a
 * precise, code-grounded spec of what is missing. Add `resumeBranch` and `fixFindings`
 * to the issue and the workflow fixes up that branch instead of cutting a new one from
 * base. The fixup agent commits on top, never rebases or force-pushes, and is told to
 * argue back (blocked=true, reasoned blockedReason) rather than quietly skip a finding
 * it believes is wrong. Both review stages then run again over the full branch.
 *
 * Returns { baseSha, cohesion, results: [...] } where each result carries a branch
 * name and a prReady flag. See the CHOREOGRAPHY block in issue-cluster.workflow.mjs
 * for how the caller drives both stages and where the user is asked.
 *
 * GitHub API: REST only, via `gh api repos/...`. Never `gh issue`, `gh pr`,
 * `gh search`, or GraphQL -- the GraphQL quota may be exhausted.
 */

export const meta = {
  name: 'issue-implement',
  description: 'Implement greenlit GitHub issues on isolated branches and adversarially review each diff before a PR is proposed',
  whenToUse: 'Stage 2 of the interactive issue loop, after a human has picked a cluster and approved specific issues. Never run this without that approval.',
  phases: [
    { title: 'Implement', detail: 'worktree-isolated coding agent per branch' },
    { title: 'Review', detail: 'adversarial diff review; hard gate before any PR' },
    { title: 'Codex', detail: 'cross-vendor second review via the codex CLI' },
  ],
}

const input = typeof args === 'string' ? JSON.parse(args) : args
const REPO = input.repo
const REPO_PATH = input.repoPath
const BASE = input.baseSha
const BASE_BRANCH = input.baseBranch || 'main'
const COHESION = input.cohesion === 'dependent' ? 'dependent' : 'independent'
const VERIFY_COMMAND = input.verifyCommand || ''

/**
 * Slugs reach us from an LLM that read attacker-authored issue titles, and they end
 * up inside a branch name that an agent interpolates into `git checkout -b`. Prose
 * ground rules do not stop shell metacharacters; this does. Anything outside
 * [a-z0-9-] is dropped, so the worst a hostile title can produce is a dull branch name.
 */
function safeSlug(raw, fallback) {
  const s = String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return s || fallback
}

const CLUSTER_SLUG = safeSlug(input.clusterSlug, 'cluster')

/**
 * Cross-vendor second review. The implementer and the first reviewer are the same
 * model family and share its blind spots; a reviewer trained on a different corpus
 * is the cheapest way to find what both of them agree to overlook.
 *
 *   'auto'      (default) run it when the codex CLI is installed AND authenticated;
 *               otherwise SKIP and carry on. An optional reviewer must never break
 *               the pipeline for the many repos and machines that lack it. A skipped
 *               review is reported (codex.ran === false) but never turns prReady
 *               false -- only a codex verdict that actually says "not ready" does.
 *   'required'  opt-in: a missing or failing codex review blocks the pull request.
 *   'off'       skip entirely, do not even probe.
 */
const CODEX_REVIEW = ['auto', 'required', 'off'].includes(input.codexReview) ? input.codexReview : 'auto'

// Blast-radius cap. Even if the caller approved more, a single run stays small
// enough that a human can actually review what came out of it.
const HARD_CAP = 8
// An issue number is interpolated into branch names and into `gh api repos/.../issues/<n>`
// paths inside agent prompts. Anything that is not a plain positive integer is not an
// issue number, whatever the caller believes.
const requested = (input.issues || []).filter((i) => Number.isInteger(i.number) && i.number > 0)
const malformed = (input.issues || []).length - requested.length
const limit = Math.min(input.maxIssues || 5, HARD_CAP)
const issues = requested.slice(0, limit)
const dropped = requested.slice(limit)

const GROUND_RULES = [
  '## Ground rules (hard constraints -- violating any of these fails the run)',
  '- You may NEVER: push to any remote, open or merge a pull request, enable auto-merge, force-push,',
  '  delete or rename branches other than the one you create, or check out ' + BASE_BRANCH + ' and commit onto it.',
  '- You may NEVER modify: .env files, secrets, CI configuration under .github/, or deployment config.',
  '- You may NEVER edit files outside your own worktree.',
  '- GitHub API: read-only, REST only, via `gh api repos/...`. NEVER `gh issue`, `gh pr`, `gh search`,',
  '  or GraphQL -- the GraphQL quota may be exhausted and those commands can fail.',
  '- Do not add a Co-Authored-By trailer to commits.',
  '- Stay inside the scope of the issue(s) you were given. Unrelated refactors, drive-by formatting, and',
  '  opportunistic cleanups are scope creep; the reviewer will reject the branch for them.',
].join('\n')

function issueBrief(issue) {
  const files = (issue.touchedFiles || []).join(', ') || '(none identified upfront)'
  const syms = (issue.keySymbols || []).join(', ') || '(none)'
  return [
    '### Issue #' + issue.number + ': ' + issue.title,
    'Summary: ' + (issue.summary || '(see the issue body)'),
    'Likely files: ' + files,
    'Likely symbols: ' + syms,
  ].join('\n')
}

const VERIFY_BLOCK = VERIFY_COMMAND
  ? [
      '5. Run the verification gate in your worktree: `' + VERIFY_COMMAND + '`',
      '   If it fails and you cannot fix it within the scope of the issue, set verified=false and explain in',
      '   verifyLog. Do NOT commit a branch that does not build.',
    ].join('\n')
  : [
      '5. No verification command was configured. Find the repo\'s own gate (package.json scripts, Makefile,',
      '   CI config) and run the narrowest one that covers the files you touched. Record what you ran in',
      '   verifyLog. If you truly cannot find a gate, set verified=false rather than guessing.',
    ].join('\n')

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['branch', 'issueNumbers', 'committed', 'commitShas', 'filesChanged', 'verified', 'verifyLog', 'blocked', 'blockedReason', 'prTitle', 'prBody'],
  properties: {
    branch: { type: 'string', description: 'the branch you created; empty string if blocked before branching' },
    issueNumbers: { type: 'array', items: { type: 'integer' } },
    committed: { type: 'boolean' },
    commitShas: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    verified: { type: 'boolean', description: 'the repo gate ran and passed on this branch' },
    verifyLog: { type: 'string', description: 'the exact command you ran and the tail of its output' },
    blocked: { type: 'boolean', description: 'true if the issue could not be implemented as specified' },
    blockedReason: { type: 'string', description: 'why; empty string if not blocked' },
    prTitle: { type: 'string' },
    prBody: { type: 'string', description: 'GitHub markdown, English, ending with a "Closes #<n>" line per issue' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['branch', 'prReady', 'scopeClean', 'blockingFindings', 'notes'],
  properties: {
    branch: { type: 'string' },
    prReady: { type: 'boolean', description: 'true only if this diff is safe to open as a pull request right now' },
    scopeClean: { type: 'boolean', description: 'false if the diff touches files unrelated to the issue(s)' },
    blockingFindings: { type: 'string', description: 'what must be fixed before a PR; empty string if none' },
    notes: { type: 'string', description: 'non-blocking observations for the human reviewer' },
  },
}

/**
 * Iteration. A branch the reviewer rejected is not a dead end -- the reviewer just
 * wrote a precise, code-grounded spec for what is missing. Passing that spec back to
 * an implementer on the SAME branch is the cheapest correct move; cutting a fresh
 * branch from base would throw away work the reviewer already validated.
 */
function fixupPrompt(group, branch, findings) {
  const plural = group.length > 1
  return [
    'You are fixing up an existing branch `' + branch + '` that an adversarial reviewer REJECTED.',
    'It implements ' + (plural ? group.length + ' related GitHub issues' : 'GitHub issue #' + group[0].number) + ' of ' + REPO + '.',
    '',
    'You are working inside your own isolated git worktree. Nobody else is editing these files.',
    '',
    GROUND_RULES,
    '',
    '## The reviewer\'s blocking findings -- this is your spec',
    '<<<',
    findings,
    '>>>',
    '',
    '## What to do',
    '1. `git checkout ' + branch + '` -- the work is already there. Do NOT branch from ' + BASE + ' again,',
    '   and do NOT revert or rewrite the existing commits.',
    '2. Read the existing diff first: `git diff ' + BASE + '...' + branch + '`. Understand what was done.',
    '3. Address EVERY blocking finding above. Nothing else. Resist improving unrelated code -- the reviewer',
    '   already confirmed the current scope is clean, and widening it now would undo that.',
    '4. If a finding is wrong, do NOT silently ignore it. Fix what you agree with, set blocked=true, and say',
    '   in blockedReason precisely why the rest is mistaken, citing code. A quiet omission is not a result.',
    VERIFY_BLOCK,
    '6. Commit on top of the existing commits. Conventional-commit subject, reference the issue number.',
    '',
    '## Do not',
    '- Do not push, do not open a pull request. The caller does both, after a human sees your result.',
    '- Do not amend, rebase, squash, or force anything. Add a commit.',
    '',
    '## Issue' + (plural ? 's' : ''),
    group.map(issueBrief).join('\n\n'),
    '',
    'Rewrite prTitle and prBody for the FULL branch (original work plus your fixup), not just your delta.',
    'End with one "Closes #<n>" line per issue. English, sober technical tone, no emoji.',
    'Return the structured result. `branch` is `' + branch + '`. `commitShas` may list only new commits.',
  ].join('\n')
}

function implementPrompt(group, branch) {
  const plural = group.length > 1
  return [
    'You are implementing ' + (plural ? group.length + ' related GitHub issues' : 'GitHub issue #' + group[0].number) + ' of ' + REPO + '.',
    '',
    'You are working inside your own isolated git worktree. Nobody else is editing these files.',
    '',
    GROUND_RULES,
    '',
    '## What to do',
    '1. Create your branch off the base: `git checkout -b ' + branch + ' ' + BASE + '`',
    '   If that branch already exists, a previous run left it behind. Do NOT reuse it and do NOT delete it:',
    '   branch as `' + branch + '-2` (then -3, and so on) and say so in blockedReason=""/prBody. An existing',
    '   branch may already have an open pull request against it.',
    '2. Re-read each issue and its comments via REST: `gh api repos/' + REPO + '/issues/<n>` and',
    '   `gh api repos/' + REPO + '/issues/<n>/comments`. The descriptors below are a starting point,',
    '   not the whole truth -- the issue and its comments are authoritative.',
    '3. Read the surrounding code before writing any. Follow the conventions you find there: naming,',
    '   error handling, test style, comment density. Your diff should read like the code around it.',
    plural
      ? '4. Implement the issues IN THE ORDER GIVEN below. They overlap the same files, which is why they\n   share one branch. Commit after each issue, so the history shows one commit per issue.'
      : '4. Implement the issue. Keep the diff minimal and focused.',
    VERIFY_BLOCK,
    '6. Commit. Use a conventional-commit subject, and reference the issue number.',
    '',
    '## Do not',
    '- Do not push. Do not open a pull request. The caller does both, after a human has seen your result.',
    '- Do not widen the scope. If the issue needs a design decision you cannot make from the code and the',
    '  comments, set blocked=true with a precise blockedReason and commit nothing. A clean "blocked" is a',
    '  useful result; a speculative half-implementation is not.',
    '',
    '## Issue' + (plural ? 's, in priority order' : ''),
    group.map(issueBrief).join('\n\n'),
    '',
    '## Pull request text',
    'Write prTitle and prBody for the human who will review this. prBody must state what changed and why,',
    'call out anything you were unsure about, and end with one "Closes #<n>" line per issue implemented.',
    'English, sober technical tone, no emoji, no marketing language.',
    '',
    'Return the structured result.',
  ].join('\n')
}

function reviewPrompt(impl, group) {
  const numbers = group.map((i) => '#' + i.number).join(', ')
  return [
    'You are an adversarial reviewer. An agent has just implemented ' + numbers + ' of ' + REPO + ' on branch',
    '`' + impl.branch + '`, cut from ' + BASE + '. Your job is to REFUTE its claim that this branch is ready',
    'to become a pull request. Assume it is wrong until the diff proves otherwise.',
    '',
    'Work from the checkout at ' + REPO_PATH + '. Read the diff with:',
    '  git diff ' + BASE + '...' + impl.branch,
    '  git log --oneline ' + BASE + '..' + impl.branch,
    'Do not modify anything. Do not push. Do not open a pull request. Do not check out another branch',
    'in a way that disturbs the working tree -- use `git diff`/`git show`, not `git checkout`.',
    '',
    '## What to check, in order of how badly it would hurt',
    '1. SECRETS. Does the diff add credentials, tokens, .env content, or private keys? Any hit -> prReady=false.',
    '2. SCOPE. Does the diff touch files that have nothing to do with ' + numbers + '? Drive-by refactors,',
    '   reformatting of untouched code, unrelated dependency bumps -> scopeClean=false.',
    '3. FORBIDDEN PATHS. Does it modify .github/ workflows, deployment config, or CI? -> prReady=false.',
    '4. CORRECTNESS. Read the changed code. Does it actually do what the issue asked? Look for off-by-one',
    '   errors, unhandled error paths, missing null checks, and assumptions the surrounding code does not',
    '   make. Name a concrete failing input if you find one.',
    '5. CLAIMS. The agent claims verified=' + impl.verified + '. Its verifyLog is quoted below. Does the log',
    '   actually show a passing gate, or does it show a skipped/partial run described as a pass?',
    '6. COMPLETENESS. Does the diff address every issue it claims to close? Follow the data past the',
    '   obvious call site: a value that is cleaned on one path is often still passed raw on another.',
    '7. REPO POLICY. Read AGENTS.md, CONTRIBUTING.md and any CLAUDE.md at the repo root before you judge.',
    '   They are mandatory instructions and they routinely demand things a diff review would never think',
    '   to check -- a changelog entry, a doc update, a migration note. If a policy file contradicts another',
    '   or looks stale, say so in notes rather than guessing which one wins; that is a maintainer call.',
    '',
    'Set prReady=true only if you would be comfortable with this landing after a human skim. A branch that',
    'builds but silently does the wrong thing is worse than a branch that failed to build. When you are',
    'uncertain about correctness, say so in blockingFindings and set prReady=false -- the cost of a false',
    'green is a bad merge; the cost of a false red is one more look.',
    '',
    'Do not fix anything yourself. Report.',
    '',
    'The implementer reported:',
    '  committed: ' + impl.committed,
    '  filesChanged: ' + (impl.filesChanged.join(', ') || '(none)'),
    '  verified: ' + impl.verified,
    '  verifyLog: <<<',
    impl.verifyLog.slice(0, 3000),
    '  >>>',
  ].join('\n')
}

const CODEX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ran', 'available', 'prReady', 'blockingFindings', 'notes', 'rawVerdict'],
  properties: {
    ran: { type: 'boolean', description: 'true if codex exec actually produced a verdict' },
    available: { type: 'boolean', description: 'false if the codex CLI is missing or not authenticated' },
    prReady: { type: 'boolean', description: "codex's verdict, copied verbatim. Never soften it." },
    blockingFindings: { type: 'string', description: "codex's blocking findings, copied verbatim; empty string if none" },
    notes: { type: 'string' },
    rawVerdict: { type: 'string', description: 'the raw JSON line codex emitted, for audit' },
  },
}

function codexPrompt(impl, group) {
  const numbers = group.map((i) => '#' + i.number).join(', ')
  const schemaPath = '/tmp/codex-review-' + impl.branch.replace(/[^a-zA-Z0-9]+/g, '-') + '.json'
  return [
    'You are a thin wrapper around the `codex` CLI. You do NOT review the code yourself. Your only job is',
    'to run codex, capture its verdict, and return it VERBATIM. Do not soften, reinterpret, or override it.',
    'If codex says the branch is not ready, report exactly that, even if you personally disagree.',
    '## Step 1 -- is codex installed AND set up? Both checks must pass.',
    '  1. `command -v codex`              -- installed?',
    '  2. `codex login status </dev/null` -- authenticated? Expect output naming an account, e.g.',
    '     "Logged in using ChatGPT". Non-zero exit, empty output, or "not logged in" all mean no.',
    'If EITHER fails this is not an error and not yours to fix: return available=false, ran=false,',
    'prReady=false, notes="<which check failed and what it printed>" and STOP. Do not install codex,',
    'do not log in, do not prompt anyone. A skipped codex review is a skip, not a rejection.',
    '',
    '## Step 2 -- write the output schema',
    'Write this exact JSON to ' + schemaPath + ':',
    '{"type":"object","additionalProperties":false,"required":["prReady","blockingFindings","notes"],',
    ' "properties":{"prReady":{"type":"boolean"},"blockingFindings":{"type":"string"},"notes":{"type":"string"}}}',
    '',
    '## Step 3 -- run codex',
    'From ' + REPO_PATH + ', run EXACTLY this shape (the stdin redirect is mandatory -- codex blocks forever',
    'on an open stdin and the workflow will hang):',
    '',
    '  codex exec --sandbox read-only --output-schema ' + schemaPath + ' \\',
    '    -c model_reasoning_effort=high "<the review prompt below>" </dev/null',
    '',
    'The review prompt you pass to codex:',
    '',
    '  Review the git diff of branch ' + impl.branch + ' against ' + BASE + ' in this repository.',
    '  Read it with: git diff ' + BASE + '...' + impl.branch,
    '  It claims to implement ' + numbers + ' of ' + REPO + '.',
    '  Set prReady=false if ANY hold: it adds credentials/tokens/.env/keys; it touches files unrelated',
    '  to ' + numbers + ' or modifies .github/ or deployment config; the code is incorrect (name a',
    '  concrete failing input); it does not address every issue it claims to close; it regresses',
    '  behaviour the surrounding code depends on; or it violates AGENTS.md / CONTRIBUTING.md.',
    '  You are the SECOND reviewer -- a first reviewer from a different model family already approved',
    '  this. Your value is finding what that reviewer, sharing the implementer\'s blind spots, missed.',
    '  Be specific. Do not restate the diff. Do not modify anything.',
    '',
    '## Step 4 -- return',
    'codex prints its JSON as the last object in stdout. Parse it. Copy prReady, blockingFindings and notes',
    'into your structured result unchanged, put the raw JSON line in rawVerdict, set ran=true available=true.',
    'If codex errors or emits no parseable JSON, set ran=false prReady=false and put the error in notes.',
    'Do not edit any file except ' + schemaPath + '. Do not push. Do not open a pull request.',
  ].join('\n')
}

function skeleton(branch, group, reason) {
  return {
    branch,
    issueNumbers: group.map((i) => i.number),
    committed: false,
    commitShas: [],
    filesChanged: [],
    verified: false,
    verifyLog: '',
    blocked: true,
    blockedReason: reason,
    prTitle: '',
    prBody: '',
  }
}

// The review stage is a hard gate: nothing reaches the caller as prReady unless a
// second, adversarial agent independently signed off on the diff.
function runGroup(group, branch, fixup) {
  const prompt = fixup ? fixupPrompt(group, branch, fixup) : implementPrompt(group, branch)
  return agent(prompt, {
    label: (fixup ? 'fixup:' : 'implement:') + branch,
    phase: 'Implement',
    schema: IMPLEMENT_SCHEMA,
    isolation: 'worktree',
  }).then((impl) => {
    if (!impl) return { ...skeleton(branch, group, 'implement agent failed'), prReady: false, review: null }
    if (impl.blocked || !impl.committed) {
      return { ...impl, prReady: false, review: null }
    }
    return agent(reviewPrompt(impl, group), {
      label: 'review:' + impl.branch,
      phase: 'Review',
      schema: REVIEW_SCHEMA,
      effort: 'high',
    }).then((rev) => {
      if (!rev) return { ...impl, prReady: false, review: { prReady: false, blockingFindings: 'review agent failed', scopeClean: false, notes: '' }, codex: null }

      const claudeOk = rev.prReady && rev.scopeClean && impl.verified

      // A branch the first reviewer already rejected does not need a second opinion.
      if (!claudeOk || CODEX_REVIEW === 'off') {
        return { ...impl, prReady: claudeOk, review: rev, codex: null }
      }

      return agent(codexPrompt(impl, group), {
        label: 'codex:' + impl.branch,
        phase: 'Codex',
        schema: CODEX_SCHEMA,
      }).then((cx) => {
        if (!cx) {
          const ok = CODEX_REVIEW !== 'required'
          return { ...impl, prReady: ok && claudeOk, review: rev, codex: { ran: false, available: false, prReady: false, blockingFindings: 'codex agent failed', notes: '', rawVerdict: '' } }
        }
        // 'auto' does not punish a repo that has no codex CLI; 'required' does.
        const codexOk = cx.ran ? cx.prReady : CODEX_REVIEW !== 'required'
        return { ...impl, prReady: claudeOk && codexOk, review: rev, codex: cx }
      })
    })
  })
}

if (malformed > 0) log('WARNING: ' + malformed + ' entr(y/ies) in issues[] had no valid integer number and were discarded')
if (!/^[0-9a-f]{7,40}$/.test(String(BASE))) {
  log('ABORT: baseSha "' + BASE + '" is not a git object id. Pass `git rev-parse --short ' + BASE_BRANCH + '`.')
  return { baseSha: BASE, cohesion: COHESION, results: [], dropped: [], error: 'invalid-baseSha' }
}
if (issues.length === 0) {
  log('No approved issues passed in -- nothing to implement.')
  return { baseSha: BASE, cohesion: COHESION, results: [], dropped: [] }
}
if (dropped.length > 0) {
  log('CAP: ' + dropped.length + ' approved issue(s) dropped from this run (limit ' + limit + '): ' + dropped.map((i) => '#' + i.number).join(', '))
}

let results

if (COHESION === 'dependent' && issues.length > 1) {
  // One branch, one agent, one pull request. The issues overlap the same files, so
  // parallel branches would collide and revert each other.
  const resume = issues.find((i) => i.resumeBranch)
  const branch = resume ? resume.resumeBranch : 'feat/cluster-' + CLUSTER_SLUG
  phase('Implement')
  log('cohesion=dependent -> ' + (resume ? 'fixing up' : 'implementing') + ' ' + issues.length + ' issues sequentially on a single branch ' + branch)
  results = [await runGroup(issues, branch, resume ? (resume.fixFindings || '(no findings supplied)') : null)]
} else {
  // Disjoint files: fan out. pipeline() has no barrier, so issue A can be under
  // review while issue B is still being implemented.
  phase('Implement')
  log('cohesion=independent -> implementing ' + issues.length + ' issue(s) on parallel branches')
  results = (await pipeline(
    issues,
    (issue) => issue.resumeBranch
      ? runGroup([issue], issue.resumeBranch, issue.fixFindings || '(no findings supplied)')
      : runGroup([issue], 'feat/issue-' + issue.number + '-' + safeSlug(issue.slug, 'fix')),
  )).filter(Boolean)
}

const ready = results.filter((r) => r.prReady)
const blocked = results.filter((r) => r.blocked)
const rejected = results.filter((r) => !r.prReady && !r.blocked)
const codexKilled = results.filter((r) => r.codex && r.codex.ran && !r.codex.prReady)
const codexSkipped = results.filter((r) => r.codex && !r.codex.ran)

log('Done: ' + ready.length + ' branch(es) ready for a pull request, ' + rejected.length + ' rejected by review, ' + blocked.length + ' blocked')
if (codexKilled.length) log('Codex rejected ' + codexKilled.length + ' branch(es) the first reviewer had approved -- that is the cross-vendor review earning its cost')
// A skipped second review is not a passed second review. Say so, or the absence of a
// gate reads like the presence of a green one.
if (codexSkipped.length) log('Codex review SKIPPED for ' + codexSkipped.length + ' branch(es) (cli missing or not authenticated); those diffs carry ONE review, not two')
log('The caller pushes and opens the pull requests. This workflow wrote nothing to GitHub.')

return {
  baseSha: BASE,
  baseBranch: BASE_BRANCH,
  cohesion: COHESION,
  results,
  dropped: dropped.map((i) => i.number),
}
