/**
 * Issue clustering workflow (Claude Code "Workflow" tool script).
 *
 * Stage 1 of the interactive issue loop. Enriches every open GitHub issue with a
 * code-grounded descriptor (one agent per issue, in parallel), then groups them
 * semantically in a single reduce agent that sees all descriptors at once.
 *
 * Clustering is irreducibly global: an agent that only sees its own issue cannot
 * decide which other issues it belongs with. So the map stage does the expensive
 * per-issue code investigation, and one reduce agent does the grouping over the
 * compact descriptors. The dominant grouping signal is overlapping touchedFiles,
 * not title similarity -- that is what separates "3 auth issues that all mutate
 * the same module" (cohesion: dependent) from "2 perf issues in disjoint files"
 * (cohesion: independent). That flag decides the implementation strategy in
 * stage 2, so it is load-bearing, not decorative.
 *
 * Intra-cluster prioritisation is deterministic JS (impact / effort), not an
 * agent call -- the ranking must not drift between runs.
 *
 * This is NOT a standalone Node script -- it runs inside the Claude Code Workflow
 * tool (agent()/parallel()/pipeline()/log() are provided by that runtime).
 *
 *   Workflow({ scriptPath: "scripts/issue-cluster.workflow.mjs", args: {
 *     repo:     "<owner>/<name>",
 *     repoPath: "/abs/path/to/checkout",   // read-only checkout of the base branch
 *     baseSha:  "<short-sha>",             // `git rev-parse --short origin/main`
 *     issues:   [ { number, title, body, labels: [], comments: <int>, updated: "YYYY-MM-DD" }, ... ]
 *   }})
 *
 * Returns { baseSha, clusters: [...], unclustered: [...] }. Writes nothing --
 * not to GitHub, not to the working tree.
 *
 * ---------------------------------------------------------------------------
 * CHOREOGRAPHY -- the main loop owns every question and every GitHub write.
 * A Workflow script cannot call AskUserQuestion; only the main Claude loop can.
 * That single constraint is what splits this loop into two scripts.
 *
 *   1. MAIN LOOP  gathers open issues:
 *                   gh api "repos/<repo>/issues?state=open&per_page=100" \
 *                     --jq '[.[] | select(.pull_request == null)]'
 *                 and the base sha: git rev-parse --short origin/main
 *   2. WORKFLOW   issue-cluster.workflow.mjs  -> clusters, each pre-ranked
 *   3. MAIN LOOP  AskUserQuestion: "which group?"
 *
 *                 Do NOT invent a rendering. The workflow returns `groups` -- every
 *                 cluster plus every unclustered issue as its own single-issue group,
 *                 ranked, each carrying a ready-made `card` string. Use the card as
 *                 the AskUserQuestion option `preview`.
 *
 *                 AskUserQuestion allows at most 4 options per question, so `ui`
 *                 carries `clusterPages`: group ids chunked 3-at-a-time. Offer one
 *                 page as 3 options plus a 4th "weitere Gruppen zeigen" / "abbrechen".
 *                 A backlog of 9 clusters plus 8 loose issues does not fit in one
 *                 question, and silently showing only the top 3 would hide the rest.
 *
 *   4. MAIN LOOP  (ranking already computed in step 2 -- no second pass)
 *   5. MAIN LOOP  AskUserQuestion per issue: implement / skip / defer.
 *                 Batch up to `ui.issuesPerCall` (4) issues per call -- one question
 *                 each, three options each, using the issue's own `card` as preview.
 *                 An issue whose readiness is already-shipped, stale, or
 *                 blocked-external should say so in its option descriptions; the
 *                 right answer there is usually not "implement".
 *                 Persist every answer to the gitignored run-state file BEFORE
 *                 doing any work, so a compacted or crashed session resumes
 *                 without re-asking:
 *
 *                   .claude/issue-loop/run-<baseSha>.json
 *                   {
 *                     "baseSha": "1307df1",
 *                     "repo": "byte5ai/omadia",
 *                     "clusters": [ ... verbatim from step 2 ... ],
 *                     "decisions": {
 *                       "412": { "decision": "implement", "cluster": "A" },
 *                       "418": { "decision": "skip",      "cluster": "A" },
 *                       "423": { "decision": "defer",     "cluster": "A",
 *                                "note": "waiting on upstream eslint v8" }
 *                     },
 *                     "prs": { "412": { "branch": "feat/issue-412-x", "url": "..." } }
 *                   }
 *
 *                 decision is one of implement | skip | defer, and only the
 *                 "implement" set is passed to step 6.
 *                   skip  -> this run only; the issue reappears next session.
 *                   defer -> sticky across sessions.
 *
 *                 Stickiness needs care: the file is keyed on baseSha, and baseSha
 *                 changes as soon as main moves -- which is exactly the timescale
 *                 "defer" exists for. So at step 1 the main loop reads the MOST
 *                 RECENT .claude/issue-loop/run-*.json (whatever its sha), carries
 *                 forward every entry whose decision is "defer", and seeds the new
 *                 run-<baseSha>.json with them. A deferred issue is still shown in
 *                 its cluster, annotated with its note, defaulting to "skip".
 *
 *                 Both decisions are local state. Neither touches GitHub, so a
 *                 mis-click costs nothing and is undone by editing one JSON field.
 *   6. WORKFLOW   issue-implement.workflow.mjs on the approved set
 *                 -> branches + verified diffs, still local
 *   7. MAIN LOOP  for each result with prReady === true, push and open the PR:
 *                   git push origin <branch>
 *                   gh api repos/<repo>/pulls -f title=... -f head=<branch> \
 *                     -f base=main -f body="Closes #<n> ..."
 *                 Results with prReady === false are reported to the human with
 *                 their branch name and the reviewer's blockingFindings; they
 *                 never become a pull request. PRs are ready-for-review (repo
 *                 rule; automerge is not the default here, so a draft PR would
 *                 buy nothing but friction). Record the PR urls in the run-state
 *                 file, then loop back to step 3 for the next cluster.
 *
 * GitHub API: REST only, via `gh api repos/...`. Never `gh issue`, `gh pr`,
 * `gh search`, or GraphQL -- the GraphQL quota may be exhausted and those
 * commands fail unpredictably.
 * ---------------------------------------------------------------------------
 */

