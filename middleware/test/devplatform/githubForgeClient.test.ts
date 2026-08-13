import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ForgeHttpError,
  GithubForgeClient,
  InvalidJobBranchError,
  UnsupportedModeError,
  assertJobBranch,
  type ForgeFetch,
} from '../../src/devplatform/githubForgeClient.js';
import {
  NotImplementedError,
  type ApplyDiffInput,
  type ForgeFileChange,
} from '../../src/devplatform/forgeClient.js';
import type { DiffHunk } from '../../src/devplatform/policy/parseUnifiedDiff.js';

interface Captured {
  url: string;
  init: Parameters<ForgeFetch>[1];
}

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

function capturing(status: number, body: unknown, bodyProbe?: { read: boolean }) {
  const captured: Captured[] = [];
  const fetch: ForgeFetch = (url, init) => {
    captured.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => {
        if (bodyProbe) bodyProbe.read = true;
        return Promise.resolve(body);
      },
    });
  };
  return { fetch, captured };
}

function client(fetch: ForgeFetch, token = 'ghs_secret') {
  return new GithubForgeClient({ token, fetch });
}

describe('GithubForgeClient.createPR', () => {
  it('POSTs the pulls payload with maintainer_can_modify and the required headers', async () => {
    const { fetch, captured } = capturing(201, {
      number: 7,
      html_url: 'https://github.com/acme/widgets/pull/7',
    });
    const result = await client(fetch).createPR({
      owner: 'acme',
      repo: 'widgets',
      head: 'omadia/job-1',
      base: 'main',
      title: 'T',
      body: 'B',
    });

    assert.deepEqual(result, { prUrl: 'https://github.com/acme/widgets/pull/7', prNumber: 7 });
    const call = captured[0];
    assert.ok(call);
    assert.match(call.url, /\/repos\/acme\/widgets\/pulls$/);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['Authorization'], 'Bearer ghs_secret');
    assert.equal(call.init.headers['Accept'], 'application/vnd.github+json');
    assert.equal(call.init.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    const sent = JSON.parse(call.init.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(sent, {
      title: 'T',
      head: 'omadia/job-1',
      base: 'main',
      body: 'B',
      maintainer_can_modify: true,
    });
  });

  it('never echoes the response body on an error, and does not even read it', async () => {
    const probe = { read: false };
    const { fetch } = capturing(422, { message: 'reflected ghs_secret token here' }, probe);
    await assert.rejects(
      () =>
        client(fetch).createPR({
          owner: 'acme',
          repo: 'widgets',
          head: 'h',
          base: 'main',
          title: 'T',
          body: 'B',
        }),
      (err: unknown) => {
        assert.ok(err instanceof ForgeHttpError);
        assert.equal(err.status, 422);
        assert.doesNotMatch(err.message, /ghs_secret|reflected|token here/);
        return true;
      },
    );
    assert.equal(probe.read, false, 'the error path must not read the response body');
  });
});

describe('GithubForgeClient issue reads', () => {
  it('getIssue maps the fields it needs', async () => {
    const { fetch } = capturing(200, {
      number: 12,
      title: 'Bug',
      body: 'repro',
      state: 'open',
      html_url: 'https://github.com/acme/widgets/issues/12',
      labels: [{ name: 'bug' }, 'triage'],
    });
    const issue = await client(fetch).getIssue('acme', 'widgets', 12);
    assert.deepEqual(issue, {
      number: 12,
      title: 'Bug',
      body: 'repro',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/12',
      labels: ['bug', 'triage'],
    });
  });

  it('listOpenIssues drops pull requests', async () => {
    const { fetch } = capturing(200, [
      { number: 1, title: 'real issue', state: 'open' },
      { number: 2, title: 'a PR', state: 'open', pull_request: { url: 'x' } },
    ]);
    const issues = await client(fetch).listOpenIssues('acme', 'widgets');
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.number, 1);
  });
});

