/**
 * #2067 (K6.3, the contract step) — the first majors of the facilitator
 * services are no longer provided.
 *
 * `agentTurn`, `conversationMessages` and `conversationSend` each got a second
 * major next to the first (K4). A plugin asks for the second by its versioned
 * name; the bare name means the first major and now answers nothing.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { publishAgentTurnService } from '../src/agents/agentTurnWiring.js';
import { publishSendServices } from '../src/channels/sendServicesWiring.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';

const ENGINE = { pluginId: '@omadia/agent-facilitator' } as never;

describe('#2067 the first majors are gone, the second majors and the single-major services stay', () => {
  it('agentTurn: only `agentTurn@2` is provided', () => {
    const serviceRegistry = new ServiceRegistry();
    publishAgentTurnService({
      serviceRegistry,
      getRegistry: () => undefined,
      engineSources: () => ({ installedRegistry: undefined, catalog: undefined }),
      maxTurnsPerMinute: 60,
      log: () => undefined,
    });
    assert.equal(serviceRegistry.get('agentTurn', ENGINE), undefined);
    assert.equal(typeof (serviceRegistry.get('agentTurn@2', ENGINE) as { runTurn?: unknown } | undefined)?.runTurn, 'function');
  });

  it('conversationSend: only `conversationSend@2` is provided; `targetedSend` has one major and stays', () => {
    const serviceRegistry = new ServiceRegistry();
    publishSendServices({
      serviceRegistry,
      targeted: { sendToPrincipal: () => Promise.reject(new Error('not used')) } as never,
      conversation: { sendToConversation: () => Promise.reject(new Error('not used')) } as never,
      scoped: { executionFor: () => undefined, direct: {} as never },
    });
    assert.equal(serviceRegistry.get('conversationSend', ENGINE), undefined);
    assert.equal(typeof (serviceRegistry.get('conversationSend@2', ENGINE) as { sendToConversation?: unknown } | undefined)?.sendToConversation, 'function');
    assert.equal(typeof (serviceRegistry.get('targetedSend', ENGINE) as { sendToPrincipal?: unknown } | undefined)?.sendToPrincipal, 'function');
  });
});