export const meta = {
  name: 'issue-cluster',
  description: 'Enrich open GitHub issues with code-grounded descriptors, then group them into semantic clusters',
  whenToUse: 'Stage 1 of the interactive issue loop: decide which issues belong together, whether a group shares files, and in what order to tackle them.',
  phases: [
    { title: 'Enrich', detail: 'one code-grounded investigator per open issue' },
    { title: 'Cluster', detail: 'single reduce agent groups all descriptors at once' },
  ],
}

const input = typeof args === 'string' ? JSON.parse(args) : args
const REPO = input.repo
const REPO_PATH = input.repoPath
const BASE = input.baseSha
const issues = input.issues

const EFFORT_WEIGHT = { S: 1, M: 2, L: 4, XL: 8 }

const ENRICH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['number', 'category', 'summary', 'impact', 'effort', 'touchedFiles', 'keySymbols', 'readiness', 'readinessReason'],
  properties: {
    number: { type: 'integer' },
    category: { type: 'string', enum: ['bug', 'security', 'feature', 'architecture', 'ux', 'docs', 'infra', 'maintenance'] },
    summary: { type: 'string', description: 'one sentence, what the issue actually asks for, grounded in what you found' },
    impact: { type: 'integer', minimum: 1, maximum: 5, description: '5 = broken/security in shipped functionality, 1 = cosmetic' },
    effort: { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
    touchedFiles: {
      type: 'array',
      items: { type: 'string' },
      description: 'repo-relative paths this issue would most likely modify. Verified to exist, or explicitly prefixed NEW: for files that must be created. This is the clustering signal -- be precise, not generous.',
    },
    keySymbols: { type: 'array', items: { type: 'string' }, description: 'exported functions/classes/routes the work would touch' },
    readiness: { type: 'string', enum: ['ready-to-implement', 'needs-design', 'needs-decision', 'blocked-external', 'already-shipped', 'stale'] },
    readinessReason: { type: 'string', description: '1-2 sentences grounded in the code or in the issue comments' },
  },
}

const CLUSTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clusters', 'unclustered'],
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'slug', 'theme', 'cohesion', 'cohesionEvidence', 'issueNumbers'],
        properties: {
          id: { type: 'string', description: 'short stable id, e.g. "A", "B", "C"' },
          label: { type: 'string', description: 'human label, e.g. "Auth & session handling"' },
          slug: { type: 'string', description: 'kebab-case, safe for a git branch name, e.g. "auth-session"' },
          theme: { type: 'string', description: 'what unites these issues, one sentence' },
          cohesion: {
            type: 'string',
            enum: ['dependent', 'independent'],
            description: 'dependent = the issues overlap the same files/symbols and must ship together in one branch. independent = disjoint files, safe to implement in parallel branches.',
          },
          cohesionEvidence: { type: 'string', description: 'the concrete overlapping paths/symbols that justify "dependent", or the disjointness that justifies "independent"' },
          issueNumbers: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
    unclustered: { type: 'array', items: { type: 'integer' }, description: 'issue numbers that belong to no group' },
  },
}

function enrichPrompt(issue) {
  const labels = issue.labels.join(', ') || 'none'
  return [
    'You are investigating GitHub issue #' + issue.number + ' of ' + REPO + ': "' + issue.title + '"',
    '(labels: ' + labels + ', ' + issue.comments + ' existing comments, last updated ' + issue.updated + ').',
    '',
    'Your job: produce a compact, code-grounded descriptor. A later agent will group your descriptor',
    'with ~30 others to form semantic clusters. The single most valuable field you produce is',
    'touchedFiles -- it is what tells the grouping agent whether two issues collide in the same code.',
    '',
    '## Ground rules (hard constraints)',
    '- GitHub API: use ONLY REST via `gh api repos/...` (e.g. `gh api repos/' + REPO + '/issues/' + issue.number + '`',
    '  and `gh api repos/' + REPO + '/issues/' + issue.number + '/comments`). NEVER use `gh issue`, `gh pr`, `gh search`',
    '  or GraphQL -- the GraphQL quota may be exhausted and those commands can fail.',
    '- Do NOT post anything to GitHub. You only return data.',
    '- The repo is checked out READ-ONLY at ' + REPO_PATH + ' at ' + BASE + '. Do not modify files, do not run',
    '  builds or tests, do not switch branches.',
    '',
    '## Investigation steps',
    '1. Fetch the issue body and ALL existing comments via REST. Some issues already carry detailed planning',
    '   comments, and part or all of that work may already be shipped on the base branch.',
    '2. Investigate the codebase at ' + REPO_PATH + '. Use rg/fd/cat and `git log --oneline` / `git log -S` to',
    '   check whether the requested work already landed.',
    '3. Name the concrete integration points: real file paths, real exported symbols.',
    '',
    '## Field rules',
    '- touchedFiles: only paths you verified exist (ls/rg). For files that must be created, prefix with "NEW:".',
    '  Be precise, not generous -- a padded list creates false cluster cohesion and causes conflicting branches',
    '  downstream. If you genuinely cannot tell, return the narrowest set you are confident about.',
    '- impact: 5 = broken or security-relevant in shipped functionality; 4 = unblocks a release or high user value;',
    '  3 = valuable, not urgent; 2 = minor; 1 = cosmetic.',
    '- effort: S under an hour, M under a day, L multi-day, XL needs its own design cycle.',
    '- readiness: "already-shipped" if the code already implements it (say so in readinessReason with the',
    '  commit or PR as evidence); "stale" if superseded.',
    '',
    'Issue body:',
    '<<<',
    (issue.body || '(empty)').slice(0, 4000),
    '>>>',
    '',
    'Return the structured result.',
  ].join('\n')
}

