/**
 * The teardown: undoing a provisioning run without making things worse.
 *
 * WHAT THIS SUITE IS REALLY PINNING. Every case here traces back to one
 * question — *what is the worst state an interrupted reset can leave behind?*
 * The answer is a deleted-but-not-purged Entra application, which keeps
 * reserving its `uniqueName` for 30 days and makes the operator's next attempt
 * with the same bot slug collide with the corpse of the previous one
 * (byte5ai/omadia#916). So the suite is built around three claims:
 *
 *   1. the ORDER never lets an abort leave a worse state than it found —
 *      the irreversible step is last, and the step whose failure would
 *      silently poison the next run (the catalog entry) stops everything;
 *   2. delete and purge are ONE operation — a connector that cannot purge is
 *      not allowed to delete, and a purge that failed keeps the identifiers
 *      that let a second call finish it;
 *   3. a second call always finishes what the first started, from whatever
 *      point it died.
 *
 * Self-contained doubles rather than the shared fixture: the shape of a
 * teardown is the thing under test, so it should be readable in one file.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  resetTeamsIdentity,
  TeamsIdentityResetNotFoundError,
  TEAMS_RESET_DETAILS,
  type TeamsIdentityResetOptions,
  type TeamsResetDeleteBotResult,
  type TeamsResetIdentityRecord,
  type TeamsResetProvisionerPort,
  type TeamsResetStepReport,
} from '../src/services/teamsIdentityReset.js';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const OBJECT_ID = 'obj-1111';
const APP_ID = 'app-1111';

interface MemoryStore {
  row: TeamsResetIdentityRecord | undefined;
  readonly writes: { readonly appObjectId?: string | null }[];
  resetCalls: number;
  getByAgentId(agentId: string): Promise<TeamsResetIdentityRecord | undefined>;
  update(
    agentId: string,
    patch: { readonly appObjectId?: string | null },
  ): Promise<unknown>;
  resetForRetry(agentId: string): Promise<unknown>;
}

function memoryStore(row: Partial<TeamsResetIdentityRecord>): MemoryStore {
  const store: MemoryStore = {
    row: {
      agentId: 'agent-1',
      botSlug: 'acme',
      appId: APP_ID,
      appObjectId: null,
      teamsAppId: 'catalog-1',
      ...row,
    },
    writes: [],
    resetCalls: 0,
    getByAgentId: async () => store.row,
    update: async (_agentId, patch) => {
      store.writes.push(patch);
      if (store.row && patch.appObjectId !== undefined) {
        store.row = { ...store.row, appObjectId: patch.appObjectId };
      }
      return undefined;
    },
    resetForRetry: async () => {
      store.resetCalls += 1;
      return undefined;
    },
  };
  return store;
}

interface StubProvisioner extends TeamsResetProvisionerPort {
  readonly calls: string[];
}

interface StubOptions {
  readonly live?: boolean;
  readonly deleted?: boolean;
  readonly canPurge?: boolean;
  readonly canFind?: boolean;
  readonly canRemoveFromCatalog?: boolean;
  readonly deleteBotResult?: TeamsResetDeleteBotResult;
  readonly failOn?: 'catalog' | 'bot' | 'delete' | 'purge';
  readonly purgeError?: Error;
}

/**
 * A provisioner that MODELS AZURE rather than returning canned answers: it
 * keeps whether the application is live, in the recycle bin, or gone, and the
 * primitives move it between those. That is what lets the resumption tests
 * assert real continuations instead of replayed scripts.
 */
