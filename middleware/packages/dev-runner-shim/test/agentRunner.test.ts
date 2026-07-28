/**
 * Epic #470 W0 — agent runner (spec §5 step 4/5). Drives a FAKE CLI (a node
 * script) to prove: stdout NDJSON is translated to the event table, stderr
 * lines become `log {stream:'stderr'}` events, the prompt arrives on stdin (not
 * argv), and the env is an allowlist (no arbitrary parent var, proxy wired).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runAgent, buildAgentEnv } from '../src/agentRunner.js';
import type { DevJobSpec, RunnerEvent } from '../src/protocol.js';

function spec(over: Partial<DevJobSpec> = {}): DevJobSpec {
  return {
    protocol: 1,
    jobId: 'job-1',
    provision: 1,
    kind: 'implement',
    brief: 'PROMPT-ON-STDIN',
    repo: { cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main', baseSha: 'abc' },
    branch: 'omadia/job-1',
    agent: { kind: 'claude-cli' },
    limits: { wallClockMs: 1000 },
    capabilities: { installDeps: false, runTests: false },
    ...over,
  };
}

let ws: string;
let cli: string;

/** A fake `claude` CLI: echoes argv+stdin to a log, emits NDJSON + one stderr. */
async function writeFakeCli(): Promise<void> {
  cli = path.join(ws, 'fake-claude.cjs');
  await writeFile(
    cli,
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.env.HOME, '.cli-argv.json'), JSON.stringify({ argv: process.argv.slice(2), stdin, env: { ...process.env } }));
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'm' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 } }) + '\\n');
  process.stderr.write('a warning line\\n');
  process.exit(0);
});
`,
  );
  await chmod(cli, 0o755);
}

beforeEach(async () => {
  ws = await mkdtemp(path.join(tmpdir(), 'dev-runner-shim-agent-'));
  await writeFakeCli();
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('runAgent', () => {
  it('translates stdout, maps stderr to a log event, and exits 0', async () => {
    const events: RunnerEvent[] = [];
    // The child's HOME is job-scoped (cwd fallback) — the fake drops its argv
    // log there, no parent-HOME override needed.
    const handle = runAgent({
      cliBin: cli,
      cwd: ws,
      spec: spec(),
      emit: (batch) => events.push(...batch),
      flushIntervalMs: 5,
    });
    const { code } = await handle.done;
    assert.equal(code, 0);

    const types = events.map((e) => e.type);
    assert.ok(types.includes('status'), 'a status event was emitted');
    const stderrLog = events.find((e) => e.type === 'log' && e.payload['stream'] === 'stderr');
    assert.equal(stderrLog?.payload['text'], 'a warning line');
    const started = events.find((e) => e.payload['state'] === 'agent_started');
    assert.equal(started?.payload['model'], 'm');
    const done = events.find((e) => e.payload['state'] === 'agent_done');
    assert.deepEqual(done?.payload['usage'], { tokensIn: 1, tokensOut: 2 });
  });

  it('passes the prompt on stdin, never argv, and includes the CLI flags', async () => {
    const handle = runAgent({ cliBin: cli, cwd: ws, spec: spec({ agent: { kind: 'claude-cli', model: 'opus' } }), emit: () => {} });
    await handle.done;
    const { argv, stdin, env } = JSON.parse(
      await import('node:fs').then((m) => m.readFileSync(path.join(ws, '.cli-argv.json'), 'utf8')),
    ) as {
      argv: string[];
      stdin: string;
      env: Record<string, string>;
    };
    assert.equal(stdin, 'PROMPT-ON-STDIN', 'prompt arrived on stdin');
    assert.ok(!argv.includes('PROMPT-ON-STDIN'), 'prompt never on argv');
    assert.ok(argv.includes('--output-format') && argv.includes('stream-json'), 'stream-json requested');
    assert.ok(argv.includes('--dangerously-skip-permissions'));
    assert.ok(argv.includes('--model') && argv.includes('opus'));
    assert.equal(env['HOME'], ws, 'child HOME is the job workspace, not the runner HOME');
  });
});

describe('buildAgentEnv — allowlist, not scrub', () => {
  it('excludes arbitrary parent vars', () => {
    process.env['SHIM_AGENT_CANARY'] = 'leak';
    try {
      const env = buildAgentEnv({ cwd: '/tmp/x' });
      assert.equal(env['SHIM_AGENT_CANARY'], undefined, 'parent var not forwarded');
      assert.ok(env['PATH'], 'PATH present so the CLI is resolvable');
    } finally {
      delete process.env['SHIM_AGENT_CANARY'];
    }
  });

  it('withholds LLM auth without the jail acknowledgment, wires it with', () => {
    // Default (no ack): even an explicitly supplied token must NOT cross into
    // the child — in W0 it is the middleware's long-lived proxy secret.
    const denied = buildAgentEnv({ cwd: '/tmp/x', proxyBaseUrl: 'http://proxy', proxyToken: 'bearer' });
    assert.equal(denied['ANTHROPIC_AUTH_TOKEN'], undefined, 'token withheld without llmEnvAllowed');
    assert.equal(denied['ANTHROPIC_BASE_URL'], undefined, 'base url withheld without llmEnvAllowed');

    // With the acknowledgment (W0 jail) — or a W1 per-job proxy token — the
    // routing is wired, and deliberately NOT scrubbed.
    const allowed = buildAgentEnv({ cwd: '/tmp/x', proxyBaseUrl: 'http://proxy', proxyToken: 'bearer', llmEnvAllowed: true });
    assert.equal(allowed['ANTHROPIC_BASE_URL'], 'http://proxy', 'proxy base url wired (NOT scrubbed)');
    assert.equal(allowed['ANTHROPIC_AUTH_TOKEN'], 'bearer');
  });

  it('HOME is job-scoped and the parent HOME never appears in the child env', () => {
    const prev = process.env['HOME'];
    const canary = '/tmp/parent-home-canary-9f3a1c';
    process.env['HOME'] = canary;
    try {
      const env = buildAgentEnv({ cwd: '/work/ws/repo', homeDir: '/work/ws/home' });
      assert.equal(env['HOME'], '/work/ws/home', 'HOME is the dedicated job home dir');
      for (const [k, v] of Object.entries(env)) {
        assert.ok(!(v ?? '').includes(canary), `parent HOME leaked into child env var ${k}`);
      }
      // Fallback without a dedicated homeDir: the clone dir, still never parent.
      const fallback = buildAgentEnv({ cwd: '/work/ws/repo' });
      assert.equal(fallback['HOME'], '/work/ws/repo');
    } finally {
      if (prev === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prev;
    }
  });
});
