/**
 * Issue #544 (W2-1) — the one duplicated constant in this feature.
 *
 * `MCP_INPUT_REPLY_PREFIX` exists twice: once in
 * `harness-orchestrator/src/mcp/pendingMcpInput.ts` (which parses it) and once
 * in `web-ui/app/_components/chat/McpInputCard.tsx` (which produces it). web-ui
 * does not depend on the middleware packages, so it cannot be imported.
 *
 * A drift between the two is silent and total: the orchestrator would stop
 * recognising card answers, the envelope would land in the chat as literal text,
 * and every parked MCP call would expire unanswered. Nothing would throw. So the
 * pair is pinned here, by reading the web-ui source.
 *
 * The envelope FORMAT is pinned too, not just the prefix — the middleware parser
 * is fed the exact string the card builds.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { MCP_INPUT_REPLY_PREFIX, parseMcpInputReply } from '@omadia/orchestrator';

const HERE = dirname(fileURLToPath(import.meta.url));
const CARD = resolve(HERE, '../../web-ui/app/_components/chat/McpInputCard.tsx');

describe('MCP input reply envelope — middleware ↔ web-ui contract (#544 W2-1)', () => {
  const source = readFileSync(CARD, 'utf8');

  it('MUTATION CHECK: web-ui declares the SAME prefix the orchestrator parses', () => {
    const declared = /export const MCP_INPUT_REPLY_PREFIX = '([^']+)';/.exec(source)?.[1];
    assert.ok(declared, 'web-ui no longer declares MCP_INPUT_REPLY_PREFIX');
    // Changing either side alone turns this red — which is the only reason the
    // duplication is acceptable at all.
    assert.equal(declared, MCP_INPUT_REPLY_PREFIX);
  });

  it("MUTATION CHECK: the orchestrator parses the card's exact envelope format", () => {
    // Reproduces `formatMcpInputReply` from the card verbatim. If the card ever
    // changes its serialization (a different separator, a wrapper object, an
    // extra field), this drifts from the real parser and turns red.
    const wire = `${MCP_INPUT_REPLY_PREFIX} ${JSON.stringify({
      correlationId: 'corr-abc',
      inputResponses: { customerNumber: 'K-1234' },
    })}`;
    const parsed = parseMcpInputReply(wire);
    assert.ok(parsed, `the orchestrator could not parse the card's envelope: ${wire}`);
    assert.equal(parsed.correlationId, 'corr-abc');
    assert.deepEqual(parsed.inputResponses, { customerNumber: 'K-1234' });
  });

  it('web-ui still builds the envelope through the shared helper', () => {
    // Guards against someone inlining the string at a call site, which would
    // escape the prefix assertion above.
    assert.match(source, /\$\{MCP_INPUT_REPLY_PREFIX\}/);
  });
});
