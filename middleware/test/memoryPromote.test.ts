import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { InMemoryMemoryStore } from '@omadia/memory';

import {
  PROMOTION_AUDIT_PATH,
  promoteMemory,
  type PromoteRequest,
} from '../src/services/memoryPromote.js';

// ---------------------------------------------------------------------------
// W5 — `promoteMemory` (design spec #870 §6, test plan §8 item 8).
//
// Runs against an InMemoryMemoryStore so the list/delete semantics (recursive
// delete, two-levels-deep list, implicit directories) match production.
// Pollution guard (§8): every fixture is built per test in `beforeEach`; no
// module-level store, no shared state between files.
// ---------------------------------------------------------------------------

const SLUG = 'atlas';
const CHANNEL_KEY = 'teams~19-chan-a-aaaa1111';
const OTHER_CHANNEL_KEY = 'teams~19-chan-b-cccc3333';
const TEAM_KEY = 'teams~team-alpha-bbbb2222';
const USER_KEY = 'teams~user-marcel-dddd4444';

const CHANNEL_ROOT = `/memories/contexts/${SLUG}/channel/${CHANNEL_KEY}`;
const TEAM_ROOT = `/memories/contexts/${SLUG}/team/${TEAM_KEY}`;
const USER_ROOT = `/memories/contexts/${SLUG}/user/${USER_KEY}`;
const AGENT_ROOT = `/memories/orchestrators/${SLUG}`;

const AT = new Date('2026-08-26T10:00:00.000Z');

function baseRequest(overrides: Partial<PromoteRequest> = {}): PromoteRequest {
  return {
    agentSlug: SLUG,
    source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'notes/deploy.md' },
    target: { tier: 'team', ctxKey: TEAM_KEY },
    mode: 'copy',
    actor: 'operator@byte5.de',
    reason: 'team-wide runbook',
    ...overrides,
  };
}

function hasCode(code: string) {
  return (err: unknown): boolean =>
    !!err && typeof err === 'object' && (err as { code?: string }).code === code;
}

