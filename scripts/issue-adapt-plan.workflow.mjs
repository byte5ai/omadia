/**
 * Feature-adaptation workflow, stage 1 of 2: UNDERSTAND + PLAN.
 * (Claude Code "Workflow" tool script; stage 2 is issue-adapt-build.workflow.mjs.)
 *
 * For issues that ADAPT a capability from other toolsets onto the omadia core.
 * Plain bug-fix/feature issues belong in issue-implement.workflow.mjs. Adaptation
 * issues fail differently: the risk is not writing wrong code, it is building the
 * wrong thing because nobody studied how the source feature works and what people
 * use it for. So this stage is understanding-first:
 *
 *   UNDERSTAND  three parallel researchers: source implementations (web research),
 *               use cases (web research), core fit (our codebase). Independent,
 *               so none anchors the others.
 *   PLAN        one planner synthesizes a detailed spec split into backend units
 *               and frontend units; two adversarial critics (feasibility vs the
 *               codebase, completeness vs the research) can force one revision.
 *
 * CHOREOGRAPHY -- the main loop owns every question and every GitHub write:
 *   1. MAIN LOOP  fetches the issue, computes baseSha, picks sourceToolsets.
 *   2. WORKFLOW   this script -> { research, plan, critiques }.
 *   3. MAIN LOOP  writes docs/plans/issue-<n>-<slug>/*.md (gitignored) and posts
 *                 plan.issueCommentMd as a comment on the issue. That comment is
 *                 the plan of record: build agents re-read it as authoritative.
 *   4. WORKFLOW   issue-adapt-build.workflow.mjs with the plan passed in args.
 *   5. MAIN LOOP  pushes the branch, opens ONE ready-for-review PR, posts the
 *                 implementation summary as a second issue comment.
 *
 *   Workflow({ scriptPath: "scripts/issue-adapt-plan.workflow.mjs", args: {
 *     repo:     "<owner>/<name>",
 *     repoPath: "/abs/path/to/primary/checkout",
 *     issue: { number, title, summary, featureName, sourceToolsets: [] },
 *     maxUnits: 6                       // hard-clamped to 8
 *   }})
 *
 * This workflow writes NOTHING: no GitHub, no files, no branches.
 * GitHub API: REST only via `gh api repos/...`; never `gh issue`/`gh pr`/GraphQL.
 */

export const meta = {
  name: 'issue-adapt-plan',
  description: 'Stage 1 of the adaptation loop: research a feature in its source toolsets and our core, then synthesize an adversarially critiqued implementation plan',
  whenToUse: 'Issues that port/adapt a capability known from other products onto omadia. The caller posts the resulting plan to the issue, then runs issue-adapt-build.',
  phases: [
    { title: 'Understand', detail: 'parallel research: source implementations, use cases, core fit' },
    { title: 'Plan', detail: 'synthesized spec; two adversarial critics; one revision pass' },
  ],
}

const input = typeof args === 'string' ? JSON.parse(args) : args
const REPO = input.repo
const REPO_PATH = input.repoPath
const MAX_UNITS = Math.min(input.maxUnits || 6, 8)
const ISSUE = input.issue || {}
if (!Number.isInteger(ISSUE.number) || ISSUE.number <= 0) {
  log('ABORT: issue.number must be a positive integer.')
  return { error: 'invalid-issue-number' }
}
const N = ISSUE.number
const FEATURE = String(ISSUE.featureName || ISSUE.title || 'the feature')
const TOOLSETS = (ISSUE.sourceToolsets || []).map((t) => String(t)).slice(0, 8)

const ISSUE_READ = 'Read the issue and ALL its comments first via REST: `gh api repos/' + REPO + '/issues/' + N + '` and ' +
  '`gh api repos/' + REPO + '/issues/' + N + '/comments`. They are authoritative over this prompt.'

const MD = { type: 'string', description: 'GitHub-flavored markdown' }

// ---------------------------------------------------------------- UNDERSTAND

const SOURCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['featureEssence', 'implementations', 'dataModel', 'uxPatterns', 'pitfalls', 'sources'],
  properties: {
    featureEssence: { ...MD, description: 'what the feature IS, stripped of any one vendor\'s framing' },
    implementations: { ...MD, description: 'per toolset: how it is built, named, structured' },
    dataModel: { ...MD, description: 'how sources model the data (entities, versioning, parameters)' },
    uxPatterns: { ...MD, description: 'how users discover, select, and instantiate the feature' },
    pitfalls: { ...MD, description: 'documented failure modes of the source implementations' },
    sources: { type: 'array', items: { type: 'string' }, description: 'URLs actually consulted' },
  },
}

const USECASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['useCases', 'mustHaves', 'niceToHaves', 'antiRequirements'],
  properties: {
    useCases: { ...MD, description: 'concrete, named use cases with the user goal each serves' },
    mustHaves: { ...MD, description: 'capabilities without which the adaptation misses the point' },
    niceToHaves: { ...MD, description: 'valuable but deferrable' },
    antiRequirements: { ...MD, description: 'what the sources ship that we should NOT copy, and why' },
  },
}

const FIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachPoints', 'existingPrimitives', 'dataModelNotes', 'migrationNotes', 'frontendSurfaces', 'constraints'],
  properties: {
    attachPoints: { ...MD, description: 'exact files/routers/stores where the feature plugs in' },
    existingPrimitives: { ...MD, description: 'what already exists and must be reused, not duplicated' },
    dataModelNotes: { ...MD, description: 'how the feature maps onto our schema conventions' },
    migrationNotes: { ...MD, description: 'which migrations dir owns this and the exact next free number' },
    frontendSurfaces: { ...MD, description: 'pages/components the UI lands in, with paths' },
    constraints: { ...MD, description: 'repo conventions the plan must respect' },
  },
}

function sourcePrompt() {
  const where = TOOLSETS.length ? TOOLSETS.join(', ') : 'the 3-5 most established products that ship it'
  return [
    'You are researching how OTHER products implement a capability, so a team can adapt it well.',
    'Capability: "' + FEATURE + '". Study it in: ' + where + '.',
    'Context repo (do not modify anything): ' + REPO + ', issue #' + N + ': ' + (ISSUE.title || '') + '.',
    ISSUE_READ,
    '',
    'Use web research (WebSearch / WebFetch -- load via ToolSearch if needed): official docs, engineering',
    'blogs, API references, template galleries. Depth beats breadth: per toolset, find how the feature is',
    'MODELED (entities, fields, versioning), AUTHORED, CONSUMED, and what its docs warn about. Cite every',
    'URL you used in sources. You are one of three independent researchers; do not speculate about our',
    'codebase -- another researcher owns that. Report facts, not recommendations.',
    'Return the structured result; every field is GitHub markdown.',
  ].join('\n')
}

function usecasePrompt() {
  return [
    'You are researching the USE CASES behind a capability, so an adaptation serves real needs instead of',
    'copying surface features. Capability: "' + FEATURE + '" as found in ' +
      (TOOLSETS.length ? TOOLSETS.join(', ') : 'established products') + '.',
    'Context repo (do not modify anything): ' + REPO + ', issue #' + N + '.',
    ISSUE_READ,
    '',
    'Use web research (WebSearch / WebFetch -- load via ToolSearch if needed): user forums, community',
    'template galleries, "how do I" questions, case studies. Answer: what do people actually DO with this',
    'feature? Which 20% carries 80% of the value? What do beginners reach for first? Distill mustHaves',
    'ruthlessly -- a must-have is something whose absence makes the adaptation useless for the named use',
    'cases, not merely something the sources happen to ship.',
    'Return the structured result; every field is GitHub markdown.',
  ].join('\n')
}

