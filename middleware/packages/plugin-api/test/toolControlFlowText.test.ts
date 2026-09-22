/**
 * #1097 — `isControlFlowToolResult` decides which tool results bypass the
 * Privacy Shield's interning. Four dispatch seams consult it
 * (`Orchestrator.dispatchTool`, `Orchestrator.guardReplayResult`,
 * `ToolDispatchService.afterDispatch`, `LocalSubAgent.dispatch`), so a
 * predicate that drifts from the real message shapes silently re-opens the
 * defect at all four.
 *
 * The fixtures below are copied from their PRODUCERS — the app layer builds
 * the auth prompts (`middleware/src/index.ts` `onAuthFailure`,
 * `middleware/src/services/mcpDelegation.ts` `delegationBlockedMessage`) and
 * `McpManager`/tool handlers build the `Error:` strings — because this package
 * sits below both and cannot import them. If a producer's wording changes, the
 * pin here is what fails.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { isControlFlowToolResult } from '../src/index.js';

/** `middleware/src/index.ts` — OAuth-protected server, authorization started. */
const AUTH_PROMPT_CONNECT =
  '🔒 The MCP server "Strava" needs authorization before it can be used. Ask the ' +
  'user to click Connect (this opens the provider\'s login), then retry: ' +
  'https://example.test/oauth/authorize?x=1\n' +
  '<mcp-auth-required serverId="s-1" server="Strava" host="www.strava.com" needsClient="false"></mcp-auth-required>';

/** `middleware/src/index.ts` — delegating server with no registered client. */
const AUTH_PROMPT_NEEDS_CLIENT =
  '🔒 The MCP server "Strava" needs authorization, but it isn\'t set up yet. Click ' +
  'Connect to register it — it delegates OAuth to www.strava.com, which needs a ' +
  'one-time app registration.\n' +
  '<mcp-auth-required serverId="s-1" server="Strava" needsClient="true"></mcp-auth-required>';

/** `mcpDelegation.ts` — per-user server with no caller identity. Carries NO
 *  machine block, so only the prefix identifies it. */
const DELEGATION_BLOCKED =
  '🔒 The MCP server "HR Payroll" is set to per-user delegation, but this ' +
  'conversation has no mapped user identity, so there is no one to act as. ' +
  'Nothing was sent to the server. Either sign in through a channel that maps ' +
  'your identity, or have an operator switch this server to a shared service ' +
  'identity in the MCP Control Center.';

describe('#1097 — isControlFlowToolResult', () => {
  it('recognizes the `Error:` tool-error convention', () => {
    assert.equal(isControlFlowToolResult('Error: session_summary requires `scope`.'), true);
    assert.equal(
      isControlFlowToolResult(
        'Error: embeddings not configured — use `search_turns` for keyword-based search instead.',
      ),
      true,
    );
  });

  it('recognizes every MCP auth prompt shape the app layer produces', () => {
    assert.equal(isControlFlowToolResult(AUTH_PROMPT_CONNECT), true);
    assert.equal(isControlFlowToolResult(AUTH_PROMPT_NEEDS_CLIENT), true);
    assert.equal(
      isControlFlowToolResult(DELEGATION_BLOCKED),
      true,
      'the delegation-blocked prompt carries no <mcp-auth-required> block — the prefix must carry it',
    );
  });

  it('recognizes an auth block that arrives without the prefix', () => {
    // A sub-agent's narration can bubble the machine block up inside other
    // prose; the block is what the Connect card is parsed from.
    assert.equal(
      isControlFlowToolResult(
        'Der Server meldet: <mcp-auth-required serverId="s-1" server="Strava"></mcp-auth-required>',
      ),
      true,
    );
  });

  it('leaves ordinary data results alone — they stay interned', () => {
    assert.equal(isControlFlowToolResult('{"rows":[{"name":"Erika Mustermann"}]}'), false);
    assert.equal(isControlFlowToolResult('Keine Treffer.'), false);
    // Near-misses: the convention is a PREFIX, not a substring.
    assert.equal(
      isControlFlowToolResult('Der Bericht listet 3 Error: Codes aus dem Ticketsystem.'),
      false,
      'a row that merely mentions "Error:" mid-string is data, not control flow',
    );
    assert.equal(isControlFlowToolResult('{"status":"error","rows":[]}'), false);
  });
});