describe('GithubForgeClient.applyDiff mode + binary handling', () => {
  const addHunk: DiffHunk = {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 1,
    lines: ['+#!/bin/sh'],
  };
  const baseInput = (file: ForgeFileChange): ApplyDiffInput => ({
    owner: 'acme',
    repo: 'widgets',
    baseSha: 'base0000',
    branch: 'omadia/job-1',
    message: 'm',
    author: { name: 'omadia-dev', email: 'dev-platform@omadia.ai' },
    files: [file],
  });

  /** Counts calls; answers the git-data write endpoints. */
  function countingFetch() {
    const calls: string[] = [];
    let blob = 0;
    const fetch: ForgeFetch = (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (url.endsWith('/git/blobs')) return jsonOk({ sha: `b${++blob}` });
      if (url.endsWith('/git/trees')) return jsonOk({ sha: 'tree' });
      if (url.endsWith('/git/commits')) return jsonOk({ sha: 'commit' });
      if (url.endsWith('/git/refs')) return jsonOk({ ref: 'refs/heads/x' });
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    return { fetch, calls };
  }

  it('refuses a binary change with NotImplemented and makes zero calls', async () => {
    const { fetch, calls } = countingFetch();
    await assert.rejects(
      () =>
        client(fetch).applyDiff(
          baseInput({ path: 'img.png', change: 'add', binary: true, hunks: [] }),
        ),
      NotImplementedError,
    );
    assert.equal(calls.length, 0);
  });

  it('refuses a symlink (120000) mode outright with zero calls', async () => {
    const { fetch, calls } = countingFetch();
    await assert.rejects(
      () =>
        client(fetch).applyDiff(
          baseInput({ path: 'link', change: 'add', binary: false, mode: '120000', hunks: [addHunk] }),
        ),
      (err: unknown) => err instanceof UnsupportedModeError && err.mode === '120000',
    );
    assert.equal(calls.length, 0);
  });

  it('preserves a declared 100755 executable bit in the tree entry', async () => {
    let treeBody: { tree: Array<{ path: string; mode: string }> } | undefined;
    const fetch: ForgeFetch = (url, init) => {
      if (url.endsWith('/git/trees')) {
        treeBody = JSON.parse(init.body ?? '{}') as typeof treeBody;
        return jsonOk({ sha: 'tree' });
      }
      if (url.endsWith('/git/blobs')) return jsonOk({ sha: 'b1' });
      if (url.endsWith('/git/commits')) return jsonOk({ sha: 'commit' });
      if (url.endsWith('/git/refs')) return jsonOk({ ref: 'refs/heads/x' });
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await client(fetch).applyDiff(
      baseInput({ path: 'run.sh', change: 'add', binary: false, mode: '100755', hunks: [addHunk] }),
    );
    assert.equal(treeBody?.tree.find((e) => e.path === 'run.sh')?.mode, '100755');
  });
});

describe('GithubForgeClient W0 stubs', () => {
  const { fetch } = capturing(200, {});
  it('createIssue throws NotImplemented', async () => {
    await assert.rejects(
      () => client(fetch).createIssue({ owner: 'a', repo: 'b', title: 't', body: 'b' }),
      NotImplementedError,
    );
  });
  it('commentIssue throws NotImplemented', async () => {
    await assert.rejects(
      () => client(fetch).commentIssue({ owner: 'a', repo: 'b', number: 1, body: 'x' }),
      NotImplementedError,
    );
  });
});

describe('assertJobBranch — only a fresh omadia/job-* ref may ever be created', () => {
  it('accepts a well-formed job branch', () => {
    assert.doesNotThrow(() => assertJobBranch('omadia/job-9f3ac1-pager-fix'));
  });

  for (const branch of [
    'main',
    'refs/heads/main',
    'omadia/job-../../main',
    'omadia/other',
    '-omadia/job-x',
    'omadia/job-x.lock',
    '',
  ]) {
    it(`refuses ${JSON.stringify(branch)}`, () => {
      assert.throws(() => assertJobBranch(branch), InvalidJobBranchError);
    });
  }
});