function stubProvisioner(opts: StubOptions = {}): StubProvisioner {
  const calls: string[] = [];
  let live = opts.live ?? true;
  let deleted = opts.deleted ?? false;

  const base: TeamsResetProvisionerPort = {
    tenantMode: 'customer',
    getAppRegistration: async (appId) => {
      calls.push(`getAppRegistration:${appId}`);
      return live ? { objectId: OBJECT_ID } : undefined;
    },
    deleteAppRegistration: async ({ appId }) => {
      calls.push(`deleteAppRegistration:${appId}`);
      if (opts.failOn === 'delete') throw new Error('graph exploded');
      if (!live) return { outcome: 'already-deleted' };
      live = false;
      deleted = true;
      return { outcome: 'deleted' };
    },
    deleteBot: async (botName) => {
      calls.push(`deleteBot:${botName}`);
      if (opts.failOn === 'bot') throw new Error('arm exploded');
      return opts.deleteBotResult ?? { kind: 'deleted', outcome: 'deleted' };
    },
  };

  const purge =
    opts.canPurge === false
      ? {}
      : {
          purgeDeletedAppRegistration: async ({ objectId }: { objectId: string }) => {
            calls.push(`purge:${objectId}`);
            if (opts.failOn === 'purge') {
              throw opts.purgeError ?? new Error('purge exploded');
            }
            deleted = false;
            return { outcome: 'purged' };
          },
        };

  const find =
    opts.canFind === false
      ? {}
      : {
          findDeletedAppRegistration: async ({ appId }: { appId: string }) => {
            calls.push(`findDeleted:${appId}`);
            return deleted
              ? ({ found: true, objectId: OBJECT_ID } as const)
              : ({ found: false } as const);
          },
        };

  const catalog =
    opts.canRemoveFromCatalog === false
      ? {}
      : {
          removeFromCatalog: async ({ teamsAppId }: { teamsAppId: string }) => {
            calls.push(`removeFromCatalog:${teamsAppId}`);
            if (opts.failOn === 'catalog') throw new Error('catalog exploded');
            return { outcome: 'removed' };
          },
        };

  return { ...base, ...purge, ...find, ...catalog, calls };
}

const TOKENS = { accessToken: 'x', tenantId: 't' } as unknown as never;

function options(
  store: MemoryStore,
  provisioner: StubProvisioner,
  extra: Partial<TeamsIdentityResetOptions> = {},
): TeamsIdentityResetOptions {
  return {
    store,
    getProvisioner: () => provisioner,
    buildBotHandle: (slug, appId) => `omadia-${slug}-${appId.slice(0, 8)}`,
    delegatedTokens: { read: async () => TOKENS },
    ...extra,
  };
}

function outcomeOf(
  steps: readonly TeamsResetStepReport[],
  step: TeamsResetStepReport['step'],
): TeamsResetStepReport | undefined {
  return steps.find((entry) => entry.step === step);
}

// ---------------------------------------------------------------------------

describe('teams identity reset — the partial states', () => {
  it('tears down a complete provisioning in the documented order', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner();

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'reset');
    // THE ORDER IS THE ASSERTION. Catalog first (its failure would poison the
    // next run), then the bot (which depends on the app id), then the
    // registration as delete+purge, and only then the row.
    assert.deepEqual(
      provisioner.calls.filter((c) => !c.startsWith('getAppRegistration')),
      [
        'removeFromCatalog:catalog-1',
        'deleteBot:omadia-acme-app-1111',
        'deleteAppRegistration:app-1111',
        `purge:${OBJECT_ID}`,
      ],
    );
    assert.equal(store.resetCalls, 1);
  });

  it('reports nothing-created as four skips and still clears the row', async () => {
    const store = memoryStore({ appId: null, teamsAppId: null });
    const provisioner = stubProvisioner();

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'reset');
    assert.deepEqual(provisioner.calls, []);
    for (const step of ['catalog_removed', 'bot_deleted', 'app_deleted'] as const) {
      assert.equal(outcomeOf(result.steps, step)?.outcome, 'skipped');
      assert.equal(
        outcomeOf(result.steps, step)?.detail,
        TEAMS_RESET_DETAILS.nothingToRemove,
      );
    }
    assert.equal(store.resetCalls, 1);
  });

  it('with only the app registration created, skips the catalog and purges', async () => {
    const store = memoryStore({ teamsAppId: null });
    const provisioner = stubProvisioner();

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'reset');
    assert.equal(outcomeOf(result.steps, 'catalog_removed')?.outcome, 'skipped');
    assert.ok(provisioner.calls.includes(`purge:${OBJECT_ID}`));
  });

  it('reports an already-absent bot as a success, not a failure', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner({
      deleteBotResult: { kind: 'deleted', outcome: 'already-deleted' },
    });

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'reset');
    assert.equal(outcomeOf(result.steps, 'bot_deleted')?.outcome, 'already-absent');
  });
});