async function auditLines(store: InMemoryMemoryStore): Promise<Array<Record<string, unknown>>> {
  const raw = await store.readFile(PROMOTION_AUDIT_PATH);
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('memoryPromote (operator tier promotion)', () => {
  let store: InMemoryMemoryStore;
  let events: Array<Record<string, unknown>>;
  let options: { now: () => Date; securityAuditSink: (e: Record<string, unknown>) => void };

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    events = [];
    options = {
      now: () => AT,
      securityAuditSink: (event) => {
        events.push(event);
      },
    };
    await store.createFile(`${CHANNEL_ROOT}/notes/deploy.md`, '# Deploy\n\nrun-the-thing\n');
  });

  it('copies a channel file into the team tier with provenance, audit and receipt', async () => {
    const receipt = await promoteMemory(store, baseRequest(), options);

    const target = `${TEAM_ROOT}/notes/deploy.md`;
    assert.equal(receipt.sourcePath, `${CHANNEL_ROOT}/notes/deploy.md`);
    assert.equal(receipt.targetPath, target);
    assert.equal(receipt.mode, 'copy');
    assert.equal(receipt.ts, AT.toISOString());
    assert.equal(receipt.files.length, 1);
    assert.equal(receipt.files[0]?.provenance, true);

    // Copy leaves the source in place.
    assert.equal(await store.fileExists(`${CHANNEL_ROOT}/notes/deploy.md`), true);

    // (b) provenance frontmatter in the target file.
    const content = await store.readFile(target);
    assert.match(content, /^---\n/);
    assert.match(content, /promoted-from: "\/memories\/contexts\/atlas\/channel\//);
    assert.match(content, /promoted-by: "operator@byte5\.de"/);
    assert.match(content, /promoted-at: "2026-08-26T10:00:00\.000Z"/);
    assert.match(content, /run-the-thing/);

    // (a) one JSONL audit line in the shared core namespace.
    const lines = await auditLines(store);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], {
      ts: AT.toISOString(),
      agentSlug: SLUG,
      actor: 'operator@byte5.de',
      mode: 'copy',
      sourcePath: `${CHANNEL_ROOT}/notes/deploy.md`,
      targetPath: target,
      reason: 'team-wide runbook',
      bytes: receipt.bytes,
      files: 1,
    });

    // (c) structured [security-audit] event.
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'memory.promote');
    assert.equal(events[0]?.targetPath, target);
  });

  it('lands the promoted file exactly under the target tier root the scope grammar compiles', async () => {
    const receipt = await promoteMemory(store, baseRequest(), options);
    // `team:<ctxKey>:*` compiles to `/memories/contexts/<slug>/team/<ctxKey>/`,
    // so a turn bound to that team reads the promoted file (spec §3).
    assert.ok(receipt.targetPath.startsWith(`${TEAM_ROOT}/`));
    assert.equal(await store.fileExists(receipt.targetPath), true);
  });

  it('move removes the source and keeps the target', async () => {
    await promoteMemory(store, baseRequest({ mode: 'move' }), options);

    assert.equal(await store.fileExists(`${CHANNEL_ROOT}/notes/deploy.md`), false);
    assert.equal(await store.fileExists(`${TEAM_ROOT}/notes/deploy.md`), true);
    const lines = await auditLines(store);
    assert.equal(lines[0]?.mode, 'move');
  });

  it('copies a subtree deeper than the two-level list walk, preserving structure', async () => {
    await store.createFile(`${CHANNEL_ROOT}/runbooks/db/restore/steps.md`, 'restore\n');
    await store.createFile(`${CHANNEL_ROOT}/runbooks/db/backup.md`, 'backup\n');
    await store.createFile(`${CHANNEL_ROOT}/runbooks/index.md`, 'index\n');

    const receipt = await promoteMemory(
      store,
      baseRequest({
        source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'runbooks' },
        target: { tier: 'agent' },
      }),
      options,
    );

    assert.equal(receipt.files.length, 3);
    assert.equal(await store.fileExists(`${AGENT_ROOT}/runbooks/db/restore/steps.md`), true);
    assert.equal(await store.fileExists(`${AGENT_ROOT}/runbooks/db/backup.md`), true);
    assert.equal(await store.fileExists(`${AGENT_ROOT}/runbooks/index.md`), true);
    assert.match(await store.readFile(`${AGENT_ROOT}/runbooks/db/backup.md`), /promoted-from:/);
    // Untouched neighbour file stays in the channel tier.
    assert.equal(await store.fileExists(`${CHANNEL_ROOT}/notes/deploy.md`), true);
  });

  it('move of a subtree deletes the whole source tree', async () => {
    await store.createFile(`${CHANNEL_ROOT}/runbooks/db/backup.md`, 'backup\n');
    await store.createFile(`${CHANNEL_ROOT}/runbooks/index.md`, 'index\n');

    await promoteMemory(
      store,
      baseRequest({
        source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'runbooks' },
        target: { tier: 'agent' },
        mode: 'move',
      }),
      options,
    );

    assert.equal(await store.directoryExists(`${CHANNEL_ROOT}/runbooks`), false);
    assert.equal(await store.fileExists(`${AGENT_ROOT}/runbooks/db/backup.md`), true);
    assert.equal(await store.fileExists(`${AGENT_ROOT}/runbooks/index.md`), true);
  });

  it('promotes team and user tiers into the agent tier', async () => {
    await store.createFile(`${TEAM_ROOT}/conventions.md`, 'team-convention\n');
    await store.createFile(`${USER_ROOT}/prefs.md`, 'user-pref\n');

    await promoteMemory(
      store,
      baseRequest({
        source: { axis: 'team', ctxKey: TEAM_KEY, path: 'conventions.md' },
        target: { tier: 'agent' },
      }),
      options,
    );
    await promoteMemory(
      store,
      baseRequest({
        source: { axis: 'user', ctxKey: USER_KEY, path: 'prefs.md' },
        target: { tier: 'agent', path: 'people/marcel.md' },
      }),
      options,
    );

    assert.equal(await store.fileExists(`${AGENT_ROOT}/conventions.md`), true);
    assert.equal(await store.fileExists(`${AGENT_ROOT}/people/marcel.md`), true);
    assert.equal((await auditLines(store)).length, 2);
  });

  it('rejects every target that would land outside the requesting agent', async () => {
    const cases: Array<{ req: PromoteRequest; code: string }> = [
      {
        req: baseRequest({ target: { tier: 'team', ctxKey: '../../other-agent/team/x' } }),
        code: 'invalid_ctx_key',
      },
      {
        req: baseRequest({
          target: { tier: 'agent', path: '../../orchestrators/other-agent/stolen.md' },
        }),
        code: 'invalid_path',
      },
      {
        req: baseRequest({ target: { tier: 'agent', path: '/memories/orchestrators/other/x.md' } }),
        code: 'invalid_path',
      },
      {
        req: baseRequest({ target: { tier: 'agent', ctxKey: TEAM_KEY } }),
        code: 'invalid_ctx_key',
      },
      {
        req: baseRequest({ agentSlug: '../other-agent' }),
        code: 'invalid_agent_slug',
      },
      {
        req: baseRequest({
          source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: '../../../orchestrators/other/x.md' },
        }),
        code: 'invalid_path',
      },
      {
        req: baseRequest({ target: { tier: 'nowhere' as 'agent' } }),
        code: 'invalid_tier',
      },
      {
        req: baseRequest({ actor: '   ' }),
        code: 'actor_required',
      },
    ];

    for (const { req, code } of cases) {
      await assert.rejects(() => promoteMemory(store, req, options), hasCode(code), code);
    }

    // Nothing was written, nothing was audited.
    assert.equal(await store.directoryExists(TEAM_ROOT), false);
    assert.equal(await store.directoryExists(AGENT_ROOT), false);
    assert.equal(await store.fileExists(PROMOTION_AUDIT_PATH), false);
    assert.equal(events.length, 0);
  });

  it('refuses a promotion onto its own source and a missing source', async () => {
    await assert.rejects(
      () =>
        promoteMemory(
          store,
          baseRequest({
            source: { axis: 'team', ctxKey: TEAM_KEY, path: 'x.md' },
            target: { tier: 'team', ctxKey: TEAM_KEY, path: 'x.md' },
          }),
          options,
        ),
      hasCode('target_overlaps_source'),
    );

    await assert.rejects(
      () =>
        promoteMemory(
          store,
          baseRequest({
            source: { axis: 'channel', ctxKey: OTHER_CHANNEL_KEY, path: 'nothing.md' },
          }),
          options,
        ),
      hasCode('source_not_found'),
    );
  });

  it('refuses a target NESTED inside the source, which move would destroy', async () => {
    // Equality is not enough. A nested target passes every other guard — it is
    // legitimately under the same agent — and then `move`'s recursive delete of
    // the source wipes the freshly written target with it: net knowledge
    // destroyed, reported as a success. Reachable with valid typed input.
    await store.createFile(`${TEAM_ROOT}/notes/a.md`, 'A');
    await store.createFile(`${TEAM_ROOT}/notes/b.md`, 'B');

    for (const mode of ['copy', 'move'] as const) {
      await assert.rejects(
        () =>
          promoteMemory(
            store,
            baseRequest({
              mode,
              source: { axis: 'team', ctxKey: TEAM_KEY, path: 'notes' },
              target: { tier: 'team', ctxKey: TEAM_KEY, path: 'notes/archive' },
            }),
            options,
          ),
        hasCode('target_overlaps_source'),
        `nested target must be refused for mode=${mode}`,
      );
      // And the mirror nesting: source inside target.
      await assert.rejects(
        () =>
          promoteMemory(
            store,
            baseRequest({
              mode,
              source: { axis: 'team', ctxKey: TEAM_KEY, path: 'notes/a.md' },
              target: { tier: 'team', ctxKey: TEAM_KEY, path: 'notes' },
            }),
            options,
          ),
        hasCode('target_overlaps_source'),
        `nested source must be refused for mode=${mode}`,
      );
    }

    assert.equal(await store.readFile(`${TEAM_ROOT}/notes/a.md`), 'A');
    assert.equal(await store.readFile(`${TEAM_ROOT}/notes/b.md`), 'B');
  });

  it('a move never destroys a file it did not copy', async () => {
    // `collectFiles` enumerates via `store.list()`, whose walk skips entries
    // whose name starts with `.` — identically in the in-memory and Postgres
    // stores. A recursive `delete(sourceRoot)` has no such filter, so a dotfile
    // was deleted from the source having never been written to the target,
    // with the receipt and the audit line both reporting success.
    await store.createFile(`${CHANNEL_ROOT}/runbooks/index.md`, 'visible');
    await store.createFile(`${CHANNEL_ROOT}/runbooks/.secrets.md`, 'invisible to list()');

    const receipt = await promoteMemory(
      store,
      baseRequest({
        mode: 'move',
        source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'runbooks' },
        target: { tier: 'agent', path: 'runbooks' },
      }),
      options,
    );

    // What WAS planned moved.
    assert.deepEqual(
      receipt.files.map((f) => f.sourcePath),
      [`${CHANNEL_ROOT}/runbooks/index.md`],
    );
    assert.match(await store.readFile(`${AGENT_ROOT}/runbooks/index.md`), /\nvisible$/);
    assert.equal(await store.fileExists(`${CHANNEL_ROOT}/runbooks/index.md`), false);

    // What was NOT planned is still exactly where it was — never silently gone.
    assert.equal(
      await store.readFile(`${CHANNEL_ROOT}/runbooks/.secrets.md`),
      'invisible to list()',
    );
  });

  it('refuses to overwrite an existing target and writes nothing at all', async () => {
    await store.createFile(`${CHANNEL_ROOT}/runbooks/a.md`, 'a\n');
    await store.createFile(`${CHANNEL_ROOT}/runbooks/b.md`, 'b\n');
    await store.createFile(`${AGENT_ROOT}/runbooks/b.md`, 'existing-b\n');

    const req = baseRequest({
      source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'runbooks' },
      target: { tier: 'agent' },
      mode: 'move',
    });

    await assert.rejects(() => promoteMemory(store, req, options), hasCode('target_exists'));

    // Pre-flight conflict check: no sibling was written, no source was moved.
    assert.equal(await store.fileExists(`${AGENT_ROOT}/runbooks/a.md`), false);
    assert.equal(await store.readFile(`${AGENT_ROOT}/runbooks/b.md`), 'existing-b\n');
    assert.equal(await store.fileExists(`${CHANNEL_ROOT}/runbooks/a.md`), true);
    assert.equal(await store.fileExists(PROMOTION_AUDIT_PATH), false);

    // Explicit opt-in overwrites.
    const receipt = await promoteMemory(store, { ...req, overwrite: true }, options);
    assert.equal(receipt.files.length, 2);
    assert.match(await store.readFile(`${AGENT_ROOT}/runbooks/b.md`), /^---\npromoted-from:/);
  });

  it('appends one audit line per promotion', async () => {
    await store.createFile(`${CHANNEL_ROOT}/notes/second.md`, 'second\n');

    await promoteMemory(store, baseRequest(), options);
    await promoteMemory(
      store,
      baseRequest({
        source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'notes/second.md' },
        mode: 'move',
        reason: undefined,
      }),
      options,
    );

    const lines = await auditLines(store);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.mode, 'copy');
    assert.equal(lines[1]?.mode, 'move');
    assert.equal('reason' in (lines[1] ?? {}), false);
  });

  it('merges provenance into an existing frontmatter block instead of stacking one', async () => {
    await store.createFile(
      `${CHANNEL_ROOT}/notes/tagged.md`,
      '---\ntitle: "Runbook"\npromoted-from: "/memories/contexts/atlas/user/old"\n---\n\nbody\n',
    );

    await promoteMemory(
      store,
      baseRequest({
        source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'notes/tagged.md' },
      }),
      options,
    );

    const content = await store.readFile(`${TEAM_ROOT}/notes/tagged.md`);
    assert.equal(content.split('---\n').length - 1, 2, 'exactly one frontmatter block');
    assert.match(content, /title: "Runbook"/);
    assert.equal(content.includes('/memories/contexts/atlas/user/old'), false);
    assert.match(content, /promoted-from: "\/memories\/contexts\/atlas\/channel\/[^"]+\/notes\/tagged\.md"/);
    assert.match(content, /\nbody\n$/);
  });

  it('leaves non-markdown payloads byte-identical (no frontmatter injection)', async () => {
    const json = '{"threshold":3}\n';
    await store.createFile(`${CHANNEL_ROOT}/config/limits.json`, json);

    const receipt = await promoteMemory(
      store,
      baseRequest({
        source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'config/limits.json' },
        target: { tier: 'agent' },
      }),
      options,
    );

    assert.equal(receipt.files[0]?.provenance, false);
    assert.equal(await store.readFile(`${AGENT_ROOT}/config/limits.json`), json);
    // The JSONL audit line still records it.
    assert.equal((await auditLines(store))[0]?.targetPath, `${AGENT_ROOT}/config/limits.json`);
  });
});
