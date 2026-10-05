/**
 * An API-key chat turn ran the model and `query_knowledge_graph`, wrote a
 * privacy receipt and streamed `runTrace` status `success`, yet left no Run in
 * the knowledge graph. Two causes, each pinned here without a database (the
 * Postgres end-to-end readback is `apiKeyRunTrace.pg.test.ts`):
 *
 *   1. The dispatcher maps a `key:<uuid>` caller to `channelKind: 'api'`
 *      (#1107), but the Neon schema's `CHANNEL_KINDS` lacked `'api'`, so the
 *      ChannelIdentity write failed validation and no User-Cluster existed.
 *   2. The run trace was built with the raw `input.userId` (`key:<uuid>`), so
 *      even with a cluster `ingestRun` looked for `user:key:<uuid>`.
 *
 * Imported from SOURCE so a mutation in `src/` cannot pass over stale `dist/`.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ChannelKind as PluginApiChannelKind } from '../packages/plugin-api/src/knowledgeGraph.js';
import {
  CHANNEL_KINDS,
  validateNodeProps,
  type ChannelKind as NeonChannelKind,
} from '../packages/harness-knowledge-graph-neon/src/schema.js';
import { runTraceOwnerId } from '../packages/harness-orchestrator/src/resolveTurnOwnerIdentity.js';

// Compile-time parity (checked by `typecheck:test`): both directions must be
// `never`, or the two unions have drifted apart the way `'api'` did.
type MissingInNeon = Exclude<PluginApiChannelKind, NeonChannelKind>;
type MissingInPluginApi = Exclude<NeonChannelKind, PluginApiChannelKind>;
const neonCoversPluginApi: [MissingInNeon] extends [never] ? true : false = true;
const pluginApiCoversNeon: [MissingInPluginApi] extends [never] ? true : false = true;

const NOW = '2026-10-05T12:00:00.000Z';

describe('API channel identity in the Neon schema', () => {
  it("accepts channelKind 'api' on a ChannelIdentity", () => {
    assert.ok(CHANNEL_KINDS.includes('api'), "CHANNEL_KINDS lost 'api'");
    const props = validateNodeProps('ChannelIdentity', {
      channelKind: 'api',
      channelUserId: 'key:0b6c4c3e-1d2f-4b3a-9c8d-7e6f5a4b3c2d',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    assert.equal(props['channelKind'], 'api');
  });

  it('still rejects a channel kind nobody declared', () => {
    assert.throws(() =>
      validateNodeProps('ChannelIdentity', {
        channelKind: 'carrier-pigeon',
        channelUserId: 'x',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      }),
    );
  });

  it('names exactly the channel kinds plugin-api declares', () => {
    assert.equal(neonCoversPluginApi, true);
    assert.equal(pluginApiCoversNeon, true);
  });
});

describe('runTraceOwnerId', () => {
  const apiTurn = {
    userId: 'key:0b6c4c3e-1d2f-4b3a-9c8d-7e6f5a4b3c2d',
    channelIdentity: { channelKind: 'api' as const, channelUserId: 'key:0b6c4c3e-1d2f-4b3a-9c8d-7e6f5a4b3c2d' },
  };

  it('files a channel turn under the resolved canonical id, not the key id', () => {
    assert.equal(runTraceOwnerId(apiTurn, 'c1a2b3c4-0000-4000-8000-000000000001'), 'c1a2b3c4-0000-4000-8000-000000000001');
  });

  it('files an unresolved channel turn without a user rather than under the raw id', () => {
    assert.equal(runTraceOwnerId(apiTurn, undefined), undefined);
    assert.equal(runTraceOwnerId(apiTurn, ''), undefined);
  });

  it('keeps the session id of a non-channel (browser) turn unchanged', () => {
    assert.equal(runTraceOwnerId({ userId: 'web-user-uuid' }, undefined), 'web-user-uuid');
    assert.equal(runTraceOwnerId({ userId: 'web-user-uuid' }, 'web-user-uuid'), 'web-user-uuid');
    assert.equal(runTraceOwnerId({}, undefined), undefined);
  });
});
