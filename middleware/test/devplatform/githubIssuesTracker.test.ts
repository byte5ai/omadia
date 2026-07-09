import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  GithubIssuesTracker,
  type IssuesFetch,
} from '../../src/devplatform/githubIssuesTracker.js';

const REPO = { owner: 'byte5ai', name: 'omadia' };
const TOKEN = 'gho_issuesToken';

interface Capture {
  url: string;
  headers: Record<string, string>;
}

function jsonFetch(body: unknown, capture?: Capture, status = 200): IssuesFetch {
  return async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.headers = init.headers;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
}

function tracker(fetchImpl: IssuesFetch): GithubIssuesTracker {
  return new GithubIssuesTracker({
    token: TOKEN,
    fetchImpl,
    apiBaseUrl: 'https://api.example.test',
  });
}

describe('GithubIssuesTracker.getTicket', () => {
  it('maps the fields the brief needs', async () => {
    const cap = { url: '', headers: {} as Record<string, string> };
    const t = tracker(
      jsonFetch(
        {
          number: 123,
          title: 'Login button is dead',
          body: 'It does nothing on click.',
          labels: [{ name: 'bug' }, { name: 'frontend' }],
          html_url: 'https://github.com/byte5ai/omadia/issues/123',
          user: { login: 'reporter7' },
        },
        cap,
      ),
    );
    const ticket = await t.getTicket(REPO, 123);
    assert.deepEqual(ticket, {
      number: 123,
      title: 'Login button is dead',
      body: 'It does nothing on click.',
      labels: ['bug', 'frontend'],
      htmlUrl: 'https://github.com/byte5ai/omadia/issues/123',
      authorLogin: 'reporter7',
    });
    assert.equal(
      cap.url,
      'https://api.example.test/repos/byte5ai/omadia/issues/123',
    );
    assert.equal(cap.headers.Authorization, `Bearer ${TOKEN}`);
  });

  it('defaults a missing body to an empty string', async () => {
    const t = tracker(jsonFetch({ number: 1, title: 'x', body: null }));
    assert.equal((await t.getTicket(REPO, 1)).body, '');
  });

  it('throws when the number resolves to a pull request', async () => {
    const t = tracker(
      jsonFetch({
        number: 9,
        title: 'a PR',
        pull_request: { url: 'https://api.github.com/…/pulls/9' },
      }),
    );
    await assert.rejects(() => t.getTicket(REPO, 9), /pull request/);
  });

  it('throws (no body echo) on a non-2xx status', async () => {
    const t = tracker(jsonFetch({}, undefined, 404));
    await assert.rejects(() => t.getTicket(REPO, 1), (err: Error) => {
      assert.match(err.message, /status 404/);
      assert.ok(!err.message.includes(TOKEN));
      return true;
    });
  });
});

describe('GithubIssuesTracker.listOpenTickets', () => {
  it('filters out pull requests', async () => {
    const cap = { url: '', headers: {} as Record<string, string> };
    const t = tracker(
      jsonFetch(
        [
          { number: 1, title: 'real bug', user: { login: 'a' } },
          { number: 2, title: 'a PR', pull_request: { url: 'x' } },
          { number: 3, title: 'another bug', user: { login: 'b' } },
        ],
        cap,
      ),
    );
    const tickets = await t.listOpenTickets(REPO, { limit: 30 });
    assert.deepEqual(
      tickets.map((x) => x.number),
      [1, 3],
    );
    assert.match(cap.url, /\/issues\?state=open&per_page=30$/);
  });

  it('clamps the limit into GitHub per_page bounds', async () => {
    const cap = { url: '', headers: {} as Record<string, string> };
    const t = tracker(jsonFetch([], cap));
    await t.listOpenTickets(REPO, { limit: 999 });
    assert.match(cap.url, /per_page=100$/);
  });
});