describe('teams identity reset — the purge is not optional', () => {
  it('REFUSES to delete the app registration when it cannot purge', async () => {
    // The single most important case in this file. Deleting without purging
    // converts a reusable registration into a 30-day reservation on the
    // operator's own slug — strictly worse than doing nothing.
    const store = memoryStore({});
    const provisioner = stubProvisioner({ canPurge: false });

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'incomplete');
    assert.equal(result.status === 'incomplete' ? result.stoppedAt : null, 'app_deleted');
    assert.equal(outcomeOf(result.steps, 'app_deleted')?.outcome, 'blocked');
    assert.equal(
      outcomeOf(result.steps, 'app_deleted')?.detail,
      TEAMS_RESET_DETAILS.purgeUnsupported,
    );
    assert.ok(
      !provisioner.calls.some((c) => c.startsWith('deleteAppRegistration')),
      'the registration must not be deleted when it cannot be purged',
    );
    assert.equal(store.resetCalls, 0, 'the row must keep pointing at the live app');
  });

  it('passes the OBJECT id to the purge, never the app id', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner();

    await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.ok(provisioner.calls.includes(`purge:${OBJECT_ID}`));
    assert.ok(
      !provisioner.calls.includes(`purge:${APP_ID}`),
      'the recycle bin is addressed by object id — an app id silently 404s',
    );
  });

  it('persists the object id BEFORE the delete makes it unlookupable', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner();

    await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.deepEqual(store.writes, [{ appObjectId: OBJECT_ID }]);
    const lookupIndex = provisioner.calls.indexOf(`getAppRegistration:${APP_ID}`);
    const deleteIndex = provisioner.calls.indexOf(`deleteAppRegistration:${APP_ID}`);
    assert.ok(lookupIndex >= 0 && lookupIndex < deleteIndex);
  });

  it('uses a stored object id instead of looking it up again', async () => {
    const store = memoryStore({ appObjectId: OBJECT_ID });
    const provisioner = stubProvisioner();

    await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.ok(!provisioner.calls.some((c) => c.startsWith('getAppRegistration')));
    assert.ok(provisioner.calls.includes(`purge:${OBJECT_ID}`));
  });
});

describe('teams identity reset — interruption and resumption', () => {
  it('a purge failure keeps the identifiers a second call needs', async () => {
    const store = memoryStore({});
    const first = stubProvisioner({ failOn: 'purge' });

    const result = await resetTeamsIdentity(options(store, first), 'agent-1');

    assert.equal(result.status, 'incomplete');
    assert.equal(outcomeOf(result.steps, 'app_deleted')?.outcome, 'failed');
    assert.equal(store.resetCalls, 0, 'the row must not be cleared mid-purge');
    assert.equal(
      store.row?.appObjectId,
      OBJECT_ID,
      'the object id is the only pointer to the tombstone — it must survive',
    );
  });

  it('a second call finishes a teardown that died between delete and purge', async () => {
    // The #916 scenario, replayed. The first attempt deletes and then dies;
    // the second must still empty the recycle bin, or the slug is burned for
    // 30 days.
    const store = memoryStore({});
    const first = stubProvisioner({ failOn: 'purge' });
    await resetTeamsIdentity(options(store, first), 'agent-1');

    // A fresh connector instance whose Azure now holds a TOMBSTONE, not a
    // live application — exactly what the second call would really find.
    const second = stubProvisioner({ live: false, deleted: true });
    const result = await resetTeamsIdentity(options(store, second), 'agent-1');

    assert.equal(result.status, 'reset');
    assert.ok(second.calls.includes(`purge:${OBJECT_ID}`));
    assert.equal(
      outcomeOf(result.steps, 'app_deleted')?.outcome,
      'already-absent',
      'the delete was already done; repeating it is a success, not a failure',
    );
    assert.equal(store.resetCalls, 1);
  });

  it('recovers the object id from the recycle bin when the row never had one', async () => {
    // A row provisioned before migration 0055, whose application somebody
    // already deleted. `getAppRegistration` cannot help — only the search can.
    const store = memoryStore({ appObjectId: null });
    const provisioner = stubProvisioner({ live: false, deleted: true });

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'reset');
    assert.ok(provisioner.calls.includes(`findDeleted:${APP_ID}`));
    assert.ok(provisioner.calls.includes(`purge:${OBJECT_ID}`));
    assert.equal(store.row?.appObjectId, OBJECT_ID);
  });

  it('retries the purge with the id a DeletedObjectIdMismatchError carries', async () => {
    const store = memoryStore({ appObjectId: 'stale-object-id' });
    let attempts = 0;
    const provisioner = stubProvisioner();
    const purged: string[] = [];
    (
      provisioner as { purgeDeletedAppRegistration?: unknown }
    ).purgeDeletedAppRegistration = async ({ objectId }: { objectId: string }) => {
      purged.push(objectId);
      attempts += 1;
      if (attempts === 1) {
        const err = Object.assign(new Error('wrong identifier'), {
          name: 'DeletedObjectIdMismatchError',
          objectId: OBJECT_ID,
        });
        throw err;
      }
      return { outcome: 'purged' };
    };

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'reset');
    assert.deepEqual(purged, ['stale-object-id', OBJECT_ID]);
    assert.equal(store.row?.appObjectId, OBJECT_ID, 'the corrected id is remembered');
  });

  it('reports an unpurgeable vanished app rather than claiming a clean sweep', async () => {
    // Gone from `/applications`, no stored object id, and a connector that
    // cannot search. Nothing left to call — but the slug may still be
    // reserved, so it is NAMED rather than hidden behind a bare success.
    const store = memoryStore({ appObjectId: null });
    const provisioner = stubProvisioner({ live: false, canFind: false });

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'reset');
    assert.equal(
      outcomeOf(result.steps, 'app_deleted')?.detail,
      TEAMS_RESET_DETAILS.appAbsentUnpurgeable,
    );
  });

  it('reports a provably empty recycle bin as the strong kind of absence', async () => {
    const store = memoryStore({ appObjectId: null });
    const provisioner = stubProvisioner({ live: false, deleted: false });

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(
      outcomeOf(result.steps, 'app_deleted')?.detail,
      TEAMS_RESET_DETAILS.appProvablyGone,
    );
  });
});

