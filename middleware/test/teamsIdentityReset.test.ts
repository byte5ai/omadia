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
  TeamsIdentityResetUnsupportedError,
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
  deleteCalls: number;
  getByAgentId(agentId: string): Promise<TeamsResetIdentityRecord | undefined>;
  update(
    agentId: string,
    patch: { readonly appObjectId?: string | null },
  ): Promise<unknown>;
  resetForRetry(agentId: string): Promise<unknown>;
  deleteForAgent?(agentId: string): Promise<unknown>;
}

/**
 * @param canDelete `false` models a store that predates the full teardown —
 *   the capability gate the route also enforces, exercised here from the
 *   service's own side.
 */
function memoryStore(
  row: Partial<TeamsResetIdentityRecord>,
  opts: { readonly canDelete?: boolean; readonly deleteFails?: boolean } = {},
): MemoryStore {
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
    deleteCalls: 0,
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
      // Deliberately a COUNTER and not a model of the real write. The real
      // `resetForRetry` NULLs the Azure identifiers, and several tests here
      // read `row.appObjectId` AFTER a completed teardown to prove the id was
      // persisted mid-teardown — the property that makes an interrupted purge
      // resumable at all. Emptying the row here would erase the evidence
      // those tests exist to inspect. What distinguishes the two scopes in
      // this double is `resetCalls` versus `deleteCalls` and whether `row`
      // survives at all, which `deleteForAgent` below does model.
      return undefined;
    },
  };
  if (opts.canDelete !== false) {
    store.deleteForAgent = async () => {
      store.deleteCalls += 1;
      if (opts.deleteFails) throw new Error('pg is down');
      store.row = undefined;
      return undefined;
    };
  }
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

/**
 * THE FULL RESET — winding an agent back to having no Teams identity at all,
 * so a new bot slug and display name can be chosen.
 *
 * It is the SAME teardown as above with one different last line, and this
 * suite is written to prove exactly that: the order, the refusals and the
 * partial report are inherited unchanged, and only the fate of the database
 * row differs. `bot_slug` is `UNIQUE`, so nothing short of dropping the row
 * frees the name — which is the entire reason this scope exists.
 *
 * THE RULE IT MUST NEVER BREAK. The row may only disappear once every Azure
 * object it points at is provably gone. `app_id` is the sole input
 * `findDeletedAppRegistration` accepts, so a row deleted while a registration
 * may still be sitting in the directory's recycle bin destroys the only route
 * back to it: the tombstone then holds the `uniqueName` for thirty days with
 * nothing left able to name it. A reset that leaves an unreachable corpse
 * behind is strictly worse than the state it was asked to repair.
 */
