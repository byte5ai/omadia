/**
 * #2042 follow-up — an agent's own name stays masked in its own turn when an
 * ACTIVE user bears it as display, first or last name (the users table feeds
 * `AgentRuntimeConfig.humanNames` through the kernel's `humanNames@1`).
 *
 * Covers the directory's snapshot cache (invalidation, TTL, fail safe before
 * the first load and after a failed one) and the end-to-end effect on the
 * REAL privacy-guard service. Values are synthetic. The real users table:
 * humanNamesFromUsers.pg.test.ts.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseDocument } from 'yaml';
import { parseCapabilityRef } from '@omadia/plugin-api';
import type { PromptPiiDetector, PromptPiiSpan } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

import { agentOwnNames } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import { HUMAN_NAMES_SERVICE } from '../packages/harness-orchestrator/src/plugin.js';
import {
  createUserHumanNameDirectory,
  HumanNameDirectory,
  humanNamesOf,
  type HumanNameSource,
} from '../src/auth/humanNameDirectory.js';

interface FakeUser {
  readonly displayName: string;
  readonly status: 'active' | 'disabled';
}

/** A users table stand-in with the UserStore read + change hook. */
function fakeUsers(initial: readonly FakeUser[]): HumanNameSource & {
  set(users: readonly FakeUser[]): void;
  loads: number;
} {
  let users = initial;
  const listeners = new Set<() => void>();
  const source = {
    loads: 0,
    async listActiveDisplayNames(): Promise<readonly string[]> {
      source.loads += 1;
      return users.filter((u) => u.status === 'active').map((u) => u.displayName);
    },
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: readonly FakeUser[]): void {
      users = next;
      for (const l of listeners) l();
    },
  };
  return source;
}

/** Wait for the directory's background load(s) to land. */
async function settled(directory: HumanNameDirectory): Promise<void> {
  await directory.refresh();
}

const KAREN_AGENT = { speaker: { displayName: 'Karen', slug: 'karen' } } as const;

/** A C1 stand-in that finds the given names, as the GLiNER sidecar would. */
function namesC1(...names: readonly string[]): PromptPiiDetector {
  return {
    id: 'c1-test',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      const spans: PromptPiiSpan[] = [];
      for (const name of names) {
        for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
          spans.push({ start: at, end: at + name.length, type: 'person', confidence: 0.99 });
        }
      }
      return spans;
    },
  };
}

describe('humanNamesOf — display, first and last name', () => {
  it('splits a display name into the full name, first and last word', () => {
    assert.deepEqual(humanNamesOf('  Karen   Müller '), ['Karen Müller', 'Karen', 'Müller']);
    assert.deepEqual(humanNamesOf('Anna Maria Schmidt'), ['Anna Maria Schmidt', 'Anna', 'Schmidt']);
    assert.deepEqual(humanNamesOf('Cher'), ['Cher']);
    assert.deepEqual(humanNamesOf('   '), []);
  });
});

describe('agentOwnNames with the users-backed human names', () => {
  it('drops "Karen" when an active user is "Karen Müller" (first name counts)', async () => {
    const directory = createUserHumanNameDirectory(
      fakeUsers([{ displayName: 'Karen Müller', status: 'active' }]),
    );
    await settled(directory);
    assert.deepEqual(agentOwnNames({ ...KAREN_AGENT, humanNames: directory.snapshot() }), []);
  });

  it('drops a full-name match, case-insensitive and trimmed', async () => {
    const directory = createUserHumanNameDirectory(
      fakeUsers([{ displayName: ' karen müller ', status: 'active' }]),
    );
    await settled(directory);
    assert.deepEqual(
      agentOwnNames({
        speaker: { displayName: 'Karen Müller', slug: 'kmueller' },
        humanNames: directory.snapshot(),
      }),
      ['kmueller'],
    );
  });

  it('exempts "Karen" again when the user Karen Müller is disabled', async () => {
    const directory = createUserHumanNameDirectory(
      fakeUsers([{ displayName: 'Karen Müller', status: 'disabled' }]),
    );
    await settled(directory);
    assert.deepEqual(directory.snapshot(), []);
    assert.deepEqual(agentOwnNames({ ...KAREN_AGENT, humanNames: directory.snapshot() }), [
      'Karen',
      'karen',
    ]);
  });

  it('exempts no own name while the human names are unknown (null)', () => {
    assert.deepEqual(agentOwnNames({ ...KAREN_AGENT, humanNames: null }), []);
    // Absent stays "no known humans" (hosts without a users table).
    assert.deepEqual(agentOwnNames(KAREN_AGENT), ['Karen', 'karen']);
  });
});

