/**
 * Wave decomposition workflow (Claude Code "Workflow" tool script).
 *
 * Turns a wave spec into a conflict-checked unit manifest that
 * scripts/wave-implement.workflow.mjs can execute.
 *
 * A unit is one acceptance criterion, or the smallest coherent file-set that
 * satisfies one. Not a file (a unit legitimately spans a migration, a types file,
 * and a store), and not a wave (too coarse to review or parallelize). The specs
 * already contain the decomposition: the acceptance checklist says what must be
 * true, the file table says which files, and the test plan says which test proves
 * it. This workflow extracts and joins those three; it does not invent structure.
 *
 * WHY THE REDUCE IS A BARRIER. Extraction can be sharded -- one agent per group of
 * acceptance criteria. Building the dependsOn graph cannot: a single agent must see
 * every unit at once to decide what depends on what. So parallel() (a barrier) is
 * correct here, and pipeline() would be wrong.
 *
 * WHY COLLISION DETECTION IS PLAIN CODE. It must be stable across runs and it is a
 * set intersection, not a judgement. Hub files -- index.ts, config.ts, messages/*.json --
 * are append-only registration points touched by nearly every unit; left in the
 * signal, every unit reads as dependent and the fan-out collapses to one sequential
 * chain. They are subtracted, and the manifest assigns all hub edits to one wiring
 * unit that dependsOn everything else. A merge conflict becomes a dependency edge.
 *
 * The workflow writes nothing. It returns a manifest; the caller shows it to a human
 * (approve / re-decompose / edit the graph), persists it, and only then implements.
 * A Workflow script cannot call AskUserQuestion -- that is exactly why this is a
 * separate script from wave-implement.
 *
 *   Workflow({ scriptPath: "scripts/wave-decompose.workflow.mjs", args: {
 *     wave:      "W0",
 *     specUrl:   "https://github.com/byte5ai/omadia/issues/470#issuecomment-...",
 *     specText:  "<the full spec markdown>",   // or specPath
 *     repoPath:  "/abs/path/to/checkout",
 *     baseSha:   "<sha>",
 *     epic:      470,
 *     verifyCommand: "npm run build --workspace middleware",
 *     hubFiles:  ["middleware/src/index.ts", "middleware/src/config.ts"]
 *   }})
 */

export const meta = {
  name: 'wave-decompose',
  description: 'Extract a reviewed unit manifest from a wave spec (units, touches, dependsOn, acceptance)',
  whenToUse: 'Before wave-implement, whenever a wave has a prose spec but no unit manifest yet.',
  phases: [
    { title: 'Extract', detail: 'parallel extractors: units, file-sets, dependency edges' },
    { title: 'Reduce', detail: 'one agent merges extractions into a single manifest' },
  ],
}

const HUB_MIN_UNITS = 3;
const HUB_FRACTION = 0.1;

const input = typeof args === 'string' ? JSON.parse(args) : args;
const {
  wave,
  specUrl,
  specText,
  specPath,
  repoPath,
  baseSha,
  epic,
  verifyCommand = 'npm run build',
  hubFiles: declaredHubs = [],
} = input ?? {};

if (!wave) throw new Error('wave-decompose: wave is required');
if (!specText && !specPath && !specUrl) throw new Error('wave-decompose: one of specText/specPath/specUrl is required');

const specRef = specText ? '(inline, passed in args)' : (specPath ?? specUrl);

const UNIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['units'],
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'acceptance', 'touches', 'verifiedBy', 'securitySensitive'],
        properties: {
          id: { type: 'string', description: `kebab-case, prefixed \`${wave.toLowerCase()}-\`` },
          title: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' }, description: 'verbatim from the spec checklist' },
          touches: { type: 'array', items: { type: 'string' }, description: 'file paths or globs, from the spec file table' },
          verifiedBy: { type: 'string', description: 'the test file from the spec test plan that proves this unit' },
          securitySensitive: { type: 'boolean' },
          longContext: { type: 'boolean', description: 'true if the unit needs the whole module in context at once' },
          notes: { type: 'string', description: 'implementation constraints stated in the spec that an implementer would otherwise miss' },
        },
      },
    },
  },
};

const MANIFEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['units'],
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'acceptance', 'touches', 'dependsOn', 'verifiedBy', 'securitySensitive'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          touches: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
          verifiedBy: { type: 'string' },
          securitySensitive: { type: 'boolean' },
          longContext: { type: 'boolean' },
          notes: { type: 'string' },
        },
      },
    },
    wiringUnitId: { type: 'string', description: 'the unit that owns every hub-file edit; dependsOn all others' },
  },
};

// Extraction groups. Each agent reads the same spec but is told which slice to own,
// so the union covers the wave without three agents extracting the same unit.
const GROUPS = [
  { id: 'schema-and-core', focus: 'the migration, shared types, the store, and any single-choke-point helper' },
  { id: 'io-and-routes', focus: 'HTTP routers, external API clients, credential/vault handling, and background workers' },
  { id: 'runner-and-ui', focus: 'anything running outside the middleware process (packages/*, sidecars) and every web-ui surface' },
];

