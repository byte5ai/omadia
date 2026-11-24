/**
 * Memory-ACL plan step 3 — the canary sweep as a test suite, one file per
 * mode (`canarySweep*.test.ts`) so no file comes near the per-file timeout.
 *
 * Every viewer runs one real turn (`canarySweep.ts`). A canary the oracle
 * forbids that reaches the model or the client is a leak. Positive controls:
 * each entry point delivers allowed canaries, and every turn recalls
 * something it may see, so an empty response cannot pass.
 *
 * Confirmed leaks are known failures (`todo`), each with its issue. Their fix
 * PRs turn them into ordinary tests; nothing else may leak.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { seedInMemory } from './backends.js';
import {
  sweepRegisteredGraphTool,
  sweepTurn,
  type EntryPoint,
  type RecallLimits,
  type Sighting,
  type TurnSweep,
} from './canarySweep.js';
import { PINNED, expected, type Mode } from './oracle.js';
import type { Seeded } from './seed.js';
import { AGENT_KEYS, allViewers, buildWorld, viewerId, type AgentKey, type TurnItem } from './world.js';

interface KnownLeak {
  readonly issue: string;
  readonly title: string;
  /** Where it was confirmed; anywhere else the same sighting fails the suite. */
  readonly modes: readonly Mode[];
  readonly recall: RecallLimits | 'any';
  readonly backend?: Backend;
  readonly matches: (sweep: TurnSweep, s: Sighting) => boolean;
}

export const KNOWN_LEAKS: readonly KnownLeak[] = [
];

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
    return {
      allowed: v.allowed,
      source: `${PINNED}: tail-only is no access rule for session reads; ${v.source}`,
    };
  }
  return s.verdict;
}

function leaksOf(
  sweeps: readonly TurnSweep[],
  keep: (sweep: TurnSweep, s: Sighting) => boolean,
): string[] {
  const out: string[] = [];
  for (const sweep of sweeps) {
    for (const s of sweep.sightings) {
      if (verdictOf(sweep, s).allowed || !keep(sweep, s)) continue;
      out.push(
        `${viewerId(sweep.viewer)} ${sweep.mode} ${s.entry}: ${s.canary} (${s.item.store}) — ${s.verdict.source}`,
      );
    }
  }
  return out;
}

function report(leaks: readonly string[]): string {
  return `${String(leaks.length)} forbidden canar${leaks.length === 1 ? 'y' : 'ies'}:\n${leaks.slice(0, 40).join('\n')}`;
}

/** `neon` adds process memory, which only Neon has, and its tools. */
export type Backend = 'memory' | 'neon';

export interface SweepSetup {
  readonly seeded: Seeded;
  readonly teardown: () => Promise<void>;
}

export interface SweepOptions {
  readonly recall?: RecallLimits;
  readonly backend?: Backend;
  /** Seeds the world; `undefined` skips the suite (no test database). */
  readonly setup?: () => Promise<SweepSetup | undefined>;
  /**
   * Only these agents' viewers run turns. The other agents' items stay
   * seeded, so cross-agent reads are still probed; the agents are symmetric
   * in the world. Default: all agents.
   */
  readonly viewerAgents?: readonly AgentKey[];
}

export function canarySweepSuite(modes: readonly Mode[], options: SweepOptions = {}): void {
  const recall = options.recall ?? 'wide';
  const backend = options.backend ?? 'memory';
  const setup =
    options.setup ??
    (async (): Promise<SweepSetup> => ({
      seeded: await seedInMemory(buildWorld()),
      teardown: async () => undefined,
    }));
  describe(`memory access — canary sweep (${modes.join(', ')}; ${recall} recall; ${backend})`, () => {
    let seeded: Seeded | undefined;
    let teardown: (() => Promise<void>) | undefined;
    const sweeps: TurnSweep[] = [];

    before(async () => {
      const ready = await setup();
      if (!ready) return;
      ({ seeded, teardown } = ready);
      const agents = options.viewerAgents ?? AGENT_KEYS;
      for (const viewer of allViewers().filter((v) => agents.includes(v.agent))) {
        for (const mode of modes) sweeps.push(await sweepTurn(ready.seeded, viewer, mode, recall));
      }
    });
    after(async () => {
      await teardown?.();
    });

    for (const mode of modes) {
      const inMode = (): TurnSweep[] => sweeps.filter((s) => s.mode === mode);
      const known = KNOWN_LEAKS.filter(
        (k) =>
          k.modes.includes(mode) &&
          (k.recall === 'any' || k.recall === recall) &&
          (k.backend === undefined || k.backend === backend),
      );

      it(`${mode}: no forbidden canary reaches the model or the client, apart from the known leaks`, (t) => {
        if (!seeded) return t.skip('no test database');
        const leaks = leaksOf(inMode(), (sweep, s) => !known.some((k) => k.matches(sweep, s)));
        assert.deepEqual(leaks, [], report(leaks));
      });

      it(`${mode}: CONTROL — the entry points deliver allowed canaries`, (t) => {
        if (!seeded) return t.skip('no test database');
        const seen = new Set<EntryPoint>();
        for (const sweep of inMode()) {
          for (const s of sweep.sightings) if (verdictOf(sweep, s).allowed) seen.add(s.entry);
        }
        // Production recall keeps only the top hits; the tools are probed the same way.
        const expectedEntries: EntryPoint[] = [
          'client-stream',
          'context',
          'graph-tool',
          'memory-tool',
          'plugin-accessor',
          'plugin-neighbors',
        ];
        if (backend === 'neon') expectedEntries.push('process-tool');
        assert.deepEqual([...seen].sort(), expectedEntries.sort());
        const silent = inMode().filter(
          (sweep) => !sweep.sightings.some((s) => s.entry === 'context' && s.verdict.allowed),
        );
        assert.deepEqual(silent.map((s) => viewerId(s.viewer)), [], 'every turn recalls something it may see');
      });

      for (const k of known) {
        it(`${mode}: known leak ${k.issue}: ${k.title}`, { todo: k.issue }, (t) => {
          if (!seeded) return t.skip('no test database');
          const leaks = leaksOf(inMode(), k.matches);
          assert.deepEqual(leaks, [], report(leaks));
        });
      }
    }

    if (recall !== 'wide') return;
    for (const mode of modes) {
      // The kernel-native registration of the graph tool (subscription-CLI
      // path) knows no turn. Positive control: the in-turn graph tool above
      // reads the same graph.
      it(
        `${mode}: the CLI-path registration of query_knowledge_graph returns no canary`,
        async (t) => {
          if (!seeded) return t.skip('no test database');
          for (const agent of AGENT_KEYS) {
            assert.deepEqual(await sweepRegisteredGraphTool(seeded, agent, mode), [], agent);
          }
        },
      );
    }
  });
}
