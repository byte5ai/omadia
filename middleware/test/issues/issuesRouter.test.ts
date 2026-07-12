import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { LlmProvider } from '@omadia/llm-provider';
import { LlmProviderCatalog } from '@omadia/llm-provider';

import { InMemorySecretVault } from '../../src/secrets/vault.js';
import { InMemoryInstalledRegistry } from '../../src/plugins/installedRegistry.js';
import { GitHubDeviceFlowProvider } from '../../src/issues/githubOAuthProvider.js';
import { DeviceFlowStore } from '../../src/issues/deviceFlowStore.js';
import { GITHUB_CONNECT_AGENT_ID } from '../../src/issues/operatorGithubStore.js';
import {
  createIssuesRouter,
  type IssuesRouterDeps,
} from '../../src/issues/issuesRouter.js';

function fakeLlm(text: string): LlmProvider {
  return {
    id: 'fake',
    capabilities: {},
    complete: () =>
      Promise.resolve({
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ kind: 'unknown', retryable: false }),
  } as unknown as LlmProvider;
}

function deviceProvider(): GitHubDeviceFlowProvider {
  const fetchImpl = ((url: string) => {
    let body: unknown;
    if (url.includes('/login/device/code')) {
      body = {
        device_code: 'devc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      };
    } else if (url.includes('/login/oauth/access_token')) {
      body = { access_token: 'gho_test', scope: 'public_repo', token_type: 'bearer' };
    } else {
      body = { login: 'octocat' };
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return new GitHubDeviceFlowProvider('Ov23liTest', fetchImpl);
}

interface Harness {
  base: string;
  vault: InMemorySecretVault;
  close: () => Promise<void>;
}

async function boot(overrides: Partial<IssuesRouterDeps> = {}): Promise<Harness> {
  const vault = overrides.vault ?? new InMemorySecretVault();
  const deps: IssuesRouterDeps = {
    vault,
    installedRegistry: new InMemoryInstalledRegistry(),
    llmProviderCatalog: new LlmProviderCatalog(),
    githubProvider: deviceProvider(),
    createIssueCreator: () => ({
      createIssue: () =>
        Promise.resolve({
          ok: true as const,
          number: 42,
          url: 'https://github.com/byte5ai/omadia/issues/42',
        }),
    }),
    resolveLlm: () =>
      Promise.resolve({
        provider: fakeLlm('{"title":"Phrased title","body":"## Summary\\nok"}'),
        model: 'm',
      }),
    deviceStore: new DeviceFlowStore(),
    ...overrides,
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      sub: 'op-1',
      email: 'op@example.com',
    };
    next();
  });
  app.use('/api/v1/issues', createIssuesRouter(deps));

  // Bind explicitly to IPv4 loopback: `listen(0)` may bind to IPv6 `::`
  // while the test fetches 127.0.0.1, which races under load.
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    vault,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const POST = { method: 'POST' } as const;

describe('issuesRouter (device flow)', () => {
  it('reports a fresh operator as not connected', async () => {
    const h = await boot();
    try {
      const res = await fetch(`${h.base}/api/v1/issues/github/status`);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200);
      assert.equal(body['connected'], false);
      assert.equal(body['oauthConfigured'], true);
    } finally {
      await h.close();
    }
  });

  it('reports oauthConfigured=false when no provider', async () => {
    const h = await boot({ githubProvider: null });
    try {
      const res = await fetch(`${h.base}/api/v1/issues/github/status`);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['oauthConfigured'], false);
    } finally {
      await h.close();
    }
  });

  it('connect/start returns a device code', async () => {
    const h = await boot();
    try {
      const res = await fetch(`${h.base}/api/v1/issues/github/connect/start`, POST);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200);
      assert.equal(body['userCode'], 'ABCD-1234');
      assert.match(String(body['verificationUri']), /github\.com\/login\/device/);
      // The secret device_code must NOT be exposed to the browser.
      assert.equal(body['deviceCode'], undefined);
    } finally {
      await h.close();
    }
  });

  it('connect/start 503 when oauth unconfigured', async () => {
    const h = await boot({ githubProvider: null });
    try {
      const res = await fetch(`${h.base}/api/v1/issues/github/connect/start`, POST);
      assert.equal(res.status, 503);
    } finally {
      await h.close();
    }
  });

  it('poll without a started flow returns expired', async () => {
    const h = await boot();
    try {
      const res = await fetch(`${h.base}/api/v1/issues/github/connect/poll`, POST);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['status'], 'expired');
    } finally {
      await h.close();
    }
  });

  it('start + poll authorizes and persists the connection', async () => {
    const h = await boot();
    try {
      const startRes = await fetch(
        `${h.base}/api/v1/issues/github/connect/start`,
        POST,
      );
      assert.equal(startRes.status, 200);

      const pollRes = await fetch(
        `${h.base}/api/v1/issues/github/connect/poll`,
        POST,
      );
      const poll = (await pollRes.json()) as Record<string, unknown>;
      assert.equal(poll['status'], 'authorized');
      assert.equal(poll['login'], 'octocat');

      const statusRes = await fetch(`${h.base}/api/v1/issues/github/status`);
      const status = (await statusRes.json()) as Record<string, unknown>;
      assert.equal(status['connected'], true);
      assert.equal(status['login'], 'octocat');
    } finally {
      await h.close();
    }
  });

  it('preview returns a reformulated issue', async () => {
    const h = await boot();
    try {
      const res = await fetch(`${h.base}/api/v1/issues/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'app crashes on save', category: 'bug' }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200);
      assert.equal(body['title'], 'Phrased title');
      assert.equal(body['category'], 'bug');
    } finally {
      await h.close();
    }
  });

  it('preview rejects an invalid category', async () => {
    const h = await boot();
    try {
      const res = await fetch(`${h.base}/api/v1/issues/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', category: 'nonsense' }),
      });
      assert.equal(res.status, 400);
    } finally {
      await h.close();
    }
  });

  it('create returns 409 when GitHub is not connected', async () => {
    const h = await boot();
    try {
      const res = await fetch(`${h.base}/api/v1/issues/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', body: 'B', category: 'bug' }),
      });
      assert.equal(res.status, 409);
    } finally {
      await h.close();
    }
  });

  it('create files the issue when connected', async () => {
    const vault = new InMemorySecretVault();
    await vault.set(GITHUB_CONNECT_AGENT_ID, 'op-1/access_token', 'gho_seed');
    await vault.set(GITHUB_CONNECT_AGENT_ID, 'op-1/login', 'octocat');
    const h = await boot({ vault });
    try {
      const res = await fetch(`${h.base}/api/v1/issues/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Crash on save',
          body: 'It crashes.',
          category: 'bug',
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200);
      assert.equal(body['number'], 42);
      assert.match(String(body['htmlUrl']), /issues\/42/);
    } finally {
      await h.close();
    }
  });

  it('defangs mentions, refs and raw HTML in the filed issue', async () => {
    const vault = new InMemorySecretVault();
    await vault.set(GITHUB_CONNECT_AGENT_ID, 'op-1/access_token', 'gho_seed');
    let captured: { title: string; body: string } | null = null;
    const h = await boot({
      vault,
      createIssueCreator: () => ({
        createIssue: (input) => {
          captured = { title: input.title, body: input.body };
          return Promise.resolve({
            ok: true as const,
            number: 7,
            url: 'https://github.com/byte5ai/omadia/issues/7',
          });
        },
      }),
    });
    try {
      const res = await fetch(`${h.base}/api/v1/issues/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Ping @maintainer about #1',
          body: 'See @org/team and #42 plus <img src="http://x/p.gif">',
          category: 'bug',
        }),
      });
      assert.equal(res.status, 200);
      assert.ok(captured);
      const c = captured as { title: string; body: string };
      assert.doesNotMatch(c.title, /@maintainer\b/);
      assert.doesNotMatch(c.body, /@org\b/);
      assert.doesNotMatch(c.body, /(^|[^\w])#42\b/);
      assert.doesNotMatch(c.body, /<img/i);
      assert.match(c.body, /&lt;img/i);
    } finally {
      await h.close();
    }
  });

  it('rate-limits issue creation per operator', async () => {
    const vault = new InMemorySecretVault();
    await vault.set(GITHUB_CONNECT_AGENT_ID, 'op-1/access_token', 'gho_seed');
    const h = await boot({ vault });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${h.base}/api/v1/issues/create`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: `T${i}`, body: 'B', category: 'bug' }),
        });
        statuses.push(res.status);
      }
      assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
      assert.equal(statuses[5], 429);
    } finally {
      await h.close();
    }
  });

  // ---- diagnostics attachment (#433) -----------------------------------

  it('preview echoes a sanitized, collapsed diagnostics block without sending it to the LLM', async () => {
    const h = await boot();
    try {
      const res = await fetch(`${h.base}/api/v1/issues/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'app crashes on save',
          category: 'bug',
          diagnostics: 'TypeError: boom\n  at save (app.js:1:1)',
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200);
      // The reformulated body must be untouched by the diagnostics text —
      // the fake LLM always returns the same fixture body regardless of
      // input, so this also proves rawText did not carry the excerpt.
      assert.equal(body['body'], '## Summary\nok');
      const diagnostics = String(body['diagnostics']);
      assert.match(diagnostics, /<details>/);
      assert.match(diagnostics, /<summary>Diagnostics<\/summary>/);
      assert.match(diagnostics, /TypeError: boom/);
    } finally {
      await h.close();
    }
  });

  it('diagnostics fence widens so an embedded ``` run cannot break out of it', async () => {
    const h = await boot();
    try {
      // Concrete failing input from the #433 review: a message containing
      // its own ``` run followed by an HTML payload. A fixed ```text fence
      // would let the embedded ``` close the block early, so GitHub's
      // renderer would render the <img> tag as live markdown/HTML instead
      // of literal diagnostics text.
      const res = await fetch(`${h.base}/api/v1/issues/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'app crashes on save',
          category: 'bug',
          diagnostics: 'boom\n```\n<img src=x onerror=alert(1)>\n```\nend',
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200);
      const diagnostics = String(body['diagnostics']);
      const fenceMatch = diagnostics.match(/\n(`{3,})text\n/);
      assert.ok(fenceMatch, 'expected a fenced code block opener');
      const fence = fenceMatch![1];
      // The fence must be strictly longer than the longest backtick run
      // inside the fenced content — otherwise the embedded ``` acts as a
      // premature closer per CommonMark fenced-code-block rules.
      assert.ok(fence.length > 3, 'fence must widen past the embedded ``` run');
      const contentStart = diagnostics.indexOf(fenceMatch![0]) + fenceMatch![0].length;
      const closerIndex = diagnostics.indexOf(`\n${fence}\n`, contentStart);
      assert.ok(closerIndex > contentStart, 'expected a matching fence closer');
      const fencedContent = diagnostics.slice(contentStart, closerIndex);
      const afterCloser = diagnostics.slice(closerIndex + fence.length + 2);
      // The injected markup stays entirely inside the fence (rendered as
      // literal text there) and never appears after the real closer.
      assert.match(fencedContent, /<img src=x onerror=alert\(1\)>/);
      assert.doesNotMatch(afterCloser, /<img/);
    } finally {
      await h.close();
    }
  });

  it('preview omits diagnostics when none is submitted', async () => {
    const h = await boot();
    try {
      const res = await fetch(`${h.base}/api/v1/issues/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'app crashes on save', category: 'bug' }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200);
      assert.equal(body['diagnostics'], undefined);
    } finally {
      await h.close();
    }
  });

  it('preview rejects an oversized diagnostics payload', async () => {
    const h = await boot();
    try {
      const res = await fetch(`${h.base}/api/v1/issues/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'app crashes on save',
          category: 'bug',
          diagnostics: 'x'.repeat(20001),
        }),
      });
      assert.equal(res.status, 400);
    } finally {
      await h.close();
    }
  });

  it('create appends the diagnostics block after the body, redacted, and unchanged by sanitizeIssueText', async () => {
    const vault = new InMemorySecretVault();
    await vault.set(GITHUB_CONNECT_AGENT_ID, 'op-1/access_token', 'gho_seed');
    let captured: { title: string; body: string } | null = null;
    const h = await boot({
      vault,
      createIssueCreator: () => ({
        createIssue: (input) => {
          captured = { title: input.title, body: input.body };
          return Promise.resolve({
            ok: true as const,
            number: 9,
            url: 'https://github.com/byte5ai/omadia/issues/9',
          });
        },
      }),
    });
    try {
      const res = await fetch(`${h.base}/api/v1/issues/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Crash on save',
          body: 'It crashes.',
          category: 'bug',
          diagnostics:
            'stack trace: contact me at ops@example.com or AKIAIOSFODNN7EXAMPLE',
        }),
      });
      assert.equal(res.status, 200);
      assert.ok(captured);
      const c = captured as { title: string; body: string };
      // Redacted by the shared secrets scanner.
      assert.doesNotMatch(c.body, /ops@example\.com/);
      assert.doesNotMatch(c.body, /AKIAIOSFODNN7EXAMPLE/);
      assert.match(c.body, /\[REDACTED:email\]/);
      assert.match(c.body, /\[REDACTED:aws-access-key\]/);
      // Appended as a collapsed block AFTER the sanitized body, and the
      // <details>/<summary> tags survive — proof it did not pass back
      // through sanitizeIssueText's HTML-escaping pass.
      assert.match(c.body, /It crashes\.\n\n<details>/);
      assert.match(c.body, /<summary>Diagnostics<\/summary>/);
    } finally {
      await h.close();
    }
  });

  it('redacts a bearer token whose prefix falls outside the tail-truncation window', async () => {
    const vault = new InMemorySecretVault();
    await vault.set(GITHUB_CONNECT_AGENT_ID, 'op-1/access_token', 'gho_seed');
    let captured: { title: string; body: string } | null = null;
    const h = await boot({
      vault,
      createIssueCreator: () => ({
        createIssue: (input) => {
          captured = { title: input.title, body: input.body };
          return Promise.resolve({
            ok: true as const,
            number: 10,
            url: 'https://github.com/byte5ai/omadia/issues/10',
          });
        },
      }),
    });
    try {
      // Concrete failing input from the #433 review: the diagnostics block
      // used to tail-truncate to MAX_DIAGNOSTICS_BYTES (8 KiB) BEFORE
      // redaction. The 23-byte "Authorization: Bearer " prefix here sits
      // exactly outside that 8 KiB tail window, so the bearer-token regex
      // (which requires the prefix to match) never saw it and the 64-char
      // token shipped unredacted. Total size (23 + 64 + 1 + 8127 = 8215
      // bytes) is under MAX_DIAGNOSTICS_INPUT_LEN (20000) so it is accepted
      // by validation, and over MAX_DIAGNOSTICS_BYTES (8192) so truncation
      // still applies — redaction just has to run first.
      const token = 'A'.repeat(64);
      const diagnostics = `Authorization: Bearer ${token}\n${'x'.repeat(8127)}`;
      const res = await fetch(`${h.base}/api/v1/issues/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Crash on save',
          body: 'It crashes.',
          category: 'bug',
          diagnostics,
        }),
      });
      assert.equal(res.status, 200);
      assert.ok(captured);
      const c = captured as { title: string; body: string };
      assert.doesNotMatch(c.body, new RegExp(token));
      assert.match(c.body, /\[REDACTED:bearer-token\]/);
    } finally {
      await h.close();
    }
  });

  it('create is byte-identical to the no-diagnostics case when diagnostics is omitted', async () => {
    const vault = new InMemorySecretVault();
    await vault.set(GITHUB_CONNECT_AGENT_ID, 'op-1/access_token', 'gho_seed');
    const bodies: string[] = [];
    const h = await boot({
      vault,
      createIssueCreator: () => ({
        createIssue: (input) => {
          bodies.push(input.body);
          return Promise.resolve({
            ok: true as const,
            number: 1,
            url: 'https://github.com/byte5ai/omadia/issues/1',
          });
        },
      }),
    });
    try {
      const payload = { title: 'T', body: 'B', category: 'bug' as const };
      const withoutField = await fetch(`${h.base}/api/v1/issues/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(withoutField.status, 200);
      const withEmptyField = await fetch(`${h.base}/api/v1/issues/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, diagnostics: '' }),
      });
      assert.equal(withEmptyField.status, 200);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0], bodies[1]);
      assert.doesNotMatch(bodies[0] ?? '', /<details>/);
    } finally {
      await h.close();
    }
  });

  it('create rejects a non-string diagnostics field', async () => {
    const vault = new InMemorySecretVault();
    await vault.set(GITHUB_CONNECT_AGENT_ID, 'op-1/access_token', 'gho_seed');
    const h = await boot({ vault });
    try {
      const res = await fetch(`${h.base}/api/v1/issues/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'T',
          body: 'B',
          category: 'bug',
          diagnostics: 12345,
        }),
      });
      assert.equal(res.status, 400);
    } finally {
      await h.close();
    }
  });
});
