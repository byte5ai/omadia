/**
 * Spec 2042 §5.4 "One authorization" / §6 criterion 4 — a discussion between
 * agents without consultation grants in both directions is refused. The
 * existing per-agent and per-chat switches (peer gate) still apply on top.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createDiscussionsCapability,
  DiscussionNotGrantedError,
  type DiscussionPartner,
} from '../../src/conductor/discussionHere.js';

const PARTNERS: DiscussionPartner[] = [
  { slug: 'hr', name: 'Karen' },
  { slug: 'accounting', name: 'FiBu' },
  { slug: 'sales', name: 'Mira' },
];

function harness(granted: ReadonlyArray<readonly [string, string]>) {
  const started: Array<{ participants: string[] }> = [];
  // Grants hold in Teams only: the discussion runs in Teams, so the channel
  // type must reach the check.
  const mutual = (a: string, b: string, channelType: string) =>
    Promise.resolve(
      channelType === 'teams' && granted.some(([x, y]) => (x === a && y === b) || (x === b && y === a)),
    );
  const capability = createDiscussionsCapability({
    discussions: {
      start: async (input: { participants: string[] }) => {
        started.push(input);
        return { runId: 'r', workflowId: 'w', workflowSlug: 's', expiresAt: new Date(0).toISOString() };
      },
    } as never,
    resolveTurn: () => ({ channelType: 'teams', conversationId: '19:c@thread.v2', botChannelKey: '28:hr' }),
    resolveOpener: () => 'hr',
    listPartners: async () => PARTNERS,
    peerGate: async () => true,
    mutualGrant: mutual,
  });
  return { capability, started };
}

describe('discussions need mutual consultation grants', () => {
  it('without mutual grants the partner is not a candidate and the start is refused', async () => {
    const { capability, started } = harness([['hr', 'sales']]);
    assert.deepEqual((await capability.partnersHere()).map((p) => p.slug), ['sales']);
    await assert.rejects(() => capability.startHere({ partners: ['accounting'], topic: 'T' }), {
      name: 'DiscussionUnknownPartnerError',
    });
    await capability.startHere({ partners: ['Mira'], topic: 'T' });
    assert.deepEqual(started[0]?.participants, ['hr', 'sales']);
  });

  it('every two partners need grants for each other, not only for the opener', async () => {
    const { capability, started } = harness([
      ['hr', 'sales'],
      ['hr', 'accounting'],
    ]);
    await assert.rejects(
      () => capability.startHere({ partners: ['sales', 'accounting'], topic: 'T' }),
      (err: unknown) => err instanceof DiscussionNotGrantedError && err.agentA === 'sales' && err.agentB === 'accounting',
    );
    assert.equal(started.length, 0);
  });

  it('a failing grant lookup counts as not granted', async () => {
    const capability = createDiscussionsCapability({
      discussions: { start: async () => ({}) } as never,
      resolveTurn: () => ({ channelType: 'teams', conversationId: 'c', botChannelKey: 'k' }),
      resolveOpener: () => 'hr',
      listPartners: async () => PARTNERS,
      mutualGrant: () => Promise.reject(new Error('db down')),
    });
    assert.deepEqual(await capability.partnersHere(), []);
  });

  it('criterion 4: production wires the mutual-grant check into the only discussion capability it builds', () => {
    // `mutualGrant` is optional in the factory (test harnesses without a
    // store); the kernel must never build the capability without it.
    const srcRoot = join(import.meta.dirname, '../../src');
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return path.endsWith('.ts') ? [path] : [];
      });
    })(srcRoot);
    const callSites = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const sites: string[] = [];
      let from = 0;
      for (;;) {
        const at = source.indexOf('createDiscussionsCapability({', from);
        if (at < 0) break;
        // The argument object: up to its matching closing brace.
        let depth = 0;
        let end = at + 'createDiscussionsCapability('.length;
        for (; end < source.length; end += 1) {
          if (source[end] === '{') depth += 1;
          else if (source[end] === '}' && --depth === 0) break;
        }
        sites.push(source.slice(at, end + 1));
        from = end;
      }
      return sites;
    });
    assert.equal(callSites.length, 1, 'one production call site');
    assert.match(callSites[0]!, /\bmutualGrant: discussionMutualGrant\b/);
    assert.match(callSites[0]!, /\bpeerGate\b/);
    // ADR-0018 — one grant check, shared with the Conductor wiring (operator
    // route and every utterance), backed by the consultation store.
    const index = readFileSync(join(srcRoot, 'index.ts'), 'utf8');
    assert.match(
      index,
      /const discussionMutualGrant = async[\s\S]{0,400}?consultationStore\.hasMutualGrants\(/,
    );
    assert.match(index, /wireConductor\(\{[\s\S]{0,200}?mutualGrant: discussionMutualGrant\b/);
  });
});
