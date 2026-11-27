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
  PROBE_WRITE_SCOPE,
  sweepPluginGraphPool,
  sweepPluginServicesOutsideTurn,
  sweepRegisteredGraphTool,
  sweepTurn,
  type EntryPoint,
  type RecallLimits,
  type Sighting,
  type TurnSweep,
} from './canarySweep.js';
import { PINNED, expected, type Mode } from './oracle.js';
import type { Seeded } from './seed.js';
import {
  AGENTS,
  AGENT_KEYS,
  allViewers,
  buildWorld,
  viewerId,
  type AgentKey,
  type ProcessItem,
  type TurnItem,
} from './world.js';

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
          'plugin-service',
        ];
        // Processes carry no owners: a context-bound strict / members turn reads
        // none, and since #1774 every turn of those modes is context-bound
        // (web turns carry the account origin).
        const processesReadable = mode === 'off' || mode === 'enforce';
        if (backend === 'neon' && processesReadable) expectedEntries.push('process-tool');
        assert.deepEqual([...seen].sort(), expectedEntries.sort());
        const silent = inMode().filter(
          (sweep) => !sweep.sightings.some((s) => s.entry === 'context' && s.verdict.allowed),
        );
        assert.deepEqual(silent.map((s) => viewerId(s.viewer)), [], 'every turn recalls something it may see');
      });

      if (backend === 'neon') {
        it(`${mode}: process writes stay inside the turn's boundary (#2223)`, (t) => {
          if (!seeded) return t.skip('no test database');
          const out = processWriteViolations(seeded, inMode());
          assert.deepEqual(out.violations, [], out.violations.slice(0, 40).join('\n'));
          // Every strict / members turn is context-bound (#1774): none may write.
          if (mode === 'off' || mode === 'enforce') {
            assert.ok(out.allowedEdits > 0, 'CONTROL: a turn edits its own agent\'s process');
            assert.ok(out.allowedWrites > 0, 'CONTROL: a turn writes into its own agent\'s scope');
          } else {
            assert.equal(out.allowedEdits + out.allowedWrites, 0);
          }
        });
      }

      for (const k of known) {
        it(`${mode}: known leak ${k.issue}: ${k.title}`, { todo: k.issue }, (t) => {
          if (!seeded) return t.skip('no test database');
          const leaks = leaksOf(inMode(), k.matches);
          assert.deepEqual(leaks, [], report(leaks));
        });
      }
    }

    if (recall !== 'wide') return;
    // ADR-0044 — outside a turn a plugin's graph services read no turn,
    // session, plan, neighbour or process, and no private memory tree: only
    // the shared `/memories` trees every viewer may read (core, `_*`), and
    // entity nodes, which are global in the tenant (ADR-0040).
    it('outside a turn: a plugin’s graph services return only shared trees and entities', async (t) => {
      if (!seeded) return t.skip('no test database');
      const byCanary = new Map(seeded.world.items.map((i) => [i.canary.toUpperCase(), i]));
      const got = await sweepPluginServicesOutsideTurn(seeded);
      const unshared = got.filter((c) => {
        const item = byCanary.get(c);
        if (item?.store === 'entity') return false;
        return !(item?.store === 'scratch' && (item.tier === 'core' || item.tier === 'rules'));
      });
      assert.deepEqual(unshared, []);
      assert.ok(got.length > 0, 'CONTROL: the shared trees are read');
    });
    // ADR-0255 — a granted plugin's borrowed graphPool names no kernel table.
    // Neon only: the in-memory backend has no pool.
    if (backend === 'neon') {
      it('graphPool: a granted plugin reads no kernel graph or process table', async (t) => {
        if (!seeded?.pool) return t.skip('no test database');
        assert.deepEqual(await sweepPluginGraphPool(seeded), []);
        assert.ok((await sweepPluginGraphPool(seeded, true)).length > 0, 'CONTROL: the raw pool reads the canaries');
      });
    }
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

/**
 * #2223 — what the write probe got through: an edit may reach the store only
 * for a process the turn may read (the shield aside: under a shield an
 * unprotected process is withheld from the answer, not from its agent), a
 * write only in this agent's scopes and only where its processes are
 * readable at all; the unqualified probe scope is qualified with the agent.
 */
function processWriteViolations(
  seeded: Seeded,
  sweeps: readonly TurnSweep[],
): { violations: string[]; allowedEdits: number; allowedWrites: number } {
  const processById = new Map(
    seeded.world.byStore.process.map((p) => [seeded.location.get(p.canary), p] as const),
  );
  const violations: string[] = [];
  let allowedEdits = 0;
  let allowedWrites = 0;
  for (const sweep of sweeps) {
    const log = sweep.processWrites;
    if (!log) continue;
    const who = `${viewerId(sweep.viewer)} ${sweep.mode}`;
    for (const id of log.edited) {
      const item = processById.get(id);
      if (item && expected(sweep.viewer, sweep.mode, { ...item, unprotected: false }).allowed) {
        allowedEdits += 1;
      } else {
        violations.push(`${who}: edit_process reached the store for ${id}`);
      }
    }
    const own: ProcessItem = {
      store: 'process',
      canary: '',
      tenant: sweep.viewer.tenant,
      agent: sweep.viewer.agent,
      context: sweep.viewer.context,
      sender: sweep.viewer.user,
      unprotected: false,
    };
    const mayWrite = expected(sweep.viewer, sweep.mode, own).allowed;
    const prefix = `${AGENTS[sweep.viewer.agent]}::`;
    for (const scope of log.written) {
      if (mayWrite && scope === `${prefix}${PROBE_WRITE_SCOPE}`) allowedWrites += 1;
      else violations.push(`${who}: write_process reached the store with scope ${scope}`);
    }
  }
  return { violations, allowedEdits, allowedWrites };
}
