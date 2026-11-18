// Shared setup of the facilitator kernel contract suite (#2068): one schema
// per test file with the whole core migration series, a fresh kernel per test
// and the small builders the tests share.

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import type { ChatTurnInput, ConversationMessageEvent } from '@omadia/channel-sdk';
import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import {
  bootFacilitatorKernel,
  CHANNEL_PLUGIN,
  CHANNEL_TYPE,
  type FacilitatorKernel,
} from './facilitatorKernelHarness.js';
import type { RecordedSend } from './facilitatorKernelTypes.js';
import { probePgTest } from './pgTestDb.js';

export const CHAT = '19:offsite@thread.v2';
export const ANNA = '5f0c1a2b-0000-4000-8000-00000000a11a';
export const BEN = '5f0c1a2b-0000-4000-8000-00000000be11';
export const NEUTRALITY = '## Neutrality contract (fixed, takes precedence)';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export interface ContractContext {
  pool: Pool;
  /** The kernel of the current test; a test may replace it (a restart). */
  k: FacilitatorKernel;
  scope(agentSlug: string, conversationId?: string): { agentSlug: string; channelType: string; conversationId: string };
  /** A platform event as the simulated channel emits it, one second later each call. */
  event(over: Partial<ConversationMessageEvent>, botKey: string): ConversationMessageEvent;
  /** A turn the channel adapter starts for a mention in the group chat. */
  groupMention(text: string, conversationId?: string): ChatTurnInput;
  /** A facilitator with its own identity, present in the chat. Returns its bot key. */
  facilitator(slug: string, appId: string): Promise<string>;
  /** What the simulated channel recorded. Read through a call, so a "nothing
   *  was sent" assertion does not narrow the array's type afterwards. */
  sent(): RecordedSend[];
  flush(): Promise<void>;
}

/** Declare a contract suite: `define` registers the tests against `c`. */
export async function contractSuite(
  name: string,
  label: string,
  define: (c: ContractContext) => void,
): Promise<void> {
  const { url, reachable } = await probePgTest({
    label,
    vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
    timeoutMs: 1_500,
  });
  const schema = `${label.toLowerCase()}_${String(process.pid)}`;

  describe(name, { skip: !reachable }, () => {
    let clock = Date.parse('2026-11-18T09:00:00.000Z');
    const c = {
      scope: (agentSlug: string, conversationId = CHAT) => ({
        agentSlug,
        channelType: CHANNEL_TYPE,
        conversationId,
      }),
      event(over: Partial<ConversationMessageEvent>, botKey: string): ConversationMessageEvent {
        clock += 1000;
        return {
          channelId: CHANNEL_PLUGIN,
          channelType: CHANNEL_TYPE,
          conversationId: CHAT,
          conversationType: 'group',
          receivedByChannelKey: botKey,
          messageId: 'm1',
          revision: 0,
          kind: 'created',
          author: { kind: 'teams-aad', id: ANNA, displayName: 'Anna Köhler' },
          text: 'A > C > B',
          occurredAt: new Date(clock).toISOString(),
          ...over,
        };
      },
      groupMention: (text: string, conversationId = CHAT): ChatTurnInput => ({
        userMessage: text,
        userId: ANNA,
        channelIdentity: { channelKind: 'teams' as never, channelUserId: ANNA },
        sessionScope: `teams-${conversationId}`,
        origin: {
          channelType: CHANNEL_TYPE,
          scope: { kind: 'conversation', conversationId: `teams-${conversationId}` },
          // The platform's own statement; without it the turn is a private one.
          conversationType: 'group',
        },
      }),
      async facilitator(slug: string, appId: string): Promise<string> {
        const created = await c.k.api('POST', '/agents', { slug, name: slug, kind: 'facilitator' });
        assert.equal(created.status, 201, JSON.stringify(created.json));
        const key = await c.k.provisionIdentity(slug, appId);
        c.k.channel.botAdded(CHAT);
        return key;
      },
      sent: (): RecordedSend[] => c.k.channel.sent,
      flush: (): Promise<void> => new Promise((r) => setTimeout(r, 25)),
    } as ContractContext;

    before(async () => {
      const bootstrap = new Pool({ connectionString: url, max: 1 });
      await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await bootstrap.query(`CREATE SCHEMA ${schema}`);
      await bootstrap.end();
      c.pool = new Pool({ connectionString: url, max: 6, options: `-c search_path=${schema},public` });
      // The whole core series, through the runner the kernel boots with.
      await runMultiOrchestratorMigrations(c.pool, undefined, MIGRATIONS_DIR);
    });

    after(async () => {
      await c.k?.stop();
      await c.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.pool.end();
    });

    beforeEach(async () => {
      await c.k?.stop();
      await c.pool.query('UPDATE multi_orchestrator_settings SET fallback_agent_id = NULL');
      await c.pool.query('DELETE FROM agent_teams_identities');
      await c.pool.query('DELETE FROM agents');
      c.k = await bootFacilitatorKernel({ pool: c.pool });
      c.k.channel.rosters.set(CHAT, {
        conversationType: 'group',
        partial: false,
        participants: [
          { userRef: { kind: 'teams-aad', id: ANNA, displayName: 'Anna Köhler' } },
          { userRef: { kind: 'teams-aad', id: BEN, displayName: 'Ben' } },
        ],
      });
    });

    define(c);
  });
}
