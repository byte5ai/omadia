import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  DiffApplyError,
  DiffApplyService,
} from '../../src/devplatform/diffApplyService.js';
import {
  GithubForgeClient,
  type ForgeFetch,
} from '../../src/devplatform/githubForgeClient.js';
import {
  DiffContextMismatchError,
  DiffStructureError,
} from '../../src/devplatform/policy/parseUnifiedDiff.js';

const isWrite = (url: string) =>
  ['/git/blobs', '/git/trees', '/git/commits', '/git/refs', '/pulls'].some((s) => url.endsWith(s));

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** Records every call and answers each GitHub git-data endpoint with a canned 2xx. */
function recordingFetch(baseContents: Record<string, string> = {}) {
  const calls: Call[] = [];
  let blobSeq = 0;
  const fetch: ForgeFetch = (url, init) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'GET' && url.includes('/contents/')) {
      const path = decodeURIComponent(url.split('/contents/')[1]?.split('?')[0] ?? '');
      const content = Buffer.from(baseContents[path] ?? '', 'utf8').toString('base64');
      return jsonOk({ content, encoding: 'base64' });
    }
    if (url.endsWith('/git/blobs')) return jsonOk({ sha: `blob-${++blobSeq}` });
    if (url.endsWith('/git/trees')) return jsonOk({ sha: 'tree-sha' });
    if (url.endsWith('/git/commits')) return jsonOk({ sha: 'commit-sha' });
    if (url.endsWith('/git/refs')) return jsonOk({ ref: 'refs/heads/x', object: { sha: 'commit-sha' } });
    if (url.endsWith('/pulls')) {
      return jsonOk({ number: 42, html_url: 'https://github.com/acme/widgets/pull/42' });
    }
    throw new Error(`unexpected call: ${init.method} ${url}`);
  };
  return { fetch, calls };
}

const JOB = { id: 'job1', branch: 'omadia/job-abcd1234-fix', baseSha: 'base0000sha' };
const REPO = { owner: 'acme', name: 'widgets', defaultBranch: 'main' };
const PR = { title: 'Fix the thing', body: 'Automated apply' };

const ADD_AND_DELETE = [
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-line1',
  '-line2',
  '',
].join('\n');

function service(fetch: ForgeFetch, opts?: { token?: string }) {
  const forge = new GithubForgeClient({ token: opts?.token ?? 'ghs_apply', fetch, now: () => new Date('2020-01-01T00:00:00Z') });
  return new DiffApplyService({ forge });
}