describe('teams identity reset — the full reset', () => {
  it('tears Azure down in the SAME order, then removes the row', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner();

    const result = await resetTeamsIdentity(
      options(store, provisioner),
      'agent-1',
      'identity',
    );

    assert.equal(result.status, 'reset');
    assert.equal(result.scope, 'identity');
    // Byte for byte the order the milder teardown uses. A second teardown
    // with its own order is exactly what this scope must not become.
    assert.deepEqual(
      provisioner.calls.filter((c) => !c.startsWith('getAppRegistration')),
      [
        'removeFromCatalog:catalog-1',
        'deleteBot:omadia-acme-app-1111',
        'deleteAppRegistration:app-1111',
        `purge:${OBJECT_ID}`,
      ],
    );
    assert.equal(store.deleteCalls, 1);
    assert.equal(store.resetCalls, 0, 'the milder reset must not also run');
    assert.equal(store.row, undefined, 'the identity is gone');
    assert.equal(
      outcomeOf(result.steps, 'identity_deleted')?.outcome,
      'removed',
    );
    assert.equal(
      outcomeOf(result.steps, 'identity_reset'),
      undefined,
      'exactly one row step is reported, never both',
    );
  });

  it('THE RULE: an abort mid-teardown leaves the row exactly where it was', async () => {
    // The single most important assertion in this file. Every way the
    // teardown can stop early, across BOTH scopes: nothing may delete the row
    // while an Azure object it points at might still exist, because the row
    // is the only thing that still knows the object's name.
    for (const failOn of ['catalog', 'bot', 'delete', 'purge'] as const) {
      const store = memoryStore({});
      const result = await resetTeamsIdentity(
        options(store, stubProvisioner({ failOn })),
        'agent-1',
        'identity',
      );

      assert.equal(result.status, 'incomplete', `failOn=${failOn}`);
      assert.equal(store.deleteCalls, 0, `failOn=${failOn}: the row must survive`);
      assert.notEqual(store.row, undefined, `failOn=${failOn}: the row must survive`);
      // And it must survive INTACT — a row stripped of `app_id` is a row that
      // can no longer find the registration it was keeping a trace of.
      assert.equal(
        store.row?.appId,
        APP_ID,
        `failOn=${failOn}: the trace back to Azure must be kept`,
      );
    }
  });

  it('refuses to drop the row when the app registration cannot be proven gone', async () => {
    // The subtle one, and the reason `app_absent_unpurgeable` could not
    // simply be treated as the success it is reported as.
    //
    // The application is out of `/applications` and the connector cannot
    // search the recycle bin, so nothing can say whether a tombstone is still
    // holding this agent's `uniqueName`. The milder reset survives that doubt
    // because it keeps the row. This one would delete the doubt along with
    // the only pointer that could ever resolve it — so it stops instead, with
    // every Azure step already done.
    const store = memoryStore({});
    const provisioner = stubProvisioner({ live: false, deleted: false, canFind: false });

    const result = await resetTeamsIdentity(
      options(store, provisioner),
      'agent-1',
      'identity',
    );

    assert.equal(result.status, 'incomplete');
    assert.equal(
      outcomeOf(result.steps, 'app_deleted')?.detail,
      TEAMS_RESET_DETAILS.appAbsentUnpurgeable,
    );
    assert.equal(outcomeOf(result.steps, 'identity_deleted')?.outcome, 'blocked');
    assert.equal(
      outcomeOf(result.steps, 'identity_deleted')?.detail,
      TEAMS_RESET_DETAILS.appTraceRequired,
    );
    assert.equal(store.deleteCalls, 0);
    assert.equal(store.row?.appId, APP_ID, 'the trace stays addressable');
    // The catalog and the bot really were removed — this is a refusal to
    // finish, not a refusal to start.
    assert.equal(outcomeOf(result.steps, 'catalog_removed')?.outcome, 'removed');
    assert.equal(outcomeOf(result.steps, 'bot_deleted')?.outcome, 'removed');
  });

  it('the MILDER reset still completes in that same state', async () => {
    // The contrast that justifies keeping both. Same Azure uncertainty, and
    // `'run'` may finish: it keeps the row, so the trace survives and the
    // operator is merely warned to pick a different slug.
    const store = memoryStore({});

    const result = await resetTeamsIdentity(
      options(store, stubProvisioner({ live: false, deleted: false, canFind: false })),
      'agent-1',
      'run',
    );

    assert.equal(result.status, 'reset');
    assert.equal(result.scope, 'run');
    assert.equal(store.resetCalls, 1);
  });

  it('a store that cannot delete is refused BEFORE anything is torn down', async () => {
    // Half-performing this is the worst available outcome: Azure emptied, the
    // row still filled in, and no way for the operator to tell which of the
    // two they are looking at.
    const store = memoryStore({}, { canDelete: false });
    const provisioner = stubProvisioner();

    await assert.rejects(
      () => resetTeamsIdentity(options(store, provisioner), 'agent-1', 'identity'),
      TeamsIdentityResetUnsupportedError,
    );
    assert.deepEqual(provisioner.calls, [], 'not one Azure call was made');
    assert.equal(store.resetCalls, 0);
  });

  it('a failing row deletion keeps every identifier for the retry', async () => {
    const store = memoryStore({}, { deleteFails: true });

    const result = await resetTeamsIdentity(
      options(store, stubProvisioner()),
      'agent-1',
      'identity',
    );

    assert.equal(result.status, 'incomplete');
    assert.equal(result.status === 'incomplete' ? result.stoppedAt : null, 'identity_deleted');
    assert.equal(outcomeOf(result.steps, 'identity_deleted')?.outcome, 'failed');
    assert.notEqual(store.row, undefined);
  });

  it('is idempotent — a second call finishes on already-absent objects', async () => {
    // Resumption without a cursor: every primitive answers `already-absent`
    // for something that is not there, and the teardown treats that as
    // success. Here the first attempt dies on the purge and the second one
    // completes, all the way through the row.
    const store = memoryStore({});
    const first = await resetTeamsIdentity(
      options(store, stubProvisioner({ failOn: 'purge' })),
      'agent-1',
      'identity',
    );
    assert.equal(first.status, 'incomplete');
    assert.equal(store.deleteCalls, 0);
    // The object id was persisted mid-teardown — that is what makes the
    // recycle-bin entry addressable at all after the delete.
    assert.equal(store.row?.appObjectId, OBJECT_ID);

    const second = await resetTeamsIdentity(
      options(store, stubProvisioner({ live: false, deleted: true })),
      'agent-1',
      'identity',
    );

    assert.equal(second.status, 'reset');
    assert.equal(store.deleteCalls, 1);
    assert.equal(store.row, undefined);
  });

  it('nothing provisioned yet: four skips and the row still goes', async () => {
    // The state an operator is in when they typed a slug they regret before
    // ever starting a run. There is nothing in Azure to remove, and the whole
    // point is that the slug becomes free again.
    const store = memoryStore({ appId: null, teamsAppId: null });
    const provisioner = stubProvisioner();

    const result = await resetTeamsIdentity(
      options(store, provisioner),
      'agent-1',
      'identity',
    );

    assert.equal(result.status, 'reset');
    assert.deepEqual(provisioner.calls, []);
    assert.equal(store.row, undefined);
  });

  it('a blocked catalog entry stops a full reset exactly as it stops a mild one', async () => {
    // The refusal that must survive both scopes. `stableTeamsAppExternalId`
    // is derived from the AGENT id, so it outlives any reset — an abandoned
    // catalog entry is adopted by the next run and pairs a new bot with a
    // deleted app id. Under `'identity'` it would be worse still: the row
    // that knew about the entry would be gone too.
    const store = memoryStore({});

    const result = await resetTeamsIdentity(
      options(store, stubProvisioner({ canRemoveFromCatalog: false })),
      'agent-1',
      'identity',
    );

    assert.equal(result.status, 'incomplete');
    assert.equal(result.status === 'incomplete' ? result.stoppedAt : null, 'catalog_removed');
    assert.equal(
      outcomeOf(result.steps, 'catalog_removed')?.detail,
      TEAMS_RESET_DETAILS.catalogRemovalUnsupported,
    );
    assert.equal(store.deleteCalls, 0);
  });

  it('a connector that cannot purge still may not delete, under either scope', async () => {
    const store = memoryStore({}, {});
    const provisioner = stubProvisioner({ canPurge: false });

    const result = await resetTeamsIdentity(
      options(store, provisioner),
      'agent-1',
      'identity',
    );

    assert.equal(result.status, 'incomplete');
    assert.equal(
      outcomeOf(result.steps, 'app_deleted')?.detail,
      TEAMS_RESET_DETAILS.purgeUnsupported,
    );
    assert.ok(
      !provisioner.calls.some((c) => c.startsWith('deleteAppRegistration')),
      'deleting without a purge would burn the slug for 30 days',
    );
    assert.equal(store.deleteCalls, 0);
  });
});