describe('HumanNameDirectory — snapshot cache', () => {
  it('is unknown before the first load completes', async () => {
    let release: (names: readonly string[]) => void = () => undefined;
    const directory = new HumanNameDirectory({
      loadDisplayNames: () =>
        new Promise<readonly string[]>((resolve) => {
          release = resolve;
        }),
    });
    assert.equal(directory.snapshot(), null);
    assert.deepEqual(agentOwnNames({ ...KAREN_AGENT, humanNames: directory.snapshot() }), []);
    release(['Erika Muster']);
    await settled(directory);
    assert.deepEqual(directory.snapshot(), ['Erika Muster', 'Erika', 'Muster']);
  });

  it('picks up a user change after invalidation', async () => {
    const users = fakeUsers([{ displayName: 'Erika Muster', status: 'active' }]);
    const directory = createUserHumanNameDirectory(users);
    await settled(directory);
    assert.deepEqual(agentOwnNames({ ...KAREN_AGENT, humanNames: directory.snapshot() }), [
      'Karen',
      'karen',
    ]);

    users.set([
      { displayName: 'Erika Muster', status: 'active' },
      { displayName: 'Karen Müller', status: 'active' },
    ]);
    await settled(directory);
    assert.deepEqual(agentOwnNames({ ...KAREN_AGENT, humanNames: directory.snapshot() }), []);

    users.set([{ displayName: 'Karen Müller', status: 'disabled' }]);
    await settled(directory);
    assert.deepEqual(directory.snapshot(), []);
  });

  it('reloads again when a change lands during a running load', async () => {
    const users = fakeUsers([]);
    const directory = createUserHumanNameDirectory(users);
    // The first load is in flight; the change must not be lost to it.
    users.set([{ displayName: 'Karen Müller', status: 'active' }]);
    await settled(directory);
    await settled(directory);
    assert.ok(directory.snapshot()?.includes('Karen'));
  });

  it('reloads after the TTL and serves the last snapshot meanwhile', async () => {
    let now = 0;
    const users = fakeUsers([{ displayName: 'Erika Muster', status: 'active' }]);
    const directory = createUserHumanNameDirectory(users, { ttlMs: 1_000, now: () => now });
    await settled(directory);
    const loadsAfterStart = users.loads;
    assert.deepEqual(directory.snapshot(), ['Erika Muster', 'Erika', 'Muster']);
    assert.equal(users.loads, loadsAfterStart, 'a fresh snapshot does not reload');

    now = 1_000;
    assert.deepEqual(directory.snapshot(), ['Erika Muster', 'Erika', 'Muster'], 'stale is served');
    await settled(directory);
    assert.equal(users.loads, loadsAfterStart + 1);
  });

  it('turns unknown after a failed load and never logs a name', async () => {
    let fail = false;
    const logged: string[] = [];
    const directory = new HumanNameDirectory({
      loadDisplayNames: async () => {
        if (fail) throw new Error('connection refused');
        return ['Karen Müller'];
      },
      log: (m) => logged.push(m),
    });
    await directory.refresh();
    assert.ok(directory.snapshot()?.includes('Karen'));
    fail = true;
    directory.invalidate();
    await settled(directory);
    assert.equal(directory.snapshot(), null);
    assert.equal(logged.length, 1);
    assert.ok(!logged.join(' ').includes('Karen'), 'no name in the log');
  });
});

describe('end to end — Karen\'s own turn with a colleague Karen Müller', () => {
  it('keeps "Karen" masked in recalled context', async () => {
    const directory = createUserHumanNameDirectory(
      fakeUsers([{ displayName: 'Karen Müller', status: 'active' }]),
    );
    await settled(directory);
    const svc = createPrivacyGuardService({
      c1Detector: namesC1('Karen'),
      readConfig: (key: string) => (key === 'mask_user_prompt' ? 'on' : undefined),
    });
    const text = 'Ich bin Karen, ein KI-Agent.';
    const result = await svc.maskReplayedAnswer!({
      sessionId: 's-karen',
      turnId: 't-karen',
      text,
      ownNames: agentOwnNames({ ...KAREN_AGENT, humanNames: directory.snapshot() }),
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(!result.maskedText.includes('Karen'), result.maskedText);
    assert.deepEqual(result.spans.map((s) => s.type), ['person']);
  });

  it('leaves "Karen" unmasked once that user is disabled', async () => {
    const directory = createUserHumanNameDirectory(
      fakeUsers([{ displayName: 'Karen Müller', status: 'disabled' }]),
    );
    await settled(directory);
    const svc = createPrivacyGuardService({
      c1Detector: namesC1('Karen'),
      readConfig: (key: string) => (key === 'mask_user_prompt' ? 'on' : undefined),
    });
    const text = 'Ich bin Karen, ein KI-Agent.';
    const result = await svc.maskReplayedAnswer!({
      sessionId: 's-karen-2',
      turnId: 't-karen-2',
      text,
      ownNames: agentOwnNames({ ...KAREN_AGENT, humanNames: directory.snapshot() }),
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.maskedText, text);
  });
});

describe('humanNames@1 — manifest declaration', () => {
  it('the orchestrator manifest declares the service it resolves per turn', () => {
    const manifest = path.resolve(
      import.meta.dirname,
      '..',
      'packages/harness-orchestrator/manifest.yaml',
    );
    const raw = parseDocument(readFileSync(manifest, 'utf8')).get('optional_requires');
    const names = ((raw as { toJSON: () => unknown }).toJSON() as unknown[])
      .filter((e): e is string => typeof e === 'string')
      .map((e) => parseCapabilityRef(e).name);
    assert.equal(HUMAN_NAMES_SERVICE, 'humanNames');
    assert.ok(names.includes(HUMAN_NAMES_SERVICE));
  });
});
