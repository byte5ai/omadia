/**
 * Spec 2042 §5.2 / INV-7 — `agentEnvelope@1`: the envelope of one agent, by
 * id, for a system module working on its behalf (the canvas presentation
 * helper). A lookup without a model; an agent that cannot serve has no
 * envelope, and no other agent is ever handed out in its place. Only system
 * modules get the service.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { AGENT_ENVELOPE_SERVICE_NAME, type AgentEnvelopeResolver } from '@omadia/plugin-api';

import {
  AgentEnvelopeRefusedError,
  agentEnvelopeService,
  createAgentEnvelopeResolver,
} from '../src/platform/agentEnvelopeService.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';

const agents = {
  'id-mira': { agent: { id: 'id-mira', status: 'enabled' }, built: { bundle: { agent: 'mira-chat' } } },
  'id-off': { agent: { id: 'id-off', status: 'disabled' }, built: { bundle: { agent: 'off-chat' } } },
} as const;
const source = { getById: (id: string) => agents[id as keyof typeof agents] };

describe('agentEnvelope@1', () => {
  it('resolves an enabled agent by id to its own chat agent', () => {
    const resolver = createAgentEnvelopeResolver(() => source);
    assert.deepEqual(resolver.resolve('id-mira'), { agentId: 'id-mira', agent: 'mira-chat' });
  });

  it('has no envelope for an unknown, disabled or empty id, and none without a registry', () => {
    const resolver = createAgentEnvelopeResolver(() => source);
    assert.equal(resolver.resolve('id-unknown'), undefined);
    assert.equal(resolver.resolve('id-off'), undefined);
    assert.equal(resolver.resolve(''), undefined);
    assert.equal(createAgentEnvelopeResolver(() => undefined).resolve('id-mira'), undefined);
  });

  it('never answers with another agent', () => {
    const lying = { getById: () => agents['id-mira'] };
    assert.equal(createAgentEnvelopeResolver(() => lying).resolve('id-other'), undefined);
  });

  it('is given to system modules only', () => {
    const kinds: Record<string, string> = {
      '@omadia/ui-orchestrator': 'system-module',
      '@omadia/legacy-ext': 'extension',
      '@acme/tool': 'tool',
    };
    const registry = new ServiceRegistry();
    registry.provide(AGENT_ENVELOPE_SERVICE_NAME, agentEnvelopeService((id) => kinds[id] as never, () => source));
    const caller = (id: string) => ({ agentId: id, pluginId: id });
    const forHelper = registry.get<AgentEnvelopeResolver>(AGENT_ENVELOPE_SERVICE_NAME, caller('@omadia/ui-orchestrator'));
    assert.equal(forHelper?.resolve('id-mira')?.agentId, 'id-mira');
    assert.ok(registry.get(AGENT_ENVELOPE_SERVICE_NAME, caller('@omadia/legacy-ext')));
    for (const id of ['@acme/tool', '@acme/unknown']) {
      assert.throws(
        () => registry.get(AGENT_ENVELOPE_SERVICE_NAME, caller(id)),
        (err: unknown) => err instanceof AgentEnvelopeRefusedError,
        id,
      );
    }
  });
});
