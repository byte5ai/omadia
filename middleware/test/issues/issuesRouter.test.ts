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
});
