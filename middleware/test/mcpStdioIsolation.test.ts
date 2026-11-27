import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MCP_STDIO_CHILD_SHIM,
  MCP_STDIO_RUN_AS_PATTERN,
  McpManager,
  stdioCacheKey,
  stdioChildEnv,
  stdioLaunch,
  stdioRunAsPrefix,
  type McpServerConfig,
} from '@omadia/orchestrator';

import { config } from '../src/config.js';
import {
  createMcpConnectGuard,
  isMcpEndpointRefusal,
  MCP_STDIO_DISABLED_MESSAGE,
  MCP_STDIO_ISOLATION_UNAVAILABLE_MESSAGE,
} from '../src/services/mcpOutboundHostGuard.js';
import { createStdioIsolationProbe, type ProbeExec } from '../src/services/mcpStdioIsolationProbe.js';

/**
 * #2306 / ADR-0270 — stdio MCP children get a scrubbed environment always,
 * and run as their own OS user when `MCP_STDIO_RUN_AS` is set; a user switch
 * that does not work refuses the connect instead of falling back.
 */

function cfg(over: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: 'srv-stdio',
    name: 'stdio-probe',
    transport: 'stdio',
    endpoint: 'true',
    enabled: true,
    ...over,
  } as McpServerConfig;
}

describe('stdioLaunch / stdioChildEnv', () => {
  it('passes only locale variables and the row config env, never the process env', () => {
    const env = stdioChildEnv(
      { API_TOKEN: 'row-secret', LANG: 'de_DE.UTF-8' },
      { VAULT_KEY: 'k', DATABASE_URL: 'postgres://x', LANG: 'C.UTF-8', TZ: 'Europe/Berlin', LC_ALL: '' },
    );
    // The row's own value wins over the copied locale.
    assert.deepEqual(env, { LANG: 'de_DE.UTF-8', TZ: 'Europe/Berlin', API_TOKEN: 'row-secret' });
  });

  it('starts the command directly without a run-as user', () => {
    const launch = stdioLaunch('srv-1', 'npx', ['-y', 'pkg'], { A: '1' });
    assert.equal(launch.command, 'npx');
    assert.deepEqual(launch.args, ['-y', 'pkg']);
    assert.equal(launch.env.A, '1');
  });

  it('wraps the command in sudo with the env kept out of argv', () => {
    const launch = stdioLaunch('srv-1', 'npx', ['-y', 'pkg'], { API_TOKEN: 'row-secret' }, { runAsUser: 'omadia-mcp' });
    assert.equal(launch.command, 'sudo');
    assert.deepEqual(launch.args, [
      '-n', '-E', '-H', '-u', 'omadia-mcp', '--',
      '/bin/sh', '-c', MCP_STDIO_CHILD_SHIM, stdioCacheKey('srv-1'),
      'npx', '-y', 'pkg',
    ]);
    assert.ok(!launch.args.some((a) => a.includes('row-secret')), 'secrets never go on the command line');
    assert.equal(launch.env.API_TOKEN, 'row-secret');
  });

  it('gives each server its own npm cache key and keeps the shim argument-safe', () => {
    assert.match(stdioCacheKey('srv-1'), /^[0-9a-f]{16}$/);
    assert.notEqual(stdioCacheKey('srv-1'), stdioCacheKey('srv-2'));
    assert.equal(stdioCacheKey('srv-1'), stdioCacheKey('srv-1'));
    // The server's command line is passed positionally ("$@"), never spliced into the script.
    assert.ok(MCP_STDIO_CHILD_SHIM.endsWith('exec "$@"'));
    assert.ok(MCP_STDIO_CHILD_SHIM.startsWith('umask 077'));
  });

  it('refuses a user name that is not a plain POSIX name', () => {
    for (const bad of ['root -s', '-u', '0', 'a/b', '', 'Omadia']) {
      assert.throws(() => stdioRunAsPrefix(bad), /invalid stdio run-as user/);
    }
    assert.deepEqual(stdioRunAsPrefix('omadia-mcp').slice(-2), ['omadia-mcp', '--']);
  });

  it('config.ts accepts the same user grammar as the orchestrator', () => {
    assert.equal(MCP_STDIO_RUN_AS_PATTERN.source, '^[a-z_][a-z0-9_-]{0,31}$');
    // The test process has no MCP_STDIO_RUN_AS: from-source runs keep the middleware's user.
    assert.equal(config.MCP_STDIO_RUN_AS, process.env.MCP_STDIO_RUN_AS || undefined);
  });
});

