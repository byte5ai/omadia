/**
 * Issue triage + checklist workflow (Claude Code "Workflow" tool script).
 *
 * Two capabilities, selectable via `mode`:
 *
 *  - TRIAGE: fans out one codebase-grounded investigator per open issue, then an
 *    adversarial fact-checker over each draft comment. Each investigator reads the
 *    issue + comments (REST only) and verifies every path/symbol/"already shipped"
 *    claim against a read-only checkout before a human sees it.
 *  - CHECKLIST: for every unchecked `- [ ]` in an issue's body and comments, verify
 *    against the code whether it is DONE on the current branch and, if so, tick it.
 *    Each issue agent returns per-target edits (the full body/comment text, verbatim
 *    except satisfied boxes flipped to `[x]`) + one-line evidence per tick, then an
 *    adversarial verifier re-checks each tick. The CALLER applies each edit only if
 *    the diff vs the live text is PURELY `[ ]`→`[x]` (a safety gate against content
 *    rewrites) — see applyChecklistEdit contract below.
 *
 * This is NOT a standalone Node script — it runs inside the Claude Code Workflow tool
 * (agent()/parallel()/pipeline()/log() are provided by that runtime). Run it with:
 *
 *   Workflow({ scriptPath: "scripts/issue-triage.workflow.mjs", args: {
 *     repo:     "<owner>/<name>",              // any GitHub repo, e.g. "octo/hello"
 *     repoPath: "/abs/path/to/checkout",       // read-only checkout of the branch to review against
 *     headSha:  "<short-sha>",                 // the commit the checkout is on (for footers)
 *     mode:     "full",                        // "full" (triage+checklist) | "triage" | "checklist"
 *     issues:   [ { number, title, labels: [], comments: <int>, updated: "YYYY-MM-DD" }, ... ]
 *   }})
 *
 * The caller gathers the issue list up front (e.g. `gh api repos/<repo>/issues?state=open`)
 * and passes it in. The workflow returns { headSha, mode, triaged, checklist }:
 *   - triaged[]:   { number, ...verdict, verified, finalComment }  — post finalComment via REST.
 *   - checklist[]: { number, verified, summaryMarkdown, edits[] }  where each edit is
 *       { target: "body" | "comment", commentId, updatedText, changed[], evidence[] }.
 * The workflow itself NEVER writes to GitHub — posting/ticking/closing is done by the caller.
 *
 * Caller's diff-safety gate (applyChecklistEdit): fetch the live body/comment text; split
 * both into lines; require equal line count; every line that differs MUST be an exact
 * `[ ]`→`[x]` flip (same prefix/label). If anything else differs, DROP the edit and log it.
 */

export const meta = {
  name: 'issue-triage',
  description: 'Triage open GitHub issues and verify/tick their acceptance-criteria checkboxes',
  whenToUse: 'Backlog triage (priority/status/effort + code-grounded plan) and/or checklist reconciliation: verify every open checkbox against the current branch and tick the ones that are demonstrably done.',
  phases: [
    { title: 'Triage', detail: 'one codebase-grounded investigator per issue' },
    { title: 'Verify', detail: 'adversarial fact-check of every draft comment' },
    { title: 'Checklist', detail: 'verify each checkbox against the code' },
    { title: 'Checklist Verify', detail: 'adversarial re-check of every proposed tick' },
  ],
}

const input = typeof args === 'string' ? JSON.parse(args) : args
const REPO = input.repo
const REPO_PATH = input.repoPath
const HEAD = input.headSha
const MODE = input.mode || 'full' // 'full' | 'triage' | 'checklist'
const issues = input.issues

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['number', 'priority', 'category', 'effort', 'status', 'rationale', 'skipComment', 'skipReason', 'commentMarkdown'],
  properties: {
    number: { type: 'integer' },
    priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
    category: { type: 'string', enum: ['bug', 'security', 'feature', 'architecture', 'ux', 'docs', 'infra', 'maintenance'] },
    effort: { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
    status: { type: 'string', enum: ['shipped-verify-close', 'partially-shipped', 'ready-to-implement', 'needs-design', 'needs-decision', 'blocked-external', 'stale-consider-close'] },
    rationale: { type: 'string', description: '2-4 sentences: why this priority/status, grounded in what you found in the code' },
    skipComment: { type: 'boolean', description: 'true ONLY if a current comment on the issue already says exactly what you would say' },
    skipReason: { type: 'string', description: 'why no comment is warranted; empty string if skipComment=false' },
    commentMarkdown: { type: 'string', description: 'the full GitHub comment body in English; empty string if skipComment=true' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['number', 'verified', 'issuesFound', 'commentMarkdown'],
  properties: {
    number: { type: 'integer' },
    verified: { type: 'boolean', description: 'true if the corrected comment is safe to post publicly' },
    issuesFound: { type: 'string', description: 'summary of factual errors you found and fixed; empty if none' },
    commentMarkdown: { type: 'string', description: 'the final, corrected comment body' },
  },
}

const EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'commentId', 'updatedText', 'changed', 'evidence'],
  properties: {
    target: { type: 'string', enum: ['body', 'comment'] },
    commentId: { type: ['integer', 'null'], description: 'REST comment id when target=comment; null when target=body' },
    updatedText: { type: 'string', description: 'the FULL body/comment markdown, verbatim except satisfied `- [ ]` flipped to `- [x]`. Change nothing else.' },
    changed: { type: 'array', items: { type: 'string' }, description: 'the exact checkbox label text of each box you flipped' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'one line of code evidence (file:symbol or commit/PR) per flipped box, same order as changed' },
  },
}

const CHECKLIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['number', 'nothingToTick', 'edits', 'summaryMarkdown'],
  properties: {
    number: { type: 'integer' },
    nothingToTick: { type: 'boolean', description: 'true when no unchecked box is demonstrably satisfied' },
    edits: { type: 'array', items: EDIT_SCHEMA },
    summaryMarkdown: { type: 'string', description: 'a short comment summarizing ticked vs still-open with evidence; empty when nothingToTick' },
  },
}

const CHECKLIST_VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['number', 'verified', 'edits', 'summaryMarkdown'],
  properties: {
    number: { type: 'integer' },
    verified: { type: 'boolean', description: 'true if the surviving ticks are all safe to apply' },
    edits: { type: 'array', items: EDIT_SCHEMA, description: 'only the ticks you CONFIRMED are satisfied; drop the rest' },
    summaryMarkdown: { type: 'string', description: 'the corrected summary comment reflecting only confirmed ticks; empty if none survive' },
  },
}

function triagePrompt(issue) {
  return `You are triaging GitHub issue #${issue.number} of ${REPO}: "${issue.title}" (labels: ${issue.labels.join(', ') || 'none'}, ${issue.comments} existing comments, last updated ${issue.updated}).

Your job: produce a triage verdict and a GitHub-ready comment with concrete implementation details.

## Ground rules (hard constraints)
- GitHub API: use ONLY REST via \`gh api repos/...\` (e.g. \`gh api repos/${REPO}/issues/${issue.number}\` and \`gh api repos/${REPO}/issues/${issue.number}/comments\`). NEVER use \`gh issue\`, \`gh pr\`, \`gh search\` or GraphQL — the GraphQL quota may be exhausted and those commands can fail.
- Do NOT post anything to GitHub. You only return data.
- The repo is checked out READ-ONLY at ${REPO_PATH} on the target branch @ ${HEAD}. Do not modify files, do not run builds/tests, do not switch branches.
- The comment must be in ENGLISH (repo convention), technical and sober — no marketing tone, no emoji.

## Investigation steps
1. Fetch the issue body and ALL existing comments via REST. Read them carefully — some issues already carry detailed planning comments, and part or all of that work may already be shipped on the current branch.
2. Investigate the codebase at ${REPO_PATH}. Use rg/fd/cat and \`git log --oneline\` / \`git log -S\` to check whether the requested work (or part of it) already landed. Check merged PRs via \`gh api repos/${REPO}/pulls/<n>\` if the comments reference them.
3. Identify the concrete integration points: real file paths, real exported functions/classes/routes, existing patterns to follow, next free migration number if relevant.

## Triage verdict
- priority: P0 = broken/security in shipped functionality, P1 = high-value or unblocks release, P2 = valuable but not urgent, P3 = nice-to-have/waiting on external.
- status: 'shipped-verify-close' if the code already implements it; 'partially-shipped' if some landed; 'ready-to-implement' if the path is clear; 'needs-design' if open architecture questions remain; 'needs-decision' if it needs a maintainer call; 'blocked-external' if waiting on upstream; 'stale-consider-close' if superseded.

## Comment format (English, GitHub markdown)
## Triage
**Priority:** <P0-P3> · **Category:** <category> · **Effort:** <S/M/L/XL> · **Status:** <human-readable status>

<2-4 sentence assessment. If existing comments already contain a plan, do NOT repeat it — reference it and state what has shipped since / what is still open, verified against the current branch.>

## Implementation notes
**Affected code:**
- \`path/to/file.ts\` — <why, referencing real symbols>
(only paths you verified exist @ ${HEAD}; for new files state the target directory that exists)

**Suggested approach:**
1. <concrete step with real integration points>

**Risks / dependencies:** <bullets — migration-number collisions, cross-repo concerns, auth/security implications>

**Acceptance criteria:**
- [ ] <binary, testable>

---
_Automated triage against \`${HEAD}\`; posted after adversarial fact-check review._

Keep the comment under ~90 lines. Every file path and symbol MUST exist (verify with ls/rg) or be explicitly marked as new. If the issue is already fully shipped, say so with evidence (commit/PR) and recommend verify+close instead of a plan.

Set skipComment=true ONLY when an existing comment already contains a current, accurate plan AND nothing shipped since would change it. When in doubt, comment (a status-delta comment is valuable).

Return the structured result. Do not include the issue title in commentMarkdown (GitHub shows it already).`
}

