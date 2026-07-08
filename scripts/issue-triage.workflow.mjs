/**
 * Issue triage workflow (Claude Code "Workflow" tool script).
 *
 * Fans out one codebase-grounded investigator per open GitHub issue, then runs an
 * adversarial fact-checker over each draft comment before anything is posted. Each
 * investigator reads the issue + its comments (REST only) and verifies claims against
 * a read-only checkout of the target branch, so every file path / symbol / "already
 * shipped" statement in the resulting comment is checked before a human sees it.
 *
 * This is NOT a standalone Node script — it runs inside the Claude Code Workflow tool
 * (agent()/parallel()/pipeline()/log() are provided by that runtime). Run it with:
 *
 *   Workflow({ scriptPath: "scripts/issue-triage.workflow.mjs", args: {
 *     repo:     "byte5ai/omadia",              // owner/name
 *     repoPath: "/abs/path/to/checkout",       // read-only checkout of the branch to triage against
 *     headSha:  "<short-sha>",                 // the commit the checkout is on (for comment footers)
 *     issues:   [ { number, title, labels: [], comments: <int>, updated: "YYYY-MM-DD" }, ... ]
 *   }})
 *
 * The caller gathers the issue list up front (e.g. `gh api repos/<repo>/issues?state=open`)
 * and passes it in. The workflow returns { headSha, triaged: [...] } where each entry
 * carries the triage verdict plus a verified `finalComment` ready to post via REST.
 * The workflow itself never writes to GitHub — posting/closing is done by the caller.
 */

export const meta = {
  name: 'issue-triage',
  description: 'Triage open GitHub issues and draft verified implementation-detail comments',
  whenToUse: 'Backlog triage: assign priority/status/effort to every open issue and attach a code-grounded implementation plan, fact-checked against the current branch before posting.',
  phases: [
    { title: 'Triage', detail: 'one codebase-grounded investigator per issue' },
    { title: 'Verify', detail: 'adversarial fact-check of every draft comment' },
  ],
}

const input = typeof args === 'string' ? JSON.parse(args) : args
const REPO = input.repo
const REPO_PATH = input.repoPath
const HEAD = input.headSha
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

log(`Triaging ${issues.length} open issues against ${HEAD}`)

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
log(`Done: ${ok.length}/${issues.length} triaged, ${ok.filter(r => r.verified).length} comments verified for posting, ${ok.filter(r => r.skipComment).length} skipped`)
return { headSha: HEAD, triaged: ok }