describe('McpManager spawns stdio children with the scrubbed env', () => {
  const SECRET = 'W33_FAKE_VAULT_KEY';
  afterEach(() => {
    delete process.env[SECRET];
  });

  it('a child sees its config env but not a middleware secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-stdio-env-'));
    const out = join(dir, 'env.json');
    const script = join(dir, 'dump.mjs');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], JSON.stringify(process.env));\n`,
    );
    process.env[SECRET] = 'must-not-leak';
    try {
      const mcp = new McpManager();
      const row = cfg({ endpoint: `${process.execPath} ${script} ${out}`, env: { ROW_VALUE: 'from-row' } });
      // The dump script is no MCP server, so the handshake fails; the env is what we check.
      await assert.rejects(mcp.listTools(row, { fresh: true }));
      for (let i = 0; i < 50 && !existsSync(out); i += 1) await new Promise((r) => setTimeout(r, 20));
      const env = JSON.parse(await readFile(out, 'utf8')) as Record<string, string>;
      assert.equal(env.ROW_VALUE, 'from-row');
      assert.equal(env[SECRET], undefined);
      assert.equal(env.DATABASE_URL, undefined);
      await mcp.closeAll();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createStdioIsolationProbe', () => {
  it('runs sudo with the launch flags and caches a success', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const exec: ProbeExec = (command, args) => {
      calls.push({ command, args });
      return Promise.resolve(null);
    };
    const probe = createStdioIsolationProbe('omadia-mcp', { exec });
    assert.equal(await probe(), null);
    assert.equal(await probe(), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'sudo');
    assert.deepEqual(calls[0]?.args, ['-n', '-E', '-H', '-u', 'omadia-mcp', '--', 'true']);
  });

  it('caches a failure only for its TTL and shares one probe between concurrent callers', async () => {
    let t = 0;
    let runs = 0;
    let answer: string | null = 'sudo: a password is required';
    const exec: ProbeExec = () => {
      runs += 1;
      return Promise.resolve(answer);
    };
    const probe = createStdioIsolationProbe('omadia-mcp', { exec, now: () => t, failureTtlMs: 1000 });
    const [a, b] = await Promise.all([probe(), probe()]);
    assert.equal(a, 'sudo: a password is required');
    assert.equal(b, a);
    assert.equal(runs, 1);
    t = 500;
    assert.equal(await probe(), 'sudo: a password is required');
    assert.equal(runs, 1);
    answer = null;
    t = 1500;
    assert.equal(await probe(), null);
    assert.equal(runs, 2);
  });

  it('turns a thrown exec into a refusal reason', async () => {
    const probe = createStdioIsolationProbe('omadia-mcp', { exec: () => Promise.reject(new Error('ENOENT')) });
    assert.equal(await probe(), 'ENOENT');
  });
});

describe('connect guard with a stdio isolation probe', () => {
  it('refuses a stdio connect when the user switch fails, without spawning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-stdio-iso-'));
    const marker = join(dir, 'spawned');
    try {
      const mcp = new McpManager({
        connectGuard: createMcpConnectGuard({
          stdioEnabled: true,
          stdioIsolationProbe: () => Promise.resolve('sudo: command not found'),
        }),
        stdioIsolation: { runAsUser: 'omadia-mcp' },
      });
      await assert.rejects(mcp.listTools(cfg({ endpoint: `touch ${marker}` }), { fresh: true }), (err: unknown) => {
        assert.ok(isMcpEndpointRefusal(err));
        assert.equal(err.code, 'stdio_isolation_unavailable');
        assert.equal(err.message, `${MCP_STDIO_ISOLATION_UNAVAILABLE_MESSAGE}: sudo: command not found`);
        return true;
      });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(existsSync(marker), false, 'no child process may be spawned');
      assert.equal(mcp.poolSize, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the stdio switch is checked first, the probe not at all for disabled stdio or http', async () => {
    let probed = 0;
    const guard = createMcpConnectGuard({
      stdioEnabled: false,
      stdioIsolationProbe: () => {
        probed += 1;
        return Promise.resolve(null);
      },
    });
    await assert.rejects(guard(cfg({})), (err: unknown) => {
      assert.ok(isMcpEndpointRefusal(err));
      assert.equal(err.code, 'stdio_disabled');
      assert.equal(err.message, MCP_STDIO_DISABLED_MESSAGE);
      return true;
    });
    const httpGuard = createMcpConnectGuard({
      stdioEnabled: true,
      lookup: () => Promise.resolve([]),
      stdioIsolationProbe: () => {
        probed += 1;
        return Promise.resolve('unused');
      },
    });
    await httpGuard(cfg({ transport: 'http', endpoint: 'http://127.0.0.1:9/mcp' }));
    assert.equal(probed, 0);
  });

  it('lets a stdio connect through when the switch works', async () => {
    const guard = createMcpConnectGuard({ stdioEnabled: true, stdioIsolationProbe: () => Promise.resolve(null) });
    await guard(cfg({}));
  });
});