describe('teams identity reset — the catalog entry gates everything', () => {
  it('stops before touching Azure when the catalog cannot be withdrawn', async () => {
    // `stableTeamsAppExternalId` is derived from the agent id, so a catalog
    // entry survives any reset — and the chain ADOPTS a found entry without
    // re-uploading. Deleting the app registration while it stands would give
    // the next run a new appId paired with a manifest naming the old one:
    // every step green, bot never answers.
    const store = memoryStore({});
    const provisioner = stubProvisioner({ canRemoveFromCatalog: false });

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'incomplete');
    assert.equal(result.status === 'incomplete' ? result.stoppedAt : null, 'catalog_removed');
    assert.equal(
      outcomeOf(result.steps, 'catalog_removed')?.detail,
      TEAMS_RESET_DETAILS.catalogRemovalUnsupported,
    );
    assert.deepEqual(provisioner.calls, [], 'nothing may be deleted');
    assert.equal(store.resetCalls, 0);
  });

  it('blocks — not fails — when nobody is signed in', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner();

    const result = await resetTeamsIdentity(
      options(store, provisioner, { delegatedTokens: { read: async () => undefined } }),
      'agent-1',
    );

    assert.equal(result.status, 'incomplete');
    assert.equal(outcomeOf(result.steps, 'catalog_removed')?.outcome, 'blocked');
    assert.equal(
      outcomeOf(result.steps, 'catalog_removed')?.detail,
      TEAMS_RESET_DETAILS.tenantSignInRequired,
    );
    assert.deepEqual(provisioner.calls, []);
  });

  it('a catalog failure leaves the app registration alone', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner({ failOn: 'catalog' });

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'incomplete');
    assert.ok(!provisioner.calls.some((c) => c.startsWith('deleteAppRegistration')));
    assert.equal(store.resetCalls, 0);
  });

  it('a bot failure stops before the registration it is named after', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner({ failOn: 'bot' });

    const result = await resetTeamsIdentity(options(store, provisioner), 'agent-1');

    assert.equal(result.status, 'incomplete');
    assert.equal(result.status === 'incomplete' ? result.stoppedAt : null, 'bot_deleted');
    assert.ok(!provisioner.calls.some((c) => c.startsWith('deleteAppRegistration')));
  });
});

