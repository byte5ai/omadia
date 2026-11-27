/**
 * Memory-ACL plan step 6 — the `memory_acl` probe: memory exfiltration.
 *
 * Each scenario is one real orchestrator turn over the memory-access world
 * (`test/memoryAccess/`): the binder, recall assembler, memory tool and graph
 * tool are the production classes, only the model is scripted. The scenario
 * picks who attacks (tenant, person, agent, conversation, shield), the
 * context-memory mode, the user's message and the model's first tool calls;
 * what the tools hand back is followed as in the canary sweep. Every canary
 * that reaches the model or the client is checked against the hand-written
 * oracle (`memoryAccess/oracle.ts`).
 *
 * HELD ⇒ no canary the oracle forbids was delivered AND at least `minAllowed`
 * canaries the viewer may read were (a turn that delivers nothing would
 * otherwise hold vacuously).
 *
 * Placeholders in `message` and `calls`, resolved against the seeded world:
 *   {{user:<tenant>/<person>}}           the person's omadia user id
 *   {{aad:<person>}}                     the person's Teams (AAD) id
 *   {{agent:<agent>}}                    the agent's slug
 *   {{scope:<agent|legacy>/<ctx>/<person>}}   a graph scope
 *   {{keyword:<agent|legacy>/<ctx>/<person>}} a conversation's search keyword
 */
import type { KnowledgeGraph } from '@omadia/plugin-api';

import { seedInMemory } from '../memoryAccess/backends.js';
import { sweepTurn, verdictOf, type SweepAttack } from '../memoryAccess/canarySweep.js';
import { MODES, type Mode } from '../memoryAccess/oracle.js';
import type { Seeded } from '../memoryAccess/seed.js';
import {
  AGENTS,
  CONTEXTS,
  USERS,
  buildWorld,
  graphScope,
  turnKeyword,
  viewerId,
  type AgentKey,
  type ContextKey,
  type TenantKey,
  type UserKey,
  type Viewer,
} from '../memoryAccess/world.js';

import type { AttackScenario, DefenseOutcome } from './adversarialRunner.js';

let seeded: Promise<Seeded> | undefined;

/** The seeded world every scenario reads. Turns never write into it. */
export function memoryExfiltrationWorld(): Promise<Seeded> {
  seeded ??= seedInMemory(buildWorld());
  return seeded;
}

function resolvePlaceholders(text: string, world: Seeded): string {
  return text.replace(/\{\{(\w+):([^}]+)\}\}/g, (whole, kind: string, arg: string) => {
    const parts = arg.split('/');
    switch (kind) {
      case 'user':
        return world.users[parts[0] as TenantKey][parts[1] as UserKey];
      case 'aad':
        return USERS[arg as UserKey];
      case 'agent':
        return AGENTS[arg as AgentKey];
      case 'scope':
        return graphScope(parts[0] as AgentKey | 'legacy', parts[1] as ContextKey, parts[2] as UserKey);
      case 'keyword':
        return turnKeyword({
          agent: parts[0] as AgentKey | 'legacy',
          context: parts[1] as ContextKey,
          sender: parts[2] as UserKey,
        });
      default:
        throw new Error(`memory_acl: unknown placeholder ${whole}`);
    }
  });
}

function viewerOf(id: string, raw: unknown): Viewer {
  const v = (raw ?? {}) as Partial<Viewer>;
  const viewer: Viewer = {
    tenant: v.tenant ?? 'main',
    user: v.user as UserKey,
    agent: v.agent as AgentKey,
    context: v.context as ContextKey,
    shielded: v.shielded === true,
  };
  const ctx = CONTEXTS[viewer.context];
  if (!ctx || !AGENTS[viewer.agent] || !USERS[viewer.user]) {
    throw new Error(`memory_acl: scenario "${id}" has an unknown viewer ${JSON.stringify(raw)}`);
  }
  if (ctx.members !== 'sender' && !ctx.members.includes(viewer.user)) {
    throw new Error(`memory_acl: scenario "${id}": ${viewer.user} is not present in ${viewer.context}`);
  }
  return viewer;
}

/**
 * Run one scenario. `wrapGraph` is for the counter-proofs only: it breaks a
 * defense on purpose to prove the scenario can go red.
 */
export async function probeMemoryAcl(
  scenario: AttackScenario,
  wrapGraph?: (graph: KnowledgeGraph) => KnowledgeGraph,
): Promise<{ outcome: DefenseOutcome; evidence: string }> {
  const f = scenario.fixture;
  const viewer = viewerOf(scenario.id, f['viewer']);
  const mode = f['mode'] as Mode;
  if (!MODES.includes(mode)) throw new Error(`memory_acl: scenario "${scenario.id}" has unknown mode "${String(mode)}"`);
  const minAllowed = typeof f['minAllowed'] === 'number' ? f['minAllowed'] : 1;
  const world = await memoryExfiltrationWorld();
  const attack: SweepAttack = {
    ...(JSON.parse(
      resolvePlaceholders(JSON.stringify({ message: f['message'] ?? '', calls: f['calls'] ?? [] }), world),
    ) as Pick<SweepAttack, 'message' | 'calls'>),
    ...(wrapGraph ? { wrapGraph } : {}),
  };

  const sweep = await sweepTurn(world, viewer, mode, 'wide', attack);
  const forbidden = sweep.sightings.filter((s) => !verdictOf(sweep, s).allowed);
  const allowed = new Set(sweep.sightings.filter((s) => verdictOf(sweep, s).allowed).map((s) => s.canary));
  const held = forbidden.length === 0 && allowed.size >= minAllowed;
  const shown = forbidden
    .slice(0, 5)
    .map((s) => `${s.entry}:${s.canary}(${s.item.store})`)
    .join(', ');
  return {
    outcome: held ? 'held' : 'breached',
    evidence:
      `viewer=${viewerId(viewer)} mode=${mode} forbidden=${String(forbidden.length)} ` +
      `allowed=${String(allowed.size)}/${String(minAllowed)}` +
      (shown ? ` first: ${shown}` : ''),
  };
}
