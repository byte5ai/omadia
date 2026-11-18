import { describe, expect, it } from 'vitest';

import { loadAgentTeamsTargets, type AgentTeamsTargetsDto } from '../agents';

/**
 * #2043 rollout (D8): with 725 chats the picker showed "loading …" for the
 * whole session. The loader asks again while the server is still enumerating
 * and always ends in a state the picker can show.
 */
const base = { ok: true, agent: 'mara', provisioner_installed: true } as const;
const LOADING: AgentTeamsTargetsDto = {
  ...base,
  teams: { available: false, reason: 'loading' },
  chats: { available: false, reason: 'loading' },
};
const READY: AgentTeamsTargetsDto = {
  ...base,
  teams: { available: true, items: [{ id: 't1', displayName: 'Team' }] },
  chats: { available: true, items: [], total: 725, truncated: true },
};

function run(answers: readonly (AgentTeamsTargetsDto | Error)[], maxPolls = 40) {
  const updates: AgentTeamsTargetsDto[] = [];
  let calls = 0;
  const done = loadAgentTeamsTargets('mara', {
    onUpdate: (dto) => updates.push(dto),
    isCancelled: () => false,
    maxPolls,
    sleep: () => Promise.resolve(),
    fetchTargets: () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as AgentTeamsTargetsDto);
    },
  });
  return { done, updates, calls: () => calls };
}

describe('loadAgentTeamsTargets', () => {
  it('asks again while the server says loading, shows that state meanwhile, and stops when it is ready', async () => {
    const h = run([LOADING, LOADING, READY]);
    await h.done;
    expect(h.calls()).toBe(3);
    expect(h.updates.map((u) => (u.chats.available ? 'ready' : u.chats.reason))).toEqual([
      'loading',
      'loading',
      'ready',
    ]);
  });

  it('a server that never finishes ends as "could not be loaded", not as loading forever', async () => {
    const h = run([LOADING], 5);
    await h.done;
    expect(h.calls()).toBe(5);
    const last = h.updates.at(-1);
    expect(last?.teams).toEqual({ available: false, reason: 'lookup_failed' });
    expect(last?.chats).toEqual({ available: false, reason: 'lookup_failed' });
  });

  it('a failing request is a visible state too', async () => {
    const h = run([new Error('504')]);
    await h.done;
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.chats).toEqual({ available: false, reason: 'lookup_failed' });
  });

  it('one half may be ready while the other is still loading', async () => {
    const half: AgentTeamsTargetsDto = { ...LOADING, teams: READY.teams };
    const h = run([half, READY]);
    await h.done;
    expect(h.updates[0]?.teams.available).toBe(true);
    expect(h.calls()).toBe(2);
  });
});