describe('teams identity reset — bookkeeping', () => {
  it('drops the recorded installs together with the row', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner();
    const removed: string[] = [];

    await resetTeamsIdentity(
      options(store, provisioner, {
        installs: {
          removeAllForAgent: async (agentId) => {
            removed.push(agentId);
            return 2;
          },
        },
      }),
      'agent-1',
    );

    assert.deepEqual(removed, ['agent-1']);
  });

  it('writes one timeline, opened by a clear and closed by a verdict', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner();
    const events: string[] = [];
    let cleared = 0;

    await resetTeamsIdentity(
      options(store, provisioner, {
        events: {
          record: async ({ step, status }) => {
            events.push(`${step}/${status}`);
            return undefined;
          },
          clearForAgent: async () => {
            cleared += 1;
            return undefined;
          },
        },
      }),
      'agent-1',
    );

    assert.equal(cleared, 1, 'a teardown describes ONE operation');
    assert.equal(events[0], 'reset/started');
    assert.equal(events.at(-1), 'reset/succeeded');
    assert.ok(events.includes('app_deleted/started'));
    assert.ok(events.includes('app_deleted/succeeded'));
  });

  it('a sink that rejects never fails the teardown', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner();

    const result = await resetTeamsIdentity(
      options(store, provisioner, {
        events: {
          record: async () => {
            throw new Error('postgres is down');
          },
          clearForAgent: async () => {
            throw new Error('postgres is down');
          },
        },
      }),
      'agent-1',
    );

    assert.equal(result.status, 'reset');
  });

  it('throws for an agent that has no identity row', async () => {
    const store = memoryStore({});
    store.row = undefined;

    await assert.rejects(
      () => resetTeamsIdentity(options(store, stubProvisioner()), 'agent-1'),
      TeamsIdentityResetNotFoundError,
    );
  });
});


describe('teams identity reset — the #916 trap, closed from both sides', () => {
  it('finishes an interrupted purge from the app id ALONE, with no stored object id', async () => {
    // THE CASE THAT COSTS A MONTH IF IT IS WRONG.
    //
    // The first attempt deletes the registration and dies before the purge.
    // Then the object id is lost — a row that predates migration 0055, a
    // failed write, a hand-edited row; the reason does not matter, the point
    // is that the teardown must not DEPEND on it. All that is left is the
    // `appId`, which the row keeps precisely because nothing clears it until
    // the purge is confirmed.
    //
    // If this test goes red, a deleted-but-not-purged application keeps
    // reserving `omadia-teams-bot-<botSlug>` for 30 days, and the operator
    // finds out only when their retry collides with it.
    const store = memoryStore({});
    const first = stubProvisioner({ failOn: 'purge' });
    const firstResult = await resetTeamsIdentity(options(store, first), 'agent-1');

    assert.equal(firstResult.status, 'incomplete');
    assert.equal(
      store.row?.appId,
      APP_ID,
      'the app id is the last bridge to the tombstone — it must survive a failed purge',
    );

    // Wipe the convenience path, keeping only what the row is guaranteed to
    // carry.
    store.row = { ...(store.row as TeamsResetIdentityRecord), appObjectId: null };

    const second = stubProvisioner({ live: false, deleted: true });
    const result = await resetTeamsIdentity(options(store, second), 'agent-1');

    assert.equal(result.status, 'reset');
    assert.ok(
      second.calls.includes(`findDeleted:${APP_ID}`),
      'the recycle bin must be searched by app id',
    );
    assert.ok(
      second.calls.includes(`purge:${OBJECT_ID}`),
      'and the tombstone must actually be purged',
    );
    assert.equal(store.resetCalls, 1, 'only now may the row be cleared');
  });

  it('never clears the row while an Azure object it points at is still there', async () => {
    // The invariant the test above depends on, asserted directly across every
    // way a teardown can stop early.
    for (const failOn of ['catalog', 'bot', 'delete', 'purge'] as const) {
      const store = memoryStore({});
      const result = await resetTeamsIdentity(
        options(store, stubProvisioner({ failOn })),
        'agent-1',
      );
      assert.equal(result.status, 'incomplete', `failOn=${failOn}`);
      assert.equal(store.resetCalls, 0, `failOn=${failOn}: the row must be kept`);
      assert.equal(store.row?.appId, APP_ID, `failOn=${failOn}: the app id must be kept`);
    }
  });
});