describe('DiffApplyService.apply', () => {
  it('builds blobs -> tree(base=base_sha) -> commit -> a fresh ref, then the PR', async () => {
    const { fetch, calls } = recordingFetch();
    const result = await service(fetch).apply({
      job: JOB,
      repo: REPO,
      diff: ADD_AND_DELETE,
      numstat: '2\t0\tnew.txt\n0\t2\tgone.txt\n',
      pr: PR,
    });

    const seq = calls.map((c) => `${c.method} ${c.url.replace('https://api.github.com', '')}`);
    assert.deepEqual(seq, [
      'POST /repos/acme/widgets/git/blobs', // the add; the delete needs no blob
      'POST /repos/acme/widgets/git/trees',
      'POST /repos/acme/widgets/git/commits',
      'POST /repos/acme/widgets/git/refs',
      'POST /repos/acme/widgets/pulls',
    ]);

    const tree = calls.find((c) => c.url.endsWith('/git/trees'))?.body as {
      base_tree: string;
      tree: Array<{ path: string; sha: string | null }>;
    };
    assert.equal(tree.base_tree, 'base0000sha');
    assert.deepEqual(
      tree.tree.find((e) => e.path === 'gone.txt'),
      { path: 'gone.txt', mode: '100644', type: 'blob', sha: null },
    );
    assert.equal(tree.tree.find((e) => e.path === 'new.txt')?.sha, 'blob-1');

    const ref = calls.find((c) => c.url.endsWith('/git/refs'))?.body as { ref: string; sha: string };
    assert.equal(ref.ref, 'refs/heads/omadia/job-abcd1234-fix');
    assert.equal(ref.sha, 'commit-sha');

    assert.deepEqual(result, {
      prUrl: 'https://github.com/acme/widgets/pull/42',
      prNumber: 42,
      commitSha: 'commit-sha',
      branch: 'omadia/job-abcd1234-fix',
    });
  });

  it('creates the ref via POST /git/refs (create, never update an existing ref)', async () => {
    const { fetch, calls } = recordingFetch();
    await service(fetch).apply({
      job: JOB,
      repo: REPO,
      diff: ADD_AND_DELETE,
      numstat: '2\t0\tnew.txt\n0\t2\tgone.txt\n',
      pr: PR,
    });
    const refCalls = calls.filter((c) => c.url.includes('/git/refs'));
    assert.equal(refCalls.length, 1);
    assert.equal(refCalls[0]?.method, 'POST');
    // A PATCH to /git/refs/heads/... would be an update — must never happen.
    assert.ok(!calls.some((c) => c.method === 'PATCH'));
  });

  it('aborts on a numstat mismatch BEFORE any HTTP write', async () => {
    const { fetch, calls } = recordingFetch();
    await assert.rejects(
      () =>
        service(fetch).apply({
          job: JOB,
          repo: REPO,
          diff: ADD_AND_DELETE,
          numstat: '2\t0\tnew.txt\n0\t3\tgone.txt\n', // claims one deletion too many
          pr: PR,
        }),
      (err: unknown) => err instanceof DiffApplyError && err.code === 'numstat_mismatch',
    );
    assert.equal(calls.length, 0);
  });

  it('reconstructs modify content from the pinned base blob and posts it', async () => {
    const { fetch, calls } = recordingFetch({ 'f.txt': 'a\nb\nc\n' });
    await service(fetch).apply({
      job: JOB,
      repo: REPO,
      diff: [
        'diff --git a/f.txt b/f.txt',
        'index 1..2 100644',
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+B',
        ' c',
        '',
      ].join('\n'),
      numstat: '1\t1\tf.txt\n',
      pr: PR,
    });

    const getBase = calls.find((c) => c.method === 'GET' && c.url.includes('/contents/'));
    assert.ok(getBase, 'expected a GET of the base blob at base_sha');
    assert.match(getBase.url, /ref=base0000sha/);

    const blob = calls.find((c) => c.url.endsWith('/git/blobs'))?.body as {
      content: string;
      encoding: string;
    };
    assert.equal(blob.content, 'a\nB\nc\n');
    assert.equal(blob.encoding, 'utf-8');
  });

  it("fails closed when the diff's deletion line does not match the base (reviewer repro)", async () => {
    // Base holds SECRET_CHECK() at line 2; the diff claims to delete "harmless".
    const { fetch, calls } = recordingFetch({ 'f.txt': 'line1\nSECRET_CHECK()\nline3\n' });
    await assert.rejects(
      () =>
        service(fetch).apply({
          job: JOB,
          repo: REPO,
          diff: [
            'diff --git a/f.txt b/f.txt',
            'index 1..2 100644',
            '--- a/f.txt',
            '+++ b/f.txt',
            '@@ -1,3 +1,3 @@',
            ' line1',
            '-harmless',
            '+replaced',
            ' line3',
            '',
          ].join('\n'),
          numstat: '1\t1\tf.txt\n', // totals match — only the base check catches it
          pr: PR,
        }),
      (err: unknown) => err instanceof DiffContextMismatchError,
    );
    // The base blob GET is required to detect the mismatch; NO write may happen.
    assert.equal(calls.filter((c) => isWrite(c.url)).length, 0);
  });

  it('fails closed (before any call) on a hunk header that under-declares its body', async () => {
    const { fetch, calls } = recordingFetch();
    await assert.rejects(
      () =>
        service(fetch).apply({
          job: JOB,
          repo: REPO,
          diff: [
            'diff --git a/x.txt b/x.txt',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/x.txt',
            '@@ -0,0 +1,1 @@', // declares 1 added line...
            '+one',
            '+two', // ...but the body has 2
            '',
          ].join('\n'),
          numstat: '2\t0\tx.txt\n', // attacker matches the understated total
          pr: PR,
        }),
      (err: unknown) => err instanceof DiffStructureError,
    );
    assert.equal(calls.length, 0);
  });

  it('refuses a .git/** path locally, and writes nothing', async () => {
    const { fetch, calls } = recordingFetch();
    await assert.rejects(
      () =>
        service(fetch).apply({
          job: JOB,
          repo: REPO,
          diff: [
            'diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/.git/hooks/pre-commit',
            '@@ -0,0 +1 @@',
            '+evil',
            '',
          ].join('\n'),
          numstat: '1\t0\t.git/hooks/pre-commit\n',
          pr: PR,
        }),
      (err: unknown) => err instanceof DiffApplyError && err.code === 'path_escape',
    );
    assert.equal(calls.length, 0);
  });

  it('refuses a path that escapes the repo, and writes nothing', async () => {
    const { fetch, calls } = recordingFetch();
    await assert.rejects(
      () =>
        service(fetch).apply({
          job: JOB,
          repo: REPO,
          diff: [
            'diff --git a/../evil b/../evil',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/../evil',
            '@@ -0,0 +1 @@',
            '+pwned',
            '',
          ].join('\n'),
          numstat: '1\t0\t../evil\n',
          pr: PR,
        }),
      (err: unknown) => err instanceof DiffApplyError && err.code === 'path_escape',
    );
    assert.equal(calls.length, 0);
  });

  it('DENIES an added credential (policy_deny), rides the verdict, and writes nothing', async () => {
    // A GitHub PAT prefix + 36 body chars — assembled at runtime so the source
    // file carries no literal token (SecurityPipeline hook).
    const token = 'ghp' + '_' + 'A'.repeat(36);
    const { fetch, calls } = recordingFetch();
    const err = await service(fetch)
      .apply({
        job: JOB,
        repo: REPO,
        diff: [
          'diff --git a/config.txt b/config.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/config.txt',
          '@@ -0,0 +1 @@',
          `+token=${token}`,
          '',
        ].join('\n'),
        numstat: '1\t0\tconfig.txt\n',
        pr: PR,
        jobTokens: [],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(err instanceof DiffApplyError && err.code === 'policy_deny', 'expected policy_deny');
    // The verdict must ride the error so the caller can persist findings.
    assert.equal((err as DiffApplyError).verdict?.decision, 'deny');
    assert.ok(
      (err as DiffApplyError).verdict?.findings.some((r) => r.ruleId === 'credential-content'),
      'verdict carries the credential-content reason',
    );
    assert.equal(calls.length, 0);
  });

  it('GATES a protected CI change (policy_gate), rides the verdict, and writes nothing', async () => {
    const { fetch, calls } = recordingFetch();
    const err = await service(fetch)
      .apply({
        job: JOB,
        repo: REPO,
        diff: [
          'diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/.github/workflows/deploy.yml',
          '@@ -0,0 +1 @@',
          '+on: push',
          '',
        ].join('\n'),
        numstat: '1\t0\t.github/workflows/deploy.yml\n',
        pr: PR,
        jobTokens: [],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(err instanceof DiffApplyError && err.code === 'policy_gate', 'expected policy_gate');
    assert.equal((err as DiffApplyError).verdict?.decision, 'gate');
    assert.ok(
      (err as DiffApplyError).verdict?.findings.some((r) => r.ruleId === 'protected-ci'),
      'verdict carries the protected-ci reason',
    );
    assert.equal(calls.length, 0);
  });
});
