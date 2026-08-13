import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createReleaseLookup,
  releaseIsNewer,
} from '../src/update/releaseLookup.js';

/**
 * #432 slice 2 — the "is there a newer release" check.
 *
 * Every assertion here is about a self-hosted instance behaving well when
 * GitHub does not: offline, rate-limited, or answering something unexpected.
 * A status endpoint that throws because api.github.com is unreachable would
 * take the whole admin page down with it.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const RELEASE = {
  tag_name: 'v0.75.0',
  html_url: 'https://github.com/byte5ai/omadia/releases/tag/v0.75.0',
  published_at: '2026-08-13T13:00:41Z',
  prerelease: false,
};

describe('createReleaseLookup', () => {
  it('returns the latest release and caches it for the TTL', async () => {
    let calls = 0;
    let clock = 0;
    const lookup = createReleaseLookup({
      ttlMs: 1_000,
      now: () => clock,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(RELEASE);
      },
    });

    const first = await lookup.get();
    assert.equal(first.release?.tag, 'v0.75.0');
    assert.equal(first.stale, false);
    assert.equal(calls, 1);

    clock = 500;
    await lookup.get();
    assert.equal(calls, 1, 'inside the TTL the cached answer is reused');

    clock = 2_000;
    await lookup.get();
    assert.equal(calls, 2, 'past the TTL it refreshes');
  });

  it('refreshes on demand regardless of the TTL', async () => {
    let calls = 0;
    const lookup = createReleaseLookup({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(RELEASE);
      },
    });
    await lookup.get();
    await lookup.get(true);
    assert.equal(calls, 2);
  });

  it('degrades to stale instead of throwing when GitHub is unreachable', async () => {
    let online = true;
    let clock = 0;
    const lookup = createReleaseLookup({
      ttlMs: 10,
      now: () => clock,
      fetchImpl: async () => {
        if (!online) throw new Error('getaddrinfo ENOTFOUND api.github.com');
        return jsonResponse(RELEASE);
      },
    });

    await lookup.get();
    online = false;
    clock = 1_000;

    const result = await lookup.get();
    assert.equal(result.stale, true);
    assert.equal(result.release?.tag, 'v0.75.0', 'the last known-good answer survives');
    assert.match(result.error ?? '', /ENOTFOUND/);
  });

  it('reports a rate-limited response as stale rather than as "no release"', async () => {
    const lookup = createReleaseLookup({
      fetchImpl: async () => jsonResponse({ message: 'API rate limit exceeded' }, 403),
    });
    const result = await lookup.get();
    assert.equal(result.stale, true);
    assert.equal(result.release, null);
    assert.equal(result.error, 'github_status_403');
  });

  it('treats a payload without a usable tag as no answer', async () => {
    const lookup = createReleaseLookup({
      fetchImpl: async () => jsonResponse({ html_url: 'x' }),
    });
    const result = await lookup.get();
    assert.equal(result.release, null);
    assert.equal(result.error, 'github_payload_unusable');
  });

  it('never fires two concurrent requests for one refresh', async () => {
    let calls = 0;
    // `let release: (() => void) | null` narrows to `never` after the executor
    // assignment is invisible to the checker — capture the resolver directly.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = createReleaseLookup({
      fetchImpl: async () => {
        calls += 1;
        await gate;
        return jsonResponse(RELEASE);
      },
    });

    const both = Promise.all([lookup.get(), lookup.get()]);
    release();
    const [a, b] = await both;

    assert.equal(calls, 1, 'the unauthenticated GitHub budget is 60/h per IP');
    assert.equal(a.release?.tag, 'v0.75.0');
    assert.equal(b.release?.tag, 'v0.75.0');
  });

  it('sends the token only when one is configured', async () => {
    const seen: Array<string | undefined> = [];
    const capture = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers['authorization']);
      return jsonResponse(RELEASE);
    };

    await createReleaseLookup({ fetchImpl: capture as typeof fetch }).get();
    await createReleaseLookup({ token: 'ghp_x', fetchImpl: capture as typeof fetch }).get();

    assert.deepEqual(seen, [undefined, 'Bearer ghp_x']);
  });

  it('queries the configured repository', async () => {
    let requested = '';
    await createReleaseLookup({
      repo: 'someone/fork',
      fetchImpl: async (url: unknown) => {
        requested = String(url);
        return jsonResponse(RELEASE);
      },
    }).get();
    assert.equal(
      requested,
      'https://api.github.com/repos/someone/fork/releases/latest',
    );
  });
});

describe('releaseIsNewer', () => {
  it('is false without a release to compare against', () => {
    assert.equal(releaseIsNewer('v0.74.0', null), false);
  });

  it('compares the running build against the release tag', () => {
    const release = {
      tag: 'v0.75.0',
      url: '',
      publishedAt: '',
      prerelease: false,
    };
    assert.equal(releaseIsNewer('v0.74.0', release), true);
    assert.equal(releaseIsNewer('v0.75.0', release), false);
    assert.equal(releaseIsNewer('unknown', release), false);
  });
});
