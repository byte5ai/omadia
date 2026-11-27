/**
 * Memory-ACL plan, step 4c — the memory defaults, pinned.
 *
 * These defaults decide who reads what on a deployment nobody configured:
 * whether turns become memories on their own, whether recall shares `team`
 * knowledge tenant-wide, what visibility a memory gets when its writer names
 * none, how chat contexts bound recall. The access matrix runs with the
 * values below; a default that changes underneath it changes production
 * behaviour while every ACL suite stays green.
 *
 * The values sit inline in plugin activation code and migrations, so the
 * pin reads the source. A failure means a default changed or moved. If the
 * change is intended: update the expected value here, add a CHANGELOG entry
 * that names the privacy effect, and check the oracle (`oracle.ts`) still
 * describes the new default. Never update it to get green.
 *
 * "pinned, not decided": auto-promotion, the team-visibility default, the
 * scratch reaper and the context-memory fallback are what the code does
 * today; no ADR decides them (memory-ACL plan, rules).
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ORCHESTRATOR = 'packages/harness-orchestrator/src/plugin.ts';
const EXTRAS = 'packages/harness-orchestrator-extras/src/plugin.ts';

interface Pin {
  readonly name: string;
  readonly file: string;
  /** Matched against the file with every whitespace run collapsed to one space. */
  readonly pattern: RegExp;
  /** The first capture group. */
  readonly expected: string;
  readonly meaning: string;
}