function fitPrompt() {
  return [
    'You are researching where a new capability attaches to OUR codebase. Capability: "' + FEATURE + '"',
    'for ' + REPO + ', issue #' + N + '. Work read-only from the checkout at ' + REPO_PATH + '.',
    ISSUE_READ,
    '',
    'Do not write code and do not modify anything. Map, with exact file paths:',
    '- attachPoints: routers, stores, services, schema files the feature must plug into.',
    '- existingPrimitives: anything already there the plan must REUSE (catalogs, stores, builders,',
    '  validation schemas). Duplicating an existing primitive is the classic adaptation failure.',
    '- dataModelNotes: our schema/migration conventions and how the feature maps onto them.',
    '- migrationNotes: which migrations directory owns this feature and the EXACT next free number in it.',
    '  Subsystems own their own numbered dirs; check the right one AND the top-level one, state both',
    '  numbers explicitly -- a wrong migration number has caused collisions before.',
    '- frontendSurfaces: pages/components under web-ui/ where the UI belongs, and their conventions',
    '  (i18n en.json+de.json, vitest __tests__, Lume tokens/theme.css, .lume-* utilities in globals.css).',
    '- constraints: anything in AGENTS.md / CONTRIBUTING.md / CLAUDE.md the plan must respect.',
    'Return the structured result; every field is GitHub markdown.',
  ].join('\n')
}

// ---------------------------------------------------------------------- PLAN

const UNIT_ITEMS = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'title', 'specMd', 'files'],
    properties: {
      id: { type: 'string', description: 'short kebab-case unit id, e.g. b1-template-store' },
      title: { type: 'string' },
      specMd: { ...MD, description: 'full unit spec: what to build, where, API shapes, tests to write' },
      files: { type: 'array', items: { type: 'string' }, description: 'files this unit creates or edits' },
    },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overviewMd', 'backendUnits', 'frontendUnits', 'testPlanMd', 'risksMd', 'outOfScopeMd', 'issueCommentMd'],
  properties: {
    overviewMd: { ...MD, description: 'the design in prose: what is built and why this shape' },
    backendUnits: UNIT_ITEMS,
    frontendUnits: UNIT_ITEMS,
    testPlanMd: MD,
    risksMd: MD,
    outOfScopeMd: { ...MD, description: 'explicitly deferred scope, so reviewers can hold the line' },
    issueCommentMd: { ...MD, description: 'the complete plan comment to post on the issue: English, self-contained, detailed enough to implement from alone' },
  },
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'blockingGaps', 'notes'],
  properties: {
    approved: { type: 'boolean' },
    blockingGaps: { ...MD, description: 'what must change in the plan; empty string if approved' },
    notes: MD,
  },
}

function plannerPrompt(research, revision) {
  return [
    'You are the planning lead for adapting "' + FEATURE + '" onto ' + REPO + ' (issue #' + N + ').',
    'Three researchers have reported (below). Synthesize ONE detailed, buildable implementation plan.',
    'Work read-only from ' + REPO_PATH + ' to verify any file path you cite.',
    ISSUE_READ,
    '',
    '## Planning rules',
    '- Adapt, do not clone: serve the researched use cases with OUR primitives and conventions. Where a',
    '  source toolset\'s design conflicts with our core, our core wins; say so in overviewMd.',
    '- Scope a shippable v1: mustHaves in, niceToHaves in outOfScopeMd with one line of rationale each.',
    '- Split into UNITS: backendUnits (middleware) strictly before frontendUnits (web-ui). Each unit is',
    '  one coherent commit for one dedicated agent: self-contained spec, exact files, API shapes, tests,',
    '  and its own verification. Frontend units consume ONLY what backend units expose.',
    '  ' + MAX_UNITS + ' units maximum in total.',
    '- Frontend unit specs must restate the Lume constraints they touch (state colors text/edge only,',
    '  four button variants, no spinners -- verb + dots, tokens not hex, i18n en+de).',
    '- Use the migration number the core-fit researcher reported; repeat it explicitly in the unit spec.',
    '- issueCommentMd is the plan of record posted to the issue: English, sober technical tone, no emoji,',
    '  carrying the full design (overview, unit list with specs, test plan, risks, out-of-scope) so an',
    '  implementer can work from the comment alone.',
    revision
      ? '\n## Critics rejected your previous plan. Address EVERY blocking gap, then return the full revised plan.\n<<<\n' + revision + '\n>>>'
      : '',
    '',
    '## Research: source implementations',
    JSON.stringify(research.source),
    '',
    '## Research: use cases',
    JSON.stringify(research.usecases),
    '',
    '## Research: core fit',
    JSON.stringify(research.fit),
    '',
    'Return the structured plan.',
  ].join('\n')
}

