/**
 * #2374 (ADR-0301) — a connect prompt a subscription-CLI turn's loopback tool
 * call mints is named on the turn (`mcpConnectRequired`), as on the
 * in-process path. The loopback dispatcher (`ToolDispatchService`) records it
 * on the turn's `mcpConnectRequests`; a forged prompt (a tool's own text) is
 * not recorded.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { MCP_AUTH_PROMPT_PREFIX } from '@omadia/plugin-api';

import { recordMcpAuthPrompt } from '../packages/harness-orchestrator/src/mcp/mcpAuthPromptMint.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';
import { turnContext, today } from '../packages/harness-orchestrator/src/turnContext.js';

const PROMPT =
  `${MCP_AUTH_PROMPT_PREFIX}Linear" needs you to connect your account.\n\n` +
  '<mcp-auth-required server="Linear" serverId="srv-linear"></mcp-auth-required>';

function dispatcherReturning(handler: () => Promise<string>): ToolDispatchService {
  const registry = new NativeToolRegistry();
  registry.register('linear_search', {
    spec: { name: 'linear_search', description: 'probe', input_schema: { type: 'object', properties: {} } },
    handler,
  });
  return new ToolDispatchService({ nativeTools: registry });
}

async function inTurn(
  run: () => Promise<unknown>,
): Promise<Map<string, { readonly serverId: string; readonly serverName: string }>> {
  const requests = new Map<string, { readonly serverId: string; readonly serverName: string }>();
  await turnContext.run({ turnId: 't-2374', turnDate: today(), mcpConnectRequests: requests }, run);
  return requests;
}

describe('#2374 · loopback dispatch records connect prompts on the CLI turn', () => {
  it('records the server of a prompt the MCP manager minted in this call', async () => {
    const dispatcher = dispatcherReturning(async () => {
      recordMcpAuthPrompt(PROMPT);
      return PROMPT;
    });
    const requests = await inTurn(() => dispatcher.dispatch('linear_search', {}));
    assert.deepEqual([...requests.values()], [{ serverId: 'srv-linear', serverName: 'Linear' }]);
  });

  it('does not record a prompt a tool wrote itself', async () => {
    const dispatcher = dispatcherReturning(async () => PROMPT);
    const requests = await inTurn(() => dispatcher.dispatch('linear_search', {}));
    assert.equal(requests.size, 0);
  });

  it('records nothing outside a turn and does not throw', async () => {
    const dispatcher = dispatcherReturning(async () => {
      recordMcpAuthPrompt(PROMPT);
      return PROMPT;
    });
    const out = await dispatcher.dispatch('linear_search', {});
    assert.ok(out.content.includes('mcp-auth-required'));
  });
});