function verifyPrompt(t, issue) {
  return `You are an adversarial fact-checker. Below is a DRAFT comment that will be posted publicly on GitHub issue #${t.number} ("${issue.title}") of ${REPO}. Your job is to REFUTE it: find every factual error before it embarrasses the maintainers.

Check against the read-only checkout at ${REPO_PATH} (@ ${HEAD}):
1. Every file path mentioned must exist (\`ls\`/\`fd\`) unless explicitly marked as new — fix or remove wrong ones.
2. Every function/class/route/symbol mentioned must exist in the stated file (\`rg\`) — fix or remove wrong ones.
3. Claims like "already shipped/implemented in X" must be verifiable in the code or \`git log\` — soften or remove unverifiable claims.
4. Migration numbers: if the draft proposes one, check the migrations dir for the actual next free number.
5. Language: English throughout, sober technical tone, no emoji, no marketing.
6. If the draft claims an existing issue comment says something, verify via \`gh api repos/${REPO}/issues/${t.number}/comments\` (REST only — NEVER gh issue/gh pr/GraphQL).

Do NOT rewrite the comment's substance or opinions — only correct facts, remove hallucinations, and tighten. Preserve the section structure and the footer line. Do not post anything. Repo is read-only.

Set verified=false only if the draft is so wrong it should not be posted even after your fixes.

DRAFT COMMENT:
<<<
${t.commentMarkdown}
>>>

Triage metadata for context: priority=${t.priority}, status=${t.status}, rationale: ${t.rationale}`
}

function checklistPrompt(issue) {
  return `You are reconciling the CHECKBOXES on GitHub issue #${issue.number} of ${REPO}: "${issue.title}". Your job: find every unchecked \`- [ ]\` box in the issue body AND every comment, decide which are DEMONSTRABLY done on the current branch, and produce edits that tick ONLY those.

## Ground rules (hard constraints)
- GitHub API: REST only via \`gh api repos/...\`. Fetch the body with \`gh api repos/${REPO}/issues/${issue.number} --jq .body\` and comments with \`gh api repos/${REPO}/issues/${issue.number}/comments --jq '.[] | {id, body}'\`. NEVER use \`gh issue\`/\`gh pr\`/\`gh search\`/GraphQL. Do NOT write anything — you only return data.
- Read-only checkout at ${REPO_PATH} @ ${HEAD}. Verify with rg/fd/cat and \`git log\`. Do not modify files or switch branches.

## What counts as "done" (be strict — a wrong tick is worse than an unticked box)
- Tick a box ONLY when the code on this branch demonstrably satisfies it, with concrete evidence: a real file:symbol, a route, a migration, a passing test in the repo, or a merged commit/PR you verified in \`git log\`.
- A box that asserts runtime/deployment/manual verification ("verified on the deployed environment", "smoke test on main", "operator confirms …") may be ticked ONLY if a test in the repo covers it; otherwise leave it unchecked.
- If you are not sure, LEAVE IT UNCHECKED. Do not tick aspirational, partial, or design-decision boxes.

## Output — one edit per target you change
For each body/comment that has at least one box you are ticking, return an edit:
- target: "body" or "comment"; commentId: the REST comment id (null for body).
- updatedText: the FULL original markdown of that body/comment, VERBATIM, except each satisfied \`- [ ]\` flipped to \`- [x]\`. Change NOTHING else — not one character of wording, whitespace, ordering, or already-checked boxes. (The caller rejects any edit whose diff is not purely \`[ ]\`→\`[x]\`.)
- changed: the exact label text of each box you flipped (the text after the checkbox).
- evidence: one line per flipped box (same order) — file:symbol / migration / test / commit that proves it.

Set nothingToTick=true (and edits=[], summaryMarkdown="") when no box is demonstrably satisfied — that is the expected outcome for most not-yet-built issues.

When you do tick boxes, also return summaryMarkdown — a short English comment:
"## Checklist review\\nTicked N of M open checkboxes verified done on \`${HEAD}\`:\\n- <label> — <evidence>\\n...\\nStill open: <count> (unchanged).\\n\\n---\\n_Automated checklist reconciliation against \`${HEAD}\`; ticks applied after adversarial verification._"

Return the structured result.`
}

