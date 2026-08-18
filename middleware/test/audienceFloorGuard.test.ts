/**
 * #575 — the egress guard.
 *
 * The single most consequential test here is the first one: **without an
 * audience provider, nothing is refused.** A closed floor denies everything, so
 * if "nobody configured this" were read as "closed", introducing the guard
 * would silently disable every tool in every existing deployment. The rest of
 * the file pins the opposite direction — once a deployment HAS opted in, an
 * unestablished audience must deny rather than wave things through.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMORY_RECALL_CAPABILITY,
  guardContextRecall,
  guardToolEgress,
  toolCapability,
} from '../packages/harness-orchestrator/src/audienceFloorGuard.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import type { AudienceFloor } from '../packages/harness-channel-sdk/src/audienceFloor.js';

const open = (...caps: string[]): AudienceFloor => ({
  outcome: 'open',
  capabilities: new Set(caps),
});
const closed = (reason: string): AudienceFloor => ({ outcome: 'closed', reason });

/** Runs `fn` inside a turn whose audience floor resolves to `floor`. */
async function withFloor<T>(
  floor: (() => Promise<AudienceFloor>) | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return turnContext.run(
    { turnId: 't1', turnDate: '2026-08-18', ...(floor ? { audienceFloor: floor } : {}) },
    fn,
  );
}

describe('an unconfigured deployment is not affected at all', () => {
  it('no provider installed → nothing is refused', async () => {
    // If this ever fails, every tool in every deployment without an audience
    // source stops working. "Not enforced" is not the same as "closed".
    const refusal = await withFloor(undefined, () => guardToolEgress('web_search'));
    assert.equal(refusal, undefined);
  });

  it('outside a turn context entirely → nothing is refused', async () => {
    assert.equal(await guardToolEgress('web_search'), undefined);
  });
});

describe('once a provider IS installed, the floor is enforced', () => {
  it('permits a tool the whole room may use', async () => {
    const refusal = await withFloor(
      async () => open('tool:web_search'),
      () => guardToolEgress('web_search'),
    );
    assert.equal(refusal, undefined);
  });

  it('refuses a tool that is not in the floor', async () => {
    const refusal = await withFloor(
      async () => open('tool:something_else'),
      () => guardToolEgress('web_search'),
    );
    assert.ok(refusal, 'expected a refusal');
    assert.match(refusal ?? '', /web_search/);
  });

  it('refuses everything when the floor is closed, and says why', async () => {
    const refusal = await withFloor(
      async () => closed('audience unknown (empty_roster)'),
      () => guardToolEgress('web_search'),
    );
    assert.match(refusal ?? '', /empty_roster/);
  });

  it('a throwing provider closes rather than opens', async () => {
    // The opposite of the `privacyHandle` precedent, on purpose: privacy
    // degrading to "unmodified" over-shares detail, while this degrading to
    // "allowed" performs an effect nobody authorized.
    const refusal = await withFloor(
      async () => {
        throw new Error('roster fetch failed');
      },
      () => guardToolEgress('web_search'),
    );
    assert.match(refusal ?? '', /roster fetch failed/);
  });
});

describe('the refusal is usable', () => {
  it('reads as a tool result, not an exception', async () => {
    // Throwing would abort the turn — turning a policy decision into an outage.
    const refusal = await withFloor(async () => closed('nope'), () => guardToolEgress('t'));
    assert.equal(typeof refusal, 'string');
    assert.match(refusal ?? '', /^Error: /);
  });

  it('tells the model retrying will not help', async () => {
    // Without this the model burns the turn retrying against a wall.
    const refusal = await withFloor(async () => closed('nope'), () => guardToolEgress('t'));
    assert.match(refusal ?? '', /retrying will not help/i);
  });
});

describe('capability naming', () => {
  it('a tool needs its own `tool:<name>` capability', () => {
    assert.equal(toolCapability('web_search'), 'tool:web_search');
  });

  it('holding a different tool’s capability does not transfer', async () => {
    const refusal = await withFloor(
      async () => open(toolCapability('read_file')),
      () => guardToolEgress('write_file'),
    );
    assert.ok(refusal);
  });
});

// ─── guard 2: context / memory recall ──────────────────────────────────────

describe('the context guard', () => {
  it('an unconfigured deployment recalls exactly as before', async () => {
    // Same load-bearing property as the egress guard: "not enforced" is not
    // "closed". If this fails, every deployment silently loses its memory.
    assert.equal(await withFloor(undefined, () => guardContextRecall()), undefined);
  });

  it('permits recall when the whole room may read it', async () => {
    const refusal = await withFloor(
      async () => open(MEMORY_RECALL_CAPABILITY),
      () => guardContextRecall(),
    );
    assert.equal(refusal, undefined);
  });

  it('refuses recall when someone present may not read it', async () => {
    // A shared room renders ONE prompt that everyone's reply derives from, so
    // recalled context reaches everyone. The room may only recall what
    // everyone may read.
    const refusal = await withFloor(async () => open('tool:t'), () => guardContextRecall());
    assert.match(refusal ?? '', /not every participant/);
  });

  it('a closed floor blocks recall and passes its reason through', async () => {
    const refusal = await withFloor(
      async () => closed('audience unknown (no_provider)'),
      () => guardContextRecall(),
    );
    assert.match(refusal ?? '', /no_provider/);
  });

  it('a throwing provider blocks recall rather than allowing it', async () => {
    const refusal = await withFloor(
      async () => {
        throw new Error('roster exploded');
      },
      () => guardContextRecall(),
    );
    assert.match(refusal ?? '', /roster exploded/);
  });

  it('a reason to log, not an Error string for the model', async () => {
    // Unlike a refused tool call, a refused recall has a natural degraded
    // mode — the turn proceeds without prior context. Dressing that up as an
    // error would make a policy decision look like a fault.
    const refusal = await withFloor(async () => closed('nope'), () => guardContextRecall());
    assert.ok(refusal);
    assert.doesNotMatch(refusal ?? '', /^Error: /);
  });

  it('the tool capability does NOT grant recall, and vice versa', async () => {
    // Two distinct capabilities: being allowed to run a tool says nothing
    // about being allowed to read the room's history.
    assert.ok(await withFloor(async () => open(toolCapability('t')), () => guardContextRecall()));
    assert.ok(await withFloor(async () => open(MEMORY_RECALL_CAPABILITY), () => guardToolEgress('t')));
  });
});

describe('re-evaluation, not a snapshot', () => {
  it('the provider is consulted on EVERY dispatch', async () => {
    // Spec §5.2: a turn-start snapshot is a TOCTOU hole — somebody can join
    // between the model choosing a tool and the call firing.
    let calls = 0;
    await withFloor(
      async () => {
        calls += 1;
        return open('tool:t');
      },
      async () => {
        await guardToolEgress('t');
        await guardToolEgress('t');
        await guardToolEgress('t');
      },
    );
    assert.equal(calls, 3);
  });

  it('a floor that narrows mid-turn refuses the later call', async () => {
    let joined = false;
    const refusals: (string | undefined)[] = [];
    await withFloor(
      async () => (joined ? open() : open('tool:t')),
      async () => {
        refusals.push(await guardToolEgress('t'));
        joined = true; // a less-privileged participant arrives
        refusals.push(await guardToolEgress('t'));
      },
    );
    assert.equal(refusals[0], undefined, 'permitted before the joiner');
    assert.ok(refusals[1], 'refused after the joiner');
  });
});