/**
 * A SPENT TENANT TOKEN IS NOT A MISSING ONE — the teardown's half of the
 * field-test bug.
 *
 * The catalog withdrawal is delegated-only, it runs FIRST, and its failure
 * stops the whole teardown. So an expired access token used to abort the
 * entire reset with `catalog_removal_failed: <whatever Graph said>` — over a
 * condition that needs no human at all. The same refresh the catalogue upload
 * has performed since #924 fixes it, and it is now literally the same code.
 */
describe('teams identity reset — the tenant sign-in', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = new Date('2026-08-31T12:00:00.000Z');

  function tokens(expiresAt: Date, accessToken = 'access-1'): Record<string, unknown> {
    return {
      accessToken,
      refreshToken: 'refresh-1',
      expiresAt: expiresAt.toISOString(),
      scopes: ['AppCatalog.ReadWrite.All'],
      clientId: 'client-1',
      tenantId: 'tenant-1',
    };
  }

  function expiredError(): Error {
    return Object.assign(new Error('access token expired'), {
      name: 'DelegatedTokenExpiredError',
      reason: 'access-token-expired',
      recoverableByRefresh: true,
    });
  }

  it('refreshes a spent token rather than aborting the whole teardown', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner();
    const written: unknown[] = [];
    let stored: unknown = tokens(new Date(NOW.getTime() - HOUR));

    const result = await resetTeamsIdentity(
      options(store, {
        ...provisioner,
        refreshDelegatedToken: async () => tokens(new Date(NOW.getTime() + HOUR), 'access-2'),
      } as never, {
        now: () => NOW,
        delegatedTokens: {
          read: async () => stored as never,
          write: async (set: unknown) => {
            written.push(set);
            stored = set;
          },
        },
      }),
      'agent-1',
      'identity',
    );

    assert.equal(result.status, 'reset');
    assert.equal(outcomeOf(result.steps, 'catalog_removed')?.outcome, 'removed');
    assert.equal(written.length, 1, 'the rotation was persisted');
    assert.equal((written[0] as { accessToken: string }).accessToken, 'access-2');
  });

  it('reports a token whose refresh failed as EXPIRED, not as never signed in', async () => {
    const store = memoryStore({});
    const base = stubProvisioner();

    const result = await resetTeamsIdentity(
      options(store, {
        ...base,
        removeFromCatalog: async () => {
          throw expiredError();
        },
        refreshDelegatedToken: async () => {
          throw new Error('invalid_grant');
        },
      } as never, {
        now: () => NOW,
        delegatedTokens: {
          read: async () => tokens(new Date(NOW.getTime() + HOUR)) as never,
          write: async () => {},
        },
      }),
      'agent-1',
      'identity',
    );

    assert.equal(result.status, 'incomplete');
    const catalog = outcomeOf(result.steps, 'catalog_removed');
    // BLOCKED, not FAILED: nothing broke, a human has to act.
    assert.equal(catalog?.outcome, 'blocked');
    assert.equal(catalog?.detail, TEAMS_RESET_DETAILS.tenantSignInExpired);
    assert.notEqual(
      catalog?.detail,
      TEAMS_RESET_DETAILS.tenantSignInRequired,
      'an expired sign-in is not a missing one',
    );
    assert.equal(store.deleteCalls, 0);
  });

  it('still says a plain sign-in is required when nobody signed in', async () => {
    const store = memoryStore({});

    const result = await resetTeamsIdentity(
      options(store, stubProvisioner(), {
        delegatedTokens: { read: async () => undefined, write: async () => {} },
      }),
      'agent-1',
      'identity',
    );

    assert.equal(result.status, 'incomplete');
    assert.equal(
      outcomeOf(result.steps, 'catalog_removed')?.detail,
      TEAMS_RESET_DETAILS.tenantSignInRequired,
    );
  });

  it('never refreshes without somewhere to persist the rotation', async () => {
    // Same safety rule the listing obeys: spending the refresh token without
    // recording its replacement signs the tenant out for good.
    const store = memoryStore({});
    const base = stubProvisioner();
    let refreshed = 0;

    const result = await resetTeamsIdentity(
      options(store, {
        ...base,
        removeFromCatalog: async () => {
          throw expiredError();
        },
        refreshDelegatedToken: async () => {
          refreshed += 1;
          return tokens(new Date(NOW.getTime() + HOUR)) as never;
        },
      } as never, {
        now: () => NOW,
        // READ ONLY.
        delegatedTokens: { read: async () => tokens(new Date(NOW.getTime() + HOUR)) as never },
      }),
      'agent-1',
      'identity',
    );

    assert.equal(refreshed, 0);
    assert.equal(
      outcomeOf(result.steps, 'catalog_removed')?.detail,
      TEAMS_RESET_DETAILS.tenantSignInExpired,
    );
  });
});