function criticPrompt(plan, lens) {
  const lensText = lens === 'feasibility'
    ? 'FEASIBILITY vs the actual codebase. Verify claims read-only at ' + REPO_PATH + ': do the attach points ' +
      'exist as described? Is the migration number actually free? Do the units build on each other without gaps ' +
      'or circular needs? Would the named tests actually exercise the behaviour? Is any unit too big for one ' +
      'agent and one commit?'
    : 'COMPLETENESS vs the research. Does the plan serve the researched must-have use cases, or copy surface ' +
      'features? Is anything out-of-scope that the use cases say is load-bearing? Are the Lume/i18n/testing ' +
      'constraints concretely embedded in the frontend unit specs, or just waved at? Is the issue comment truly ' +
      'self-contained?'
  return [
    'You are an adversarial plan critic. REJECT this implementation plan if it deserves it. Assume it is',
    'flawed until it proves otherwise. Your lens: ' + lensText,
    'Repo: ' + REPO + ', issue #' + N + ', feature: "' + FEATURE + '". Do not modify anything.',
    'Approve only if you would bet a review cycle on this plan building cleanly. When uncertain, reject',
    'with precise blockingGaps -- the cost of a false green is a wasted implementation run.',
    '',
    '## The plan',
    JSON.stringify(plan),
  ].join('\n')
}

// ----------------------------------------------------------------------- RUN

phase('Understand')
log('Researching "' + FEATURE + '" in ' + (TOOLSETS.length ? TOOLSETS.join(', ') : 'established toolsets') + ' + our core (3 parallel researchers)')
const [source, usecases, fit] = await parallel([
  () => agent(sourcePrompt(), { label: 'research:sources', phase: 'Understand', schema: SOURCE_SCHEMA }),
  () => agent(usecasePrompt(), { label: 'research:use-cases', phase: 'Understand', schema: USECASE_SCHEMA }),
  () => agent(fitPrompt(), { label: 'research:core-fit', phase: 'Understand', schema: FIT_SCHEMA, effort: 'high' }),
])
if (!source || !usecases || !fit) {
  log('ABORT: a researcher failed (' + [source ? '' : 'sources', usecases ? '' : 'use-cases', fit ? '' : 'core-fit'].filter(Boolean).join(', ') + ') -- planning without its input would be guessing.')
  return { error: 'research-failed', research: { source, usecases, fit } }
}
const research = { source, usecases, fit }

phase('Plan')
let plan = await agent(plannerPrompt(research, null), { label: 'plan:synthesize', phase: 'Plan', schema: PLAN_SCHEMA, effort: 'xhigh' })
if (!plan) return { error: 'plan-failed', research }

const critiques = (await parallel([
  () => agent(criticPrompt(plan, 'feasibility'), { label: 'plan:critic-feasibility', phase: 'Plan', schema: CRITIQUE_SCHEMA, effort: 'high' }),
  () => agent(criticPrompt(plan, 'completeness'), { label: 'plan:critic-completeness', phase: 'Plan', schema: CRITIQUE_SCHEMA, effort: 'high' }),
])).filter(Boolean)
const gaps = critiques.filter((c) => !c.approved).map((c) => c.blockingGaps).join('\n\n')
if (gaps) {
  log('Plan rejected by ' + critiques.filter((c) => !c.approved).length + ' critic(s) -- one revision pass')
  const revised = await agent(plannerPrompt(research, gaps), { label: 'plan:revise', phase: 'Plan', schema: PLAN_SCHEMA, effort: 'xhigh' })
  if (revised) plan = revised
  else log('WARNING: revision agent failed; continuing with the original plan and the critiques attached')
}
const total = plan.backendUnits.length + plan.frontendUnits.length
log('Plan: ' + plan.backendUnits.length + ' backend + ' + plan.frontendUnits.length + ' frontend unit(s); critiques ' + (gaps ? 'forced a revision' : 'approved first pass'))
if (total > MAX_UNITS) log('WARNING: plan has ' + total + ' units, above the ' + MAX_UNITS + '-unit cap; the build stage will drop the tail -- consider splitting the issue')
log('Next: the caller posts issueCommentMd on issue #' + N + ', writes the gitignored plan files, then runs issue-adapt-build. This workflow wrote nothing.')

return { stage: 'plan', issue: N, research, plan, critiques }
