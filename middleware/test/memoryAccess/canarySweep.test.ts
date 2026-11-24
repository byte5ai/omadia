/**
 * Memory-ACL plan step 3 — canary sweep through real turns.
 *
 * Every viewer of the world runs one real turn per context-memory mode
 * (`canarySweep.ts`). A canary the oracle forbids that reaches the model —
 * in the recalled context, a memory-tool result or a graph-tool result — is
 * a leak. Positive controls: each mode delivers allowed canaries through each
 * entry point, so an empty response cannot pass.
 *
 * Two confirmed leaks are known failures (`todo`), each with its issue. Their
 * fix PRs turn them into ordinary tests; nothing else may leak.
 */
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { seedInMemory } from './backends.js';
import {
  sweepRegisteredGraphTool,
  sweepTurn,
  type EntryPoint,
  type Sighting,
  type TurnSweep,
} from './canarySweep.js';
import { MODES, PINNED, expected, type Mode } from './oracle.js';
import type { Seeded } from './seed.js';
import { AGENT_KEYS, allViewers, buildWorld, viewerId, type TurnItem } from './world.js';

/** #2204 — `query_knowledge_graph` reads the whole tenant in off/enforce. */
const KG_TOOL_TENANT_WIDE = (mode: Mode, s: Sighting): boolean =>
  s.entry === 'graph-tool' && (mode === 'off' || mode === 'enforce');

/** #2205 — the strict durable recall leg admits private memories. */
const STRICT_DURABLE_LEG = (mode: Mode, s: Sighting): boolean => {
  if (mode !== 'enforce-strict' || s.entry !== 'context') return false;
  const mk =
    s.item.store === 'memorable-knowledge'
      ? s.item
      : s.item.store === 'excerpt'
        ? s.item.parent
        : undefined;
  return mk !== undefined && mk.authorship !== 'conversation';
};

/**
 * Pinned, not decided: a tail-only turn is "not knowledge", but the plugin
 * API says it "MUST remain visible to getSession()" and that a backend
 * ignoring the flag "stays correct". It is no access rule: through a session
 * read, a tail-only turn is visible exactly when the same turn without the
 * flag would be.
 */
function verdictOf(sweep: TurnSweep, s: Sighting): { allowed: boolean; source: string } {
  if (s.item.store === 'turn' && s.item.tailOnly && s.entry === 'graph-tool') {
    const asKnowledge: TurnItem = { ...s.item, tailOnly: false };
    const v = expected(sweep.viewer, sweep.mode, asKnowledge);
    return { allowed: v.allowed, source: `${PINNED}: tail-only is no access rule for session reads; ${v.source}` };
  }
  return s.verdict;
}

function leaksOf(sweeps: readonly TurnSweep[], known?: (mode: Mode, s: Sighting) => boolean) {
  const out: string[] = [];
  for (const sweep of sweeps) {
    for (const s of sweep.sightings) {
      if (verdictOf(sweep, s).allowed) continue;
      if (known && !known(sweep.mode, s)) continue;
      out.push(`${viewerId(sweep.viewer)} ${sweep.mode} ${s.entry}: ${s.canary} (${s.item.store}) — ${s.verdict.source}`);
    }
  }
  return out;
}

function report(leaks: readonly string[]): string {
  return `${String(leaks.length)} forbidden canar${leaks.length === 1 ? 'y' : 'ies'}:\n${leaks.slice(0, 40).join('\n')}`;
}

describe('memory access — canary sweep through real turns', () => {
  let seeded: Seeded;
  const sweeps: TurnSweep[] = [];

  before(async () => {
    seeded = await seedInMemory(buildWorld());
    for (const viewer of allViewers()) {
      for (const mode of MODES) sweeps.push(await sweepTurn(seeded, viewer, mode));
    }
  });

  for (const mode of MODES) {
    it(`${mode}: no forbidden canary reaches the model, apart from the known leaks`, () => {
      const inMode = sweeps.filter((s) => s.mode === mode);
      const leaks = leaksOf(inMode, (m, s) => !KG_TOOL_TENANT_WIDE(m, s) && !STRICT_DURABLE_LEG(m, s));
      assert.deepEqual(leaks, [], report(leaks));
    });

    it(`${mode}: CONTROL — every entry point delivers allowed canaries`, () => {
      const inMode = sweeps.filter((s) => s.mode === mode);
      const seen = new Set<EntryPoint>();
      for (const sweep of inMode) {
        for (const s of sweep.sightings) if (verdictOf(sweep, s).allowed) seen.add(s.entry);
      }
      assert.deepEqual([...seen].sort(), ['context', 'graph-tool', 'memory-tool']);
      const silent = inMode.filter((sweep) => !sweep.sightings.some((s) => s.entry === 'context' && s.verdict.allowed));
      assert.deepEqual(silent.map((s) => viewerId(s.viewer)), [], 'every turn recalls something it may see');
    });
  }

  it('known leak #2204: query_knowledge_graph stays within the agent and the user in off/enforce', { todo: '#2204' }, () => {
    const leaks = leaksOf(sweeps, KG_TOOL_TENANT_WIDE);
    assert.deepEqual(leaks, [], report(leaks));
  });

  it('known leak #2205: enforce-strict recalls no private memory through the durable leg', { todo: '#2205' }, () => {
    const leaks = leaksOf(sweeps, STRICT_DURABLE_LEG);
    assert.deepEqual(leaks, [], report(leaks));
  });

  for (const mode of ['enforce-strict', 'members'] as const) {
    it(`${mode}: the CLI-path registration of query_knowledge_graph returns no canary`, async () => {
      for (const agent of AGENT_KEYS) {
        assert.deepEqual(await sweepRegisteredGraphTool(seeded, agent, mode), []);
      }
    });
  }

  it('known leak #2204: the CLI-path registration returns no canary in off/enforce', { todo: '#2204' }, async () => {
    for (const mode of ['off', 'enforce'] as const) {
      for (const agent of AGENT_KEYS) {
        assert.deepEqual(await sweepRegisteredGraphTool(seeded, agent, mode), [], `${mode} ${agent}`);
      }
    }
  });
});