const normPath = (f) => String(f).replace(/^NEW:\s*/i, '').trim()

/**
 * Hub files are touched by many unrelated issues: the plugin registration point, the
 * i18n catalogs, the README, the config module. Two issues sharing `messages/en.json`
 * are not coupled -- that file merges cleanly and every feature appends to it. Left in
 * the signal they make every cluster look `dependent`, which collapses the whole
 * sequential-vs-parallel decision to "always sequential" and silently kills the fan-out.
 * Observed on the first live run: 7 of 7 clusters came back dependent, justified by
 * en.json / de.json / index.ts overlap.
 */
function findHubFiles(records) {
  const threshold = Math.max(3, Math.ceil(records.length * 0.1))
  const counts = new Map()
  for (const r of records) {
    for (const f of new Set(r.touchedFiles.map(normPath))) counts.set(f, (counts.get(f) || 0) + 1)
  }
  return new Set([...counts].filter((e) => e[1] >= threshold).map((e) => e[0]))
}

function reducePrompt(records, hubFiles) {
  const table = records.map((r) => {
    const all = r.touchedFiles.map(normPath)
    const own = all.filter((f) => !hubFiles.has(f))
    const hubs = all.filter((f) => hubFiles.has(f))
    const syms = r.keySymbols.join(', ') || '(none)'
    return [
      '#' + r.number + ' [' + r.category + '] impact=' + r.impact + ' effort=' + r.effort + ' readiness=' + r.readiness,
      '  summary: ' + r.summary,
      '  touchedFiles: ' + (own.join(', ') || '(none outside hub files)'),
      '  alsoTouchesHubFiles: ' + (hubs.join(', ') || '(none)'),
      '  keySymbols: ' + syms,
    ].join('\n')
  }).join('\n\n')

  const hubList = hubFiles.size
    ? [
        '## Hub files -- NOT evidence of coupling',
        'These paths are touched by many unrelated issues in this repo. They are registration points,',
        'i18n catalogs, config modules, and docs: append-only, merge-friendly, touched by every feature.',
        'Two issues sharing one of these are NOT coupled. Never cite a hub file as cohesionEvidence.',
        'They are listed per issue as alsoTouchesHubFiles purely so you understand what an issue does.',
        '',
        [...hubFiles].sort().map((f) => '  ' + f).join('\n'),
        '',
      ].join('\n')
    : ''

  return [
    hubList,
    'You are grouping the open issues of ' + REPO + ' into semantic clusters. Below are code-grounded',
    'descriptors for all ' + records.length + ' open issues, produced by one investigator each.',
    '',
    '## Your task',
    'Group them so a maintainer can pick one group and work through it coherently. Then, for each group,',
    'decide the single most consequential field: cohesion.',
    '',
    '## How to decide cohesion -- read this twice',
    'cohesion is NOT "are these issues thematically similar". It is: "if I hand these issues to separate',
    'agents working on separate branches at the same time, do they collide?"',
    '',
    '- dependent   -> two or more issues in the group share a NON-HUB touchedFile or a keySymbol, OR one',
    '                 issue must land before another makes sense, OR they would collide on the same new',
    '                 migration number. Downstream this means: ONE branch, ONE pull request closing all',
    '                 of them, implemented in order.',
    '- independent -> the issues touch disjoint non-hub files. Downstream this means: one branch and one',
    '                 pull request per issue, implemented in parallel.',
    '',
    'Getting this wrong is expensive in BOTH directions, so do not treat dependent as the safe default:',
    '',
    '- Tagging independent when they truly collide: three parallel agents each rewrite the same file and',
    '  produce three pull requests that revert one another.',
    '- Tagging dependent when they do not collide: five unrelated issues are chained onto one branch and',
    '  one oversized pull request, so a single bad issue blocks the other four and nothing runs in',
    '  parallel. A cluster where every member merely appends to en.json is NOT dependent.',
    '',
    'Judge on the touchedFiles line only. Ignore alsoTouchesHubFiles entirely for this decision. If the',
    'only thing two issues share is a hub file, they are independent. Cite the actual shared non-hub path',
    'or symbol in cohesionEvidence; if you cannot name one, the answer is independent.',
    '',
    'A group of exactly one issue is fine, and is always independent.',
    '',
    '## Rules',
    '- Every issue number appears exactly once, either in a cluster or in unclustered.',
    '- Prefer 3-7 clusters. Do not force an issue into a group it does not belong to -- that is what',
    '  unclustered is for.',
    '- Exclude nothing: issues with readiness "already-shipped" or "stale" still get grouped (the maintainer',
    '  will skip them at the per-issue gate, and seeing them is useful signal).',
    '- slug must be kebab-case and safe inside a git branch name.',
    '- cohesionEvidence must name the actual overlapping paths or symbols. "They are all about auth" is not',
    '  evidence. "#12 and #19 both modify middleware/src/auth/session.ts" is evidence.',
    '',
    '## Descriptors',
    table,
    '',
    'Return the structured result.',
  ].join('\n')
}

