import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { createRoutinesIntegration } from '../src/plugins/routines/integration.js';
import type { RoutinesHandle } from '../src/plugins/routines/initRoutines.js';
import { bindingKeyForTurn, canonicalizePrincipalId } from '../src/conductor/principalId.js';
import { ConductorChannelBindingStore } from '../src/conductor/channelBindingStore.js';
import { routineTurnContext } from '../src/plugins/routines/routineTurnContext.js';

// Conductor real-world P2a — the routines turn-capture seam forwards an optional `principalRef` to
// `onTurnCaptured` so the kernel can key the Conductor channel binding by an operator-addressable id
// (Teams: the user's email) instead of the channel-native id (AAD object id). This is what lets a
// reminder/approval addressed to `jane@co` reach Jane's Teams conversation.

type Captured = { userId: string; principalRef?: string; channel: string; conversationRef: unknown };

// captureRoutineTurn only touches the per-turn ALS + the onTurnCaptured observer — the handle's
// runner is never dereferenced on this path, so a bare stub suffices.
const stubHandle = {} as unknown as RoutinesHandle;

describe('createRoutinesIntegration onTurnCaptured principalRef (P2a)', () => {
  it('forwards principalRef so the binding is keyed by the operator-addressable id', () => {
    const seen: Captured[] = [];
    const integ = createRoutinesIntegration(stubHandle, (info) => seen.push(info));
    integ.captureRoutineTurn({
      tenant: 't1',
      userId: 'aad-object-id-123',
      principalRef: 'jane@co',
      channel: 'teams',
      conversationRef: { conversation: { id: 'c1' } },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.userId, 'aad-object-id-123');
    assert.equal(seen[0]?.principalRef, 'jane@co'); // binding upserts by this (index.ts: principalRef ?? userId)
    assert.equal(seen[0]?.channel, 'teams');
  });

  it('forwards undefined principalRef when the channel omits it (binding falls back to userId)', () => {
    const seen: Captured[] = [];
    const integ = createRoutinesIntegration(stubHandle, (info) => seen.push(info));
    integ.captureRoutineTurn({
      tenant: 't1',
      userId: 'aad-object-id-123',
      channel: 'teams',
      conversationRef: {},
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.principalRef, undefined);
    assert.equal(seen[0]?.userId, 'aad-object-id-123');
  });

  it('a throwing onTurnCaptured never breaks the inbound turn', () => {
    const integ = createRoutinesIntegration(stubHandle, () => {
      throw new Error('binding store down');
    });
    assert.doesNotThrow(() =>
      integ.captureRoutineTurn({ tenant: 't1', userId: 'u', channel: 'teams', conversationRef: {} }),
    );
  });
});

// #1086 — `beginRoutineTurn` is the scoped sibling of `captureRoutineTurn`: same
// principal, same Conductor binding, but an ALS scope that EXITS. The generic
// producer in CoreApi goes through it so non-Teams channels get both halves —
// a principal for `manage_routine` AND a channel binding for reminders.
describe('createRoutinesIntegration beginRoutineTurn (#1086)', () => {
  it('exposes the principal for the duration of fn and clears it afterwards', async () => {
    const integ = createRoutinesIntegration(stubHandle);
    const conversationRef = { kind: 'channel', channelId: 'de.byte5.channel.telegram', conversationId: 'c9' };

    const inside = await integ.beginRoutineTurn({
      tenant: 't1',
      userId: 'tg-42',
      channel: 'telegram',
      conversationRef,
    })(async () => routineTurnContext.current());

    assert.deepEqual(inside, {
      tenant: 't1',
      userId: 'tg-42',
      channel: 'telegram',
      conversationRef,
      canTargetOthers: false,
    });
    assert.equal(routineTurnContext.current(), undefined);
  });

  it('fires the Conductor binding observer exactly like captureRoutineTurn', async () => {
    const seen: Captured[] = [];
    const integ = createRoutinesIntegration(stubHandle, (info) => seen.push(info));

    await integ.beginRoutineTurn({
      tenant: 't1',
      userId: 'tg-42',
      principalRef: 'jane@co',
      channel: 'telegram',
      conversationRef: { c: 1 },
    })(async () => undefined);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.principalRef, 'jane@co');
    assert.equal(seen[0]?.channel, 'telegram');
    assert.deepEqual(seen[0]?.conversationRef, { c: 1 });
  });

  // A streamed turn invokes the runner once per pull. The binding is a
  // per-TURN fact and a Postgres write; firing it per event would put one
  // upsert on every text delta of every turn on every channel.
  it('writes the binding ONCE per turn, however many segments the turn has', async () => {
    const seen: Captured[] = [];
    const integ = createRoutinesIntegration(stubHandle, (info) => seen.push(info));

    const run = integ.beginRoutineTurn({
      tenant: 't1',
      userId: 'tg-42',
      channel: 'telegram',
      conversationRef: { c: 1 },
    });
    for (let i = 0; i < 5; i += 1) {
      await run(async () => routineTurnContext.current());
    }

    assert.equal(seen.length, 1);
  });

  it('clears the scope even when fn throws', async () => {
    const integ = createRoutinesIntegration(stubHandle);
    await assert.rejects(
      integ.beginRoutineTurn({ tenant: 't1', userId: 'u', channel: 'telegram', conversationRef: {} })(async () => {
        throw new Error('turn failed');
      }),
      /turn failed/,
    );
    assert.equal(routineTurnContext.current(), undefined);
  });

  it('a throwing observer never breaks the turn', async () => {
    const integ = createRoutinesIntegration(stubHandle, () => {
      throw new Error('binding store down');
    });
    assert.equal(
      await integ.beginRoutineTurn({
        tenant: 't1',
        userId: 'u',
        channel: 'telegram',
        conversationRef: {},
      })(async () => 'ok'),
      'ok',
    );
  });

  it('keeps cold-start outreach closed unless the channel says otherwise', async () => {
    const integ = createRoutinesIntegration(stubHandle);
    const granted = await integ.beginRoutineTurn({
      tenant: 't1',
      userId: 'u',
      channel: 'teams',
      conversationRef: {},
      canTargetOthers: true,
    })(async () => routineTurnContext.current()?.canTargetOthers);
    const omitted = await integ.beginRoutineTurn({
      tenant: 't1',
      userId: 'u',
      channel: 'telegram',
      conversationRef: {},
    })(async () => routineTurnContext.current()?.canTargetOthers);
    assert.equal(granted, true);
    assert.equal(omitted, false);
  });
});

describe('principalId helpers (P2a)', () => {
  it('canonicalizePrincipalId trims + lowercases so casing never causes a miss', () => {
    assert.equal(canonicalizePrincipalId('  Jane@Co.COM '), 'jane@co.com');
  });

  it('bindingKeyForTurn prefers a non-empty principalRef, falls back to userId (|| not ??)', () => {
    assert.equal(bindingKeyForTurn({ userId: 'aad-1', principalRef: 'jane@co' }), 'jane@co');
    assert.equal(bindingKeyForTurn({ userId: 'aad-1' }), 'aad-1');
    assert.equal(bindingKeyForTurn({ userId: 'aad-1', principalRef: '' }), 'aad-1'); // blank ⇒ fallback, not an empty key
  });
});

// Minimal pg.Pool stub recording the SQL params, so we can assert the store canonicalizes keys.
function fakePool(rows: Array<{ user_id: string; conversation_ref: unknown }> = []): {
  pool: import('pg').Pool;
  calls: Array<{ params: unknown[] }>;
} {
  const calls: Array<{ params: unknown[] }> = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      calls.push({ params });
      return { rows };
    },
  } as unknown as import('pg').Pool;
  return { pool, calls };
}

describe('ConductorChannelBindingStore canonicalization (P2a)', () => {
  it('upsert stores the key trimmed + lowercased', async () => {
    const { pool, calls } = fakePool();
    await new ConductorChannelBindingStore(pool).upsert('  Jane@Co.COM ', 'teams', { c: 1 });
    assert.equal(calls[0]?.params[0], 'jane@co.com');
  });

  it('getMany matches case-insensitively and keys the result by the ORIGINAL holder id', async () => {
    const { pool, calls } = fakePool([{ user_id: 'jane@co.com', conversation_ref: { ref: 1 } }]);
    const refs = await new ConductorChannelBindingStore(pool).getMany(['Jane@Co.com'], 'teams');
    assert.deepEqual(calls[0]?.params[0], ['jane@co.com']); // queried with the canonical key
    assert.deepEqual(refs.get('Jane@Co.com'), { ref: 1 }); // caller looks up by the id it passed
  });
});