// ---------------------------------------------------------------------------

/**
 * The `teams_bots` entry the provisioning chain writes automatically (#910).
 *
 * A teardown that leaves it behind is the one failure mode that is INVISIBLE
 * in Azure and still breaks the tenant: channel-teams keeps an adapter for a
 * bot whose registration was just purged, every inbound activity for it fails
 * authentication, and the operator sees a "reset" that did not reset.
 */
describe('teams identity reset — the channel-teams config entry', () => {
  it('removes the entry, by slug, after the registration is gone', async () => {
    const store = memoryStore({});
    const provisioner = stubProvisioner();
    const dropped: string[] = [];

    const result = await resetTeamsIdentity(
      options(store, provisioner, {
        unsyncBotConfig: async (botSlug: string) => {
          // ORDER IS PART OF THE CONTRACT: the entry points at the
          // registration, so it may only go once the registration has.
          assert.ok(
            provisioner.calls.some((c) => c.startsWith('deleteAppRegistration:')),
            'the app must already be deleted when the entry is removed',
          );
          dropped.push(botSlug);
          return { status: 'synced', botSlug };
        },
      }),
      'agent-1',
    );

    assert.deepEqual(dropped, ['acme']);
    assert.deepEqual(outcomeOf(result.steps, 'config_unsynced'), {
      step: 'config_unsynced',
      outcome: 'removed',
    });
    assert.equal(result.status, 'reset');
  });

  it('reports an absent entry as a success, not as a failure', async () => {
    const store = memoryStore({});
    const result = await resetTeamsIdentity(
      options(store, stubProvisioner(), {
        unsyncBotConfig: async (botSlug: string) => ({
          status: 'unchanged',
          botSlug,
        }),
      }),
      'agent-1',
    );
    assert.equal(outcomeOf(result.steps, 'config_unsynced')?.outcome, 'already-absent');
    assert.equal(result.status, 'reset');
  });

  it('skips when no hook is wired, and names which of the two reasons', async () => {
    // A mount that never wired the automatic write has no entry this teardown
    // put there. Reported, not hidden — an operator comparing two deployments
    // should see WHY one of them cleaned nothing.
    const withoutHook = await resetTeamsIdentity(
      options(memoryStore({}), stubProvisioner()),
      'agent-1',
    );
    assert.deepEqual(outcomeOf(withoutHook.steps, 'config_unsynced'), {
      step: 'config_unsynced',
      outcome: 'skipped',
      detail: TEAMS_RESET_DETAILS.configUnsyncUnavailable,
    });

    const withoutPlugin = await resetTeamsIdentity(
      options(memoryStore({}), stubProvisioner(), {
        unsyncBotConfig: async () => ({
          status: 'skipped',
          reason: 'plugin_not_installed',
        }),
      }),
      'agent-1',
    );
    assert.equal(
      outcomeOf(withoutPlugin.steps, 'config_unsynced')?.detail,
      TEAMS_RESET_DETAILS.configPluginNotInstalled,
    );
  });

  it('does NOT stop the teardown when the config write fails', async () => {
    // The one step allowed to fail without halting, and the reason is
    // asymmetric damage: halting here leaves the identity row pointing at an
    // app that is already deleted and purged, which is strictly worse than a
    // stale config entry the next run overwrites in place.
    const store = memoryStore({});
    const result = await resetTeamsIdentity(
      options(store, stubProvisioner(), {
        unsyncBotConfig: async () => {
          throw new Error('plugin registry is down');
        },
      }),
      'agent-1',
    );

    const step = outcomeOf(result.steps, 'config_unsynced');
    assert.equal(step?.outcome, 'failed');
    assert.match(String(step?.detail), /^config_unsync_failed:/);
    // The row still went back to pending — the teardown finished.
    assert.equal(result.status, 'reset');
    assert.equal(store.resetCalls, 1);
  });

  it('runs for the full reset too, before the row is dropped', async () => {
    const store = memoryStore({});
    const seen: string[] = [];
    const result = await resetTeamsIdentity(
      options(store, stubProvisioner(), {
        unsyncBotConfig: async (botSlug: string) => {
          // The row is what holds the slug, so the entry has to go while it
          // is still readable.
          assert.equal(store.deleteCalls, 0);
          seen.push(botSlug);
          return { status: 'synced', botSlug };
        },
      }),
      'agent-1',
      'identity',
    );
    assert.deepEqual(seen, ['acme']);
    assert.equal(store.deleteCalls, 1);
    assert.equal(result.status, 'reset');
  });

  it('is not reached when an earlier step halted the teardown', async () => {
    // The entry names a live bot as long as the registration is alive.
    // Removing it after a failed app deletion would take the bot off the air
    // while leaving it in Azure — the worst of both.
    let called = 0;
    const result = await resetTeamsIdentity(
      options(memoryStore({}), stubProvisioner({ failOn: 'catalog' }), {
        unsyncBotConfig: async (botSlug: string) => {
          called += 1;
          return { status: 'synced', botSlug };
        },
      }),
      'agent-1',
    );
    assert.equal(result.status, 'incomplete');
    assert.equal(called, 0);
    assert.equal(outcomeOf(result.steps, 'config_unsynced'), undefined);
  });
});