if (!issues || issues.length === 0) {
  log('No open issues passed in -- nothing to cluster.')
  return { baseSha: BASE, clusters: [], unclustered: [] }
}

phase('Enrich')
log('Enriching ' + issues.length + ' open issues against ' + BASE)

// parallel() is a barrier, and here that is exactly right: the reduce agent must
// see every descriptor at once. Clustering cannot be sharded.
const enriched = (await parallel(
  issues.map((issue) => () =>
    agent(enrichPrompt(issue), { label: 'enrich:#' + issue.number, phase: 'Enrich', schema: ENRICH_SCHEMA })),
)).filter(Boolean)

const lost = issues.length - enriched.length
if (lost > 0) log('WARNING: ' + lost + ' issue(s) failed to enrich and are excluded from clustering')
if (enriched.length === 0) {
  log('Every enrichment agent failed -- aborting before the reduce stage.')
  return { baseSha: BASE, clusters: [], unclustered: issues.map((i) => i.number), enrichFailures: issues.length }
}

phase('Cluster')

const hubFiles = findHubFiles(enriched)
log('Grouping ' + enriched.length + ' descriptors in a single reduce agent')
if (hubFiles.size) log('Excluding ' + hubFiles.size + ' hub file(s) from the cohesion signal: ' + [...hubFiles].sort().slice(0, 6).join(', ') + (hubFiles.size > 6 ? ', ...' : ''))

const grouped = await agent(reducePrompt(enriched, hubFiles), {
  label: 'cluster+cohesion',
  phase: 'Cluster',
  schema: CLUSTER_SCHEMA,
  effort: 'high',
})

if (!grouped) {
  log('Reduce agent failed -- returning the enriched descriptors unclustered.')
  return { baseSha: BASE, clusters: [], unclustered: enriched.map((r) => r.number), enriched }
}

// Deterministic intra-cluster ranking. Doing this in JS rather than in the agent
// keeps the order stable across runs and makes it auditable.
const byNumber = new Map(enriched.map((r) => [r.number, r]))
const score = (r) => r.impact / EFFORT_WEIGHT[r.effort]

// The reduce agent is told each issue appears in exactly one cluster, but an agent
// obeying an instruction is not the same as the data satisfying an invariant. A
// duplicate would be implemented twice, producing two branches and two pull requests
// that both close the same issue. First cluster in the agent's own ordering wins.
const claimed = new Set()

const clusters = grouped.clusters.map((c) => {
  const members = c.issueNumbers
    .filter((n) => byNumber.has(n) && !claimed.has(n))
    .map((n) => {
      claimed.add(n)
      return byNumber.get(n)
    })
    .map((r) => ({ ...r, score: Number(score(r).toFixed(3)) }))
    .sort((a, b) => b.score - a.score || a.number - b.number)

  // A single-issue group can never collide with itself.
  const cohesion = members.length < 2 ? 'independent' : c.cohesion

  return {
    id: c.id,
    label: c.label,
    slug: c.slug,
    theme: c.theme,
    cohesion,
    cohesionEvidence: c.cohesionEvidence,
    size: members.length,
    topScore: members.length ? members[0].score : 0,
    issues: members,
  }
}).filter((c) => c.size > 0)
  .sort((a, b) => b.topScore - a.topScore || a.id.localeCompare(b.id))

