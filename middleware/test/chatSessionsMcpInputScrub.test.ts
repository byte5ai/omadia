import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { formatMcpInputReply } from '@omadia/orchestrator';

import { scrubMcpInputEnvelopes } from '../src/routes/chatSessions.js';

/**
 * #1953 — an MCP input-card answer must not be persisted with its values. The
 * PUT route replaces the envelope with the field-names-only label before the
 * store sees the document.
 */
describe('scrubMcpInputEnvelopes (#1953)', () => {
  const base = { id: 's-1', title: 'Chat', createdAt: 1, updatedAt: 2 };

  it('replaces an envelope with the field-names label, dropping every value', () => {
    const envelope = formatMcpInputReply({
      correlationId: 'corr-1',
      inputResponses: { apiKey: 'sk-very-secret', region: 'eu' },
    });
    const scrubbed = scrubMcpInputEnvelopes({
      ...base,
      messages: [{ id: 'm1', role: 'user', content: envelope, startedAt: 1 }],
    });
    const content = scrubbed.messages[0]?.content ?? '';
    assert.doesNotMatch(content, /sk-very-secret|eu\b|__mcp_input_reply__/);
    assert.match(content, /apiKey, region/);
  });

  it('leaves ordinary and assistant messages untouched (same object)', () => {
    const session = {
      ...base,
      messages: [
        { id: 'm1', role: 'user' as const, content: 'hello', startedAt: 1 },
        { id: 'm2', role: 'assistant' as const, content: '__mcp_input_reply__ {}', startedAt: 2 },
      ],
    };
    assert.equal(scrubMcpInputEnvelopes(session), session);
  });
});