function checklistVerifyPrompt(c, issue) {
  return `You are an adversarial verifier for CHECKBOX ticks about to be applied to GitHub issue #${c.number} ("${issue.title}") of ${REPO}. Someone proposes flipping the boxes below from \`[ ]\` to \`[x]\`. REFUTE each: assume it is NOT done until the code proves it.

Check against the read-only checkout at ${REPO_PATH} (@ ${HEAD}) with rg/fd/cat/\`git log\`, and cross-check the live text via REST (\`gh api repos/${REPO}/issues/${c.number}/comments\`).

For EACH proposed tick:
- Confirm the cited evidence actually exists and actually satisfies the box's wording. Drop the tick if the evidence is missing, unrelated, only partial, or merely a plan/intention.
- Drop any tick whose box requires runtime/deployment/manual confirmation unless a repo test covers it.

Then rebuild the edits keeping ONLY confirmed ticks:
- Re-derive each updatedText from the CURRENT live text (fetch it), flipping only the confirmed boxes, changing nothing else. Keep commentId/target correct. If an edit ends up with no confirmed ticks, drop the whole edit.
- Rewrite summaryMarkdown to list only confirmed ticks (empty string if none survive).
- verified=true if the surviving edits are safe to apply; false to abort applying anything for this issue.

PROPOSED TICKS:
<<<
${JSON.stringify({ edits: c.edits, summaryMarkdown: c.summaryMarkdown }, null, 2)}
>>>`
}

async function runTriage() {
  log(`Triaging ${issues.length} issues against ${HEAD}`)
  const results = await pipeline(
    issues,
    (issue) => agent(triagePrompt(issue), { label: `triage:#${issue.number}`, phase: 'Triage', schema: TRIAGE_SCHEMA }),
    (t, issue) => {
      if (!t) return null
      if (t.skipComment || !t.commentMarkdown.trim()) return { ...t, title: issue.title, verified: false, issuesFound: '', finalComment: '' }
      return agent(verifyPrompt(t, issue), { label: `verify:#${issue.number}`, phase: 'Verify', schema: VERIFY_SCHEMA })
        .then(v => v
          ? { ...t, title: issue.title, verified: v.verified, issuesFound: v.issuesFound, finalComment: v.commentMarkdown }
          : { ...t, title: issue.title, verified: false, issuesFound: 'verify agent failed', finalComment: '' })
    }
  )
  const ok = results.filter(Boolean)
  log(`Triage done: ${ok.length}/${issues.length}, ${ok.filter(r => r.verified).length} comments ready, ${ok.filter(r => r.skipComment).length} skipped`)
  return ok
}

async function runChecklist() {
  log(`Reconciling checkboxes on ${issues.length} issues against ${HEAD}`)
  const results = await pipeline(
    issues,
    (issue) => agent(checklistPrompt(issue), { label: `checklist:#${issue.number}`, phase: 'Checklist', schema: CHECKLIST_SCHEMA }),
    (c, issue) => {
      if (!c) return null
      if (c.nothingToTick || !c.edits || c.edits.length === 0) {
        return { number: issue.number, title: issue.title, verified: false, edits: [], summaryMarkdown: '', nothingToTick: true }
      }
      return agent(checklistVerifyPrompt(c, issue), { label: `checklist-verify:#${issue.number}`, phase: 'Checklist Verify', schema: CHECKLIST_VERIFY_SCHEMA })
        .then(v => v
          ? { number: issue.number, title: issue.title, verified: v.verified, edits: v.edits || [], summaryMarkdown: v.summaryMarkdown || '', nothingToTick: (v.edits || []).length === 0 }
          : { number: issue.number, title: issue.title, verified: false, edits: [], summaryMarkdown: '', nothingToTick: true })
    }
  )
  const ok = results.filter(Boolean)
  const ticks = ok.reduce((n, r) => n + r.edits.reduce((m, e) => m + (e.changed?.length || 0), 0), 0)
  log(`Checklist done: ${ok.filter(r => r.verified && r.edits.length).length} issues with ticks, ${ticks} boxes to flip`)
  return ok
}

const triaged = MODE === 'full' || MODE === 'triage' ? await runTriage() : []
const checklist = MODE === 'full' || MODE === 'checklist' ? await runChecklist() : []
return { headSha: HEAD, mode: MODE, triaged, checklist }