const placed = new Set(clusters.flatMap((c) => c.issues.map((i) => i.number)))
const unclustered = enriched.filter((r) => !placed.has(r.number)).map((r) => ({ ...r, score: Number(score(r).toFixed(3)) }))

/**
 * The human gate lives in the main loop, because a Workflow script cannot call
 * AskUserQuestion. What the script CAN do is hand the main loop the exact cards to
 * show, so the presentation does not get re-invented (and quietly degraded) by every
 * session that runs this. AskUserQuestion allows at most 4 options per question and
 * at most 4 questions per call, which is why clusters are paged 3-at-a-time with a
 * "show the rest" slot, and issues are asked 4-at-a-time.
 */
const UI = { optionsPerQuestion: 4, clustersPerPage: 3, issuesPerCall: 4 }

const pad = (s, n) => String(s).slice(0, n).padEnd(n)

function issueCard(i) {
  const files = i.touchedFiles.slice(0, 5).map((f) => '    ' + f).join('\n')
  return [
    '#' + i.number + '  impact ' + i.impact + ' / effort ' + i.effort + '  ->  score ' + i.score,
    'readiness: ' + i.readiness,
    '',
    i.summary,
    '',
    'why: ' + i.readinessReason,
    '',
    'likely files:',
    files || '    (none identified)',
  ].join('\n')
}

function clusterCard(c) {
  const rows = c.issues.map((i) => '  ' + pad('#' + i.number, 6) + pad(i.readiness, 22) + 'score ' + i.score).join('\n')
  return [
    c.label,
    '',
    c.cohesion === 'dependent'
      ? 'ZUSAMMENHAENGEND -- ein Branch, ein Pull Request, der Reihe nach.'
      : 'UNABHAENGIG -- ein Branch und ein Pull Request pro Issue, parallel.',
    'evidence: ' + c.cohesionEvidence,
    '',
    c.theme,
    '',
    rows,
  ].join('\n')
}

const listedValid = grouped.clusters.flatMap((c) => c.issueNumbers).filter((n) => byNumber.has(n)).length
const duplicates = listedValid - claimed.size
if (duplicates > 0) log('NOTE: the reduce agent placed ' + duplicates + ' issue(s) in more than one cluster; kept the first placement of each')

const dependentCount = clusters.filter((c) => c.cohesion === 'dependent').length
log('Done: ' + clusters.length + ' clusters (' + dependentCount + ' dependent, ' + (clusters.length - dependentCount) + ' independent), ' + unclustered.length + ' unclustered')

// Every unclustered issue is its own single-issue, independent group. Presenting them
// as a separate leftover bucket makes them easy to forget; presenting them as groups
// puts them on the same footing as everything else.
const singles = unclustered.map((r) => ({
  id: 'S' + r.number,
  label: '#' + r.number + ' (einzeln)',
  slug: 'issue-' + r.number,
  theme: r.summary,
  cohesion: 'independent',
  cohesionEvidence: 'Single issue -- nothing to collide with.',
  size: 1,
  topScore: r.score,
  issues: [r],
}))

const groups = clusters.concat(singles).sort((a, b) => b.topScore - a.topScore || a.id.localeCompare(b.id))
for (const g of groups) {
  g.card = clusterCard(g)
  for (const i of g.issues) i.card = issueCard(i)
}

// Pages of 3 leave the 4th option slot for "show me the rest" / "stop".
const clusterPages = []
for (let n = 0; n < groups.length; n += UI.clustersPerPage) clusterPages.push(groups.slice(n, n + UI.clustersPerPage).map((g) => g.id))

log('Gate: ' + groups.length + ' selectable groups across ' + clusterPages.length + ' page(s) of ' + UI.clustersPerPage)

return { baseSha: BASE, clusters, unclustered, groups, ui: { ...UI, clusterPages } }