function extractPrompt(group) {
  return [
    `Extract implementation units from the ${wave} spec of epic #${epic ?? '?'}.`,
    ``,
    `## The spec`,
    `${specRef}`,
    specText ? `\n---\n${specText}\n---\n` : `Read it in full before extracting. If it is a GitHub comment, fetch it with \`gh api\`.`,
    ``,
    `## Your slice`,
    `Extract only units belonging to: **${group.focus}**.`,
    `Another agent covers the rest. Do not extract units outside your slice; overlap costs more than a gap.`,
    ``,
    `## What a unit is`,
    `One acceptance criterion, or the smallest coherent file-set that satisfies one. A unit that spans`,
    `a migration plus the types file plus the store is fine. A unit that is "implement the wave" is not.`,
    `A unit that is "edit one file" usually is not either — group by what a single test proves.`,
    ``,
    `## Where the fields come from — do not invent them`,
    `- \`acceptance\`: verbatim lines from the spec's acceptance-criteria checklist.`,
    `- \`touches\`: paths from the spec's new/modified files table. Narrow, not \`src/**\`.`,
    `- \`verifiedBy\`: the test file named in the spec's test plan for this unit.`,
    `- \`securitySensitive\`: true for anything touching credentials, tokens, egress, isolation,`,
    `  authorization, or the diff/apply path.`,
    `- \`longContext\`: true when the whole module must fit in context at once (an image + daemon +`,
    `  compose topology, a pipeline touching another subsystem).`,
    `- \`notes\`: constraints the spec states that an implementer would otherwise miss. Quote them.`,
    ``,
    `Ground every unit in ${repoPath}: check that the paths in \`touches\` are consistent with the`,
    `real tree (a file may not exist yet, but its directory and neighbours should make sense).`,
    `If the spec names a path that contradicts the repo, say so in \`notes\` — that is spec drift and`,
    `the humans need to know before implementation, not during.`,
  ].join('\n');
}

function reducePrompt(drafts) {
  return [
    `Build the dependency graph for wave ${wave} from these extracted units.`,
    ``,
    JSON.stringify(drafts, null, 2),
    ``,
    `## Your job`,
    `1. De-duplicate. Two agents may have extracted the same unit under different ids; merge them.`,
    `2. Set \`dependsOn\` for every unit. An edge exists when unit B cannot be written or tested`,
    `   without unit A's types, tables, or interfaces. Edges are for real compile/test dependencies,`,
    `   not for narrative order. Fewer edges means more parallelism, so do not add one out of caution.`,
    `3. Identify the **wiring unit** — the one that edits the process entrypoint and config. It`,
    `   \`dependsOn\` every other unit and owns every hub-file edit, so parallel units never collide`,
    `   there. If no such unit was extracted, create it.`,
    `4. Reject cycles. If two units depend on each other, they are one unit; merge them.`,
    ``,
    `Return the complete unit list with \`dependsOn\` filled in. Do not drop \`notes\`, \`acceptance\`,`,
    `\`touches\`, \`verifiedBy\`, \`securitySensitive\`, or \`longContext\` from the extracted units.`,
  ].join('\n');
}

// ---------------------------------------------------------------- helpers

/** A hub file is touched by so many units that it carries no coupling information.
 *  Same heuristic as issue-cluster's findHubFiles. */
function findHubFiles(units) {
  const counts = new Map();
  for (const u of units) for (const t of u.touches ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const threshold = Math.max(HUB_MIN_UNITS, Math.ceil(units.length * HUB_FRACTION));
  const detected = [...counts.entries()].filter(([, n]) => n >= threshold).map(([t]) => t);
  return [...new Set([...declaredHubs, ...detected])];
}

function nonHub(touches, hubs) {
  return (touches ?? []).filter((t) => !hubs.includes(t));
}

function intersects(a, b) {
  const bs = new Set(b);
  return a.some((x) => bs.has(x));
}

// ---------------------------------------------------------------- main

phase('Extract');

// parallel(): a barrier is correct. The reduce needs every unit at once to build the
// dependsOn graph — decomposition cannot be sharded across a pipeline.
const drafts = (
  await parallel(
    GROUPS.map((g) => () =>
      agent(extractPrompt(g), {
        label: `extract:${g.id}`,
        phase: 'Extract',
        agentType: 'Explore',
        schema: UNIT_SCHEMA,
      }),
    ),
  )
)
  .filter(Boolean)
  .flatMap((r) => r.units ?? []);

log(`extracted ${drafts.length} draft unit(s) from ${GROUPS.length} slices`);

phase('Reduce');

const reduced = await agent(reducePrompt(drafts), {
  label: 'dag+wiring',
  phase: 'Reduce',
  agentType: 'Plan',
  schema: MANIFEST_SCHEMA,
  effort: 'high',
});

const units = reduced?.units ?? [];
if (!units.length) throw new Error('wave-decompose: reduce returned no units');

// Collision detection in code, not in an agent: it must be stable across runs.
const hubs = findHubFiles(units);
for (const u of units) {
  u.collidesWith = units
    .filter((v) => v.id !== u.id && intersects(nonHub(u.touches, hubs), nonHub(v.touches, hubs)))
    .map((v) => v.id);
}

const colliding = units.filter((u) => u.collidesWith.length);
const parallelizable = units.filter((u) => !u.collidesWith.length && !(u.dependsOn ?? []).length);

log(`${units.length} unit(s); ${hubs.length} hub file(s) excluded from the collision signal`);
log(`${parallelizable.length} can fan out immediately; ${colliding.length} collide on non-hub files`);
if (reduced.wiringUnitId) log(`wiring unit: ${reduced.wiringUnitId}`);

// The caller asks the human to approve this manifest, persists it, and only then
// runs wave-implement. This workflow writes nothing and touches no remote.
return {
  wave,
  epic,
  specUrl,
  baseSha,
  verifyCommand,
  hubFiles: hubs,
  wiringUnitId: reduced.wiringUnitId,
  units,
};