const PINS: readonly Pin[] = [
  {
    name: 'KG_ACL_AUTO_PROMOTE',
    file: ORCHESTRATOR,
    pattern: /process\.env\['KG_ACL_AUTO_PROMOTE'\] === undefined \? (\w+) :/,
    expected: 'true',
    meaning: 'significant turns become memories without anyone saving them (pinned, not decided)',
  },
  {
    name: 'KG_ACL_AUTO_PROMOTE_THRESHOLD',
    file: ORCHESTRATOR,
    pattern: /process\.env\['KG_ACL_AUTO_PROMOTE_THRESHOLD'\], ([\d.]+),/,
    expected: '0.7',
    meaning: 'significance a turn needs to be promoted',
  },
  {
    name: 'KG_DURABLE_AUTOPROMOTE',
    file: ORCHESTRATOR,
    pattern: /process\.env\['KG_DURABLE_AUTOPROMOTE'\] === undefined \? (\w+) :/,
    expected: 'true',
    meaning: 'high-significance reference memories become manually authored (always surfaced)',
  },
  {
    name: 'KG_DURABLE_AUTOPROMOTE_MIN_SIGNIFICANCE',
    file: ORCHESTRATOR,
    pattern: /process\.env\['KG_DURABLE_AUTOPROMOTE_MIN_SIGNIFICANCE'\], ([\d.]+),/,
    expected: '0.85',
    meaning: 'significance for durable auto-promotion',
  },
  {
    name: 'KG_RECALL_TEAM_VISIBILITY',
    file: EXTRAS,
    pattern:
      /const teamVisibility = typeof teamVisibilityRaw === 'string' \? teamVisibilityRaw\.toLowerCase\(\) !== 'false' : teamVisibilityRaw !== (\w+);/,
    expected: 'false',
    meaning: 'on unless set to false: recall admits team/public knowledge tenant-wide (pinned, not decided)',
  },
  {
    name: 'kg_auto_merge_enabled',
    file: EXTRAS,
    pattern:
      /const autoMergeDisabled = typeof autoMergeEnabledRaw === 'string' \? autoMergeEnabledRaw\.toLowerCase\(\) === 'false' : autoMergeEnabledRaw === (\w+);/,
    expected: 'false',
    meaning: 'on unless set to false: near-duplicate memories are merged without review',
  },
  {
    name: 'kg_auto_merge_threshold',
    file: EXTRAS,
    pattern: /ctx\.config\.get<unknown>\('kg_auto_merge_threshold'\), ([\d.]+),/,
    expected: '0.9',
    meaning: 'similarity at which two memories merge',
  },
  {
    name: 'scratch_promotion_enabled',
    file: EXTRAS,
    pattern: /const scratchPromotionEnabled = (parseBool\w+)\(/,
    expected: 'parseBoolDefaultTrue',
    meaning: 'agent scratch memory is promoted into the graph (pinned, not decided)',
  },
  {
    name: 'scratch_promotion_age_hours',
    file: EXTRAS,
    pattern: /ctx\.config\.get<unknown>\('scratch_promotion_age_hours'\), ([\d.]+),/,
    expected: '24',
    meaning: 'age at which scratch memory is promoted',
  },
  {
    name: 'scratch_promotion_drop_unpromoted',
    file: EXTRAS,
    pattern: /const scratchPromotionDropUnpromoted = (parseBool\w+)\(/,
    expected: 'parseBoolDefaultFalse',
    meaning: 'scratch that was not promoted is kept',
  },
  {
    name: 'OMADIA_INJECTIVE_SCOPE_KEYS',
    file: 'packages/harness-orchestrator/src/sessionLogger.ts',
    pattern: /return process\.env\['OMADIA_INJECTIVE_SCOPE_KEYS'\] === '(\w+)';/,
    expected: '1',
    meaning: "off unless '1': scope keys stay lossy (#575 Phase 2 decides)",
  },
  {
    name: 'memorable knowledge visibility (Neon)',
    file: 'packages/harness-knowledge-graph-neon/src/neonKnowledgeGraph.ts',
    pattern: /visibility: input\.visibility \?\? '(\w+)',/,
    expected: 'private',
    meaning: 'a memory written without visibility is private (#1823, ADR-0183)',
  },
  {
    name: 'memorable knowledge visibility (in-memory)',
    file: 'packages/harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.ts',
    pattern: /visibility: input\.visibility \?\? '(\w+)',/,
    expected: 'private',
    meaning: 'a memory written without visibility is private (#1823, ADR-0183)',
  },
  {
    name: 'contextMemory fallback without an agent row',
    file: 'packages/harness-orchestrator/src/buildOrchestrator.ts',
    pattern: /mode: config\.contextMemory \?\? '([\w-]+)',/,
    expected: 'off',
    meaning: 'an orchestrator built without a context-memory mode does not bound recall (pinned, not decided)',
  },
];

const collapsed = (file: string): string =>
  readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ');

describe('memory defaults (memory-ACL plan step 4c)', () => {
  for (const pin of PINS) {
    it(`${pin.name} = ${pin.expected} (${pin.meaning})`, () => {
      const match = pin.pattern.exec(collapsed(pin.file));
      assert.ok(
        match,
        `the default of ${pin.name} is no longer where this pin reads it (${pin.file}). Find it, re-pin it by hand, and say in the CHANGELOG whether it changed.`,
      );
      assert.equal(
        match[1],
        pin.expected,
        `the default of ${pin.name} changed (${pin.meaning}). Intended? Update this pin, the CHANGELOG and the oracle together.`,
      );
    });
  }

  it("agents.context_memory defaults to 'members' for new agent rows", () => {
    // The newest core migration that sets the column default wins.
    const dir = path.join(ROOT, 'migrations');
    let last: { file: string; value: string } | undefined;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      const set =
        /ALTER COLUMN context_memory SET DEFAULT '([\w-]+)'/.exec(sql) ??
        /ADD COLUMN IF NOT EXISTS context_memory TEXT NOT NULL DEFAULT '([\w-]+)'/.exec(sql);
      if (set) last = { file, value: set[1]! };
    }
    assert.ok(last, 'no migration sets agents.context_memory');
    assert.equal(last.value, 'members', `${last.file} changed the context-memory default`);
  });

  it('no plugin manifest overrides these defaults', () => {
    // A manifest setup default would win over the code default above.
    const keys = [
      'kg_recall_team_visibility',
      'kg_auto_merge_enabled',
      'kg_auto_merge_threshold',
      'scratch_promotion_enabled',
      'scratch_promotion_age_hours',
      'scratch_promotion_drop_unpromoted',
    ];
    const found: string[] = [];
    const packages = path.join(ROOT, 'packages');
    for (const pkg of readdirSync(packages)) {
      let manifest: string;
      try {
        manifest = readFileSync(path.join(packages, pkg, 'manifest.yaml'), 'utf8');
      } catch {
        continue;
      }
      for (const key of keys) if (manifest.includes(key)) found.push(`${pkg}: ${key}`);
    }
    assert.deepEqual(found, [], 'a manifest names a memory default; pin its value here');
  });
});
