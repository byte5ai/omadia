import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  GithubIssueCreator,
  type CreatorFetch,
} from '../../src/plugins/builder/githubIssueCreator.js';

const tokenProvider = { getToken: () => Promise.resolve('ghs_tok') };

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('GithubIssueCreator', () => {
  it('POSTs to the repo issues endpoint with auth + sanitized payload and returns the ref', async () => {
    let capturedUrl = '';
    let capturedInit: Parameters<CreatorFetch>[1] | null = null;
    const fetch: CreatorFetch = (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(201, {
        number: 314,
        html_url: 'https://github.com/byte5ai/omadia/issues/314',
      });
    };
    const creator = new GithubIssueCreator({ tokenProvider, fetch });

    const result = await creator.createIssue({
      owner: 'byte5ai',
      repo: 'omadia',
      title: 'Codegen emits invalid TS',
      body: 'repro\n\n<!-- omadia-fingerprint: abc123 -->\n',
      labels: ['from-builder-bot', 'needs-triage'],
    });

    assert.deepEqual(result, {
      ok: true,
      number: 314,
      url: 'https://github.com/byte5ai/omadia/issues/314',
    });
    assert.match(capturedUrl, /\/repos\/byte5ai\/omadia\/issues$/);
    assert.ok(capturedInit);
    const init = capturedInit as Parameters<CreatorFetch>[1];
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Authorization'], 'Bearer ghs_tok');
    const sent = JSON.parse(init.body) as {
      title: string;
      body: string;
      labels: string[];
    };
    assert.equal(sent.title, 'Codegen emits invalid TS');
    assert.deepEqual(sent.labels, ['from-builder-bot', 'needs-triage']);
  });

  it('maps 422 to a validation failure', async () => {
    const creator = new GithubIssueCreator({
      tokenProvider,
      fetch: () => jsonResponse(422, { message: 'Validation Failed' }),
    });
    const result = await creator.createIssue({
      owner: 'byte5ai',
      repo: 'omadia',
      title: 't',
      body: 'b',
      labels: [],
    });
    assert.deepEqual(result, { ok: false, reason: 'validation', status: 422 });
  });

  it('maps 403 to rate_limited', async () => {
    const creator = new GithubIssueCreator({
      tokenProvider,
      fetch: () => jsonResponse(403, {}),
    });
    const result = await creator.createIssue({
      owner: 'byte5ai',
      repo: 'omadia',
      title: 't',
      body: 'b',
      labels: [],
    });
    assert.deepEqual(result, { ok: false, reason: 'rate_limited', status: 403 });
  });

  it('returns reason=auth when the token provider throws', async () => {
    const creator = new GithubIssueCreator({
      tokenProvider: {
        getToken: () => Promise.reject(new Error('no creds')),
      },
      fetch: () => jsonResponse(201, { number: 1 }),
    });
    const result = await creator.createIssue({
      owner: 'byte5ai',
      repo: 'omadia',
      title: 't',
      body: 'b',
      labels: [],
    });
    assert.deepEqual(result, { ok: false, reason: 'auth' });
  });
});
