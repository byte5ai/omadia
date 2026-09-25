import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { LlmRequest } from '@omadia/llm-provider';
import { CliIncompatibleError, clearCliVersionCache } from '@omadia/orchestrator';
import { flushUsageRecorder, initUsageRecorder } from '@omadia/usage-telemetry';
import type { Pool } from 'pg';

import { claudeCliAdapter } from '../src/platform/claudeCliAdapter.js';

/**
 * #309 Shape 2 / OM-85 / OM-103 / #1077 — the completion path of the
 * `claude-cli` adapter, driven through its real `complete()`/`stream()`.
 *
 * `cliBackendDetector.test.ts` only covered capability detection and the
 * general-tool refusal; nothing ran a completion, so the version gate, the
 * exit/parse/error handling and the ledger row could all regress in CI
 * silently. Here a fake `claude` shell script sits first on a doctored PATH
 * (precedent: `cliInstallService.test.ts`), so the adapter's own spawn — with
 * its own gated environment — runs it. Custom env vars do not survive that
 * gate, so each case REWRITES the script instead of parameterising it. The
 * suite never reaches a real `claude` binary, which keeps it off the
 * `cliSpawnGate.test.ts` trap of depending on a local install.
 *
 * The version probe is cached per process, so every case clears it first.
 */

const IS_WINDOWS = process.platform === 'win32';

interface CapturedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

// The recorder is a process singleton and `initUsageRecorder` is first-wins,
// so the whole file shares one fake pool (same as usageSubscription.test.ts).
const captured: CapturedQuery[] = [];
initUsageRecorder({
  query: (sql: string, params: readonly unknown[]) => {
    captured.push({ sql, params });
    return Promise.resolve({ rows: [] });
  },
} as unknown as Pool);

/** Column count and order of the INSERT in `recorder.ts`. */
const COLS_PER_ROW = 13;
const COL = {
  source: 0,
  model: 1,
  inputTokens: 2,
  outputTokens: 3,
  cacheReadTokens: 4,
  cacheCreationTokens: 5,
  costUsd: 6,
  referenceCostUsd: 9,
  provider: 11,
} as const;

interface FakeCli {
  /** What `claude --version` prints. */
  readonly version: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

let binDir = '';
let previousPath: string | undefined;
let previousApiKey: string | undefined;
let previousToolsDir: string | undefined;

function writeFakeClaude(fake: FakeCli): void {
  writeFileSync(path.join(binDir, 'stdout.txt'), fake.stdout ?? '');
  writeFileSync(path.join(binDir, 'stderr.txt'), fake.stderr ?? '');
  const q = (p: string): string => `'${path.join(binDir, p)}'`;
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' '${fake.version}'`,
    '  exit 0',
    'fi',
    `: > ${q('argv.txt')}`,
    `for a in "$@"; do printf '%s\\n' "$a" >> ${q('argv.txt')}; done`,
    `printf '%s|%s' "$CLAUDE_CODE_RESTRICTED" "$ANTHROPIC_API_KEY" > ${q('env.txt')}`,
    `cat > ${q('stdin.txt')}`,
    `cat ${q('stdout.txt')}`,
    `cat ${q('stderr.txt')} >&2`,
    `exit ${String(fake.exitCode ?? 0)}`,
    '',
  ].join('\n');
  const file = path.join(binDir, 'claude');
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

const readCaptured = (name: string): string => readFileSync(path.join(binDir, name), 'utf8');
const argv = (): string[] => readCaptured('argv.txt').split('\n').slice(0, -1);

function request(extra: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'opus-cli',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarise this chat' }] }],
    maxTokens: 100,
    ...extra,
  };
}

const provider = claudeCliAdapter.build({ apiKey: 'no-key-required', id: 'claude-cli' });

const okJson = (result: string): string =>
  JSON.stringify({
    result,
    is_error: false,
    usage: {
      input_tokens: 120,
      output_tokens: 34,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 64,
    },
    total_cost_usd: 0.0123,
  });

describe('claudeCliAdapter completion (Shape 2)', { skip: IS_WINDOWS ? 'POSIX shell fake' : false }, () => {
  beforeEach(async () => {
    // Drain rows an earlier case left in the recorder's process-wide buffer
    // BEFORE forgetting what was captured: otherwise its 5 s flush timer can
    // land a previous case's rows inside this one.
    await flushUsageRecorder();
    binDir = mkdtempSync(path.join(tmpdir(), 'fake-claude-'));
    previousPath = process.env['PATH'];
    previousApiKey = process.env['ANTHROPIC_API_KEY'];
    // Our fake first; /usr/bin:/bin only so the script's `cat` resolves.
    process.env['PATH'] = `${binDir}:/usr/bin:/bin`;
    process.env['ANTHROPIC_API_KEY'] = 'sk-must-not-reach-the-cli';
    // #1085 — the adapter prefers `<CLI_TOOLS_DIR>/bin/claude` over PATH. An
    // empty dir keeps a developer's runtime install (default
    // `<cwd>/data/cli-tools`) from shadowing the fake with a logged-in CLI.
    previousToolsDir = process.env['CLI_TOOLS_DIR'];
    process.env['CLI_TOOLS_DIR'] = path.join(binDir, 'no-runtime-install');
    clearCliVersionCache();
    captured.length = 0;
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
    if (previousApiKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = previousApiKey;
    if (previousToolsDir === undefined) delete process.env['CLI_TOOLS_DIR'];
    else process.env['CLI_TOOLS_DIR'] = previousToolsDir;
    rmSync(binDir, { recursive: true, force: true });
  });

  it('passes --restricted to a CLI that supports it and returns the text answer', async () => {
    writeFakeClaude({ version: '2.1.300 (Claude Code)', stdout: okJson('the summary') });
    const res = await provider.complete(request());

    assert.deepEqual(res.content, [{ type: 'text', text: 'the summary' }]);
    assert.equal(res.finishReason, 'stop');
    assert.deepEqual(res.usage, { inputTokens: 120, outputTokens: 34, cacheReadTokens: 800 });

    const args = argv();
    assert.ok(args.includes('--restricted'), `argv: ${args.join(' ')}`);
    assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'json', '--model', 'opus']);
    // The prompt travels on stdin, never argv.
    assert.equal(readCaptured('stdin.txt'), 'Human: Summarise this chat');
    assert.ok(!args.some((a) => a.includes('Summarise')));
    // The gated env: the restricted twin is set, the API key is not passed.
    assert.equal(readCaptured('env.txt'), '1|');
  });

  it('leaves --restricted out for an older or unparsable CLI version', async () => {
    for (const version of ['2.1.100 (Claude Code)', 'garbage']) {
      clearCliVersionCache();
      writeFakeClaude({ version, stdout: okJson('ok') });
      await provider.complete(request());
      assert.equal(argv().includes('--restricted'), false, `version=${version}`);
      // The env twin of the flag is set regardless of the CLI version.
      assert.equal(readCaptured('env.txt'), '1|', `version=${version}`);
    }
  });

  it('records the call on the ledger as a zero-cost subscription completion', async () => {
    writeFakeClaude({ version: '2.1.300', stdout: okJson('ok') });
    await provider.complete(request());
    await flushUsageRecorder();

    assert.equal(captured.length, 1);
    const p = captured[0]!.params;
    // Exactly one row: a completion recorded twice would widen the INSERT.
    assert.equal(p.length, COLS_PER_ROW, `rows written: ${String(p.length / COLS_PER_ROW)}`);
    assert.equal(p[COL.source], 'claude-cli-completion');
    assert.equal(p[COL.provider], 'claude-cli');
    assert.equal(p[COL.model], 'opus-cli');
    assert.equal(p[COL.inputTokens], 120);
    assert.equal(p[COL.outputTokens], 34);
    assert.equal(p[COL.cacheReadTokens], 800);
    assert.equal(p[COL.cacheCreationTokens], 64);
    assert.equal(p[COL.costUsd], 0, 'a flat-fee call is not billed per token');
    assert.equal(p[COL.referenceCostUsd], 0.0123);
  });

  it('turns a rejected gate flag into a CliIncompatibleError naming the flag', async () => {
    writeFakeClaude({
      version: '2.1.300',
      stderr: "error: unknown option '--restricted'\n",
      exitCode: 1,
    });
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(' '));
    try {
      await assert.rejects(provider.complete(request()), (err: unknown) => {
        assert.ok(err instanceof CliIncompatibleError, String(err));
        assert.equal(err.flag, '--restricted');
        assert.equal(err.cliVersion, '2.1.300');
        return true;
      });
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.length, 1, warned.join('\n'));
    assert.match(warned[0]!, /completion exited 1 \(cli 2\.1\.300\): error: unknown option '--restricted'/);
  });

  it('rejects any other non-zero exit with the exit code and stderr', async () => {
    writeFakeClaude({
      version: '2.1.300',
      stdout: 'the model answer, which must stay out of the log',
      stderr: 'Not logged in\nsecond line',
      exitCode: 2,
    });
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(' '));
    try {
      await assert.rejects(provider.complete(request()), (err: unknown) => {
        assert.ok(!(err instanceof CliIncompatibleError));
        assert.match(String(err), /claude-cli exited 2: Not logged in/);
        // … which the provider's own classifier then reads as an auth failure.
        assert.deepEqual(provider.classifyError?.(err), { retryable: false, kind: 'auth' });
        return true;
      });
    } finally {
      console.warn = warn;
    }
    // OM-94: the warn is the only trace a failed background completion
    // leaves — exit code and first stderr line, never stdout.
    assert.equal(warned.length, 1, warned.join('\n'));
    assert.match(warned[0]!, /\[claude-cli\] completion exited 2 \(cli 2\.1\.300\): Not logged in$/);
    assert.ok(!warned[0]!.includes('model answer'), warned[0]!);
    await flushUsageRecorder();
    assert.equal(captured.length, 0, 'a failed call writes no ledger row');
  });

  it('rejects output that is not JSON, and a result the CLI flags as an error', async () => {
    writeFakeClaude({ version: '2.1.300', stdout: 'progress… no json here' });
    await assert.rejects(provider.complete(request()), /non-JSON output/);

    writeFakeClaude({
      version: '2.1.300',
      stdout: JSON.stringify({ is_error: true, result: 'quota exhausted' }),
    });
    await assert.rejects(provider.complete(request()), /reported an error: quota exhausted/);
    await flushUsageRecorder();
    assert.equal(captured.length, 0);
  });

  it('answers a forced single tool with a parsed tool_call', async () => {
    const tool = {
      name: 'judge',
      description: 'grade a claim',
      inputSchema: { type: 'object', properties: { verdict: { type: 'string' } } },
    };
    writeFakeClaude({ version: '2.1.300', stdout: okJson('{"verdict":"supported"}') });
    const res = await provider.complete(
      request({ tools: [tool], toolChoice: { type: 'tool', name: 'judge' } }),
    );
    assert.deepEqual(res.content, [
      { type: 'tool_call', id: 'call_judge', name: 'judge', input: { verdict: 'supported' } },
    ]);
    assert.equal(res.finishReason, 'tool_calls');
    // The schema rides in the prompt, so the CLI knows the shape to emit.
    assert.match(readCaptured('stdin.txt'), /`judge`[\s\S]*"verdict"/);

    writeFakeClaude({ version: '2.1.300', stdout: okJson('I think it is supported') });
    await assert.rejects(
      provider.complete(request({ tools: [tool], toolChoice: { type: 'tool', name: 'judge' } })),
      /forced-tool 'judge': model did not return parseable JSON args/,
    );
  });

  it('streams the one-shot answer as a single delta plus the final response', async () => {
    writeFakeClaude({ version: '2.1.300', stdout: okJson('streamed') });
    const events: unknown[] = [];
    for await (const ev of provider.stream(request())) events.push(ev);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { type: 'text_delta', text: 'streamed' });
    assert.equal((events[1] as { type: string }).type, 'final');
  });
});

describe('claudeCliAdapter classifyError', () => {
  it('maps login, rate-limit and overload messages to their kinds', () => {
    const classify = (msg: string): unknown => provider.classifyError?.(new Error(msg));
    assert.deepEqual(classify('Not logged in · Please run /login'), { retryable: false, kind: 'auth' });
    assert.deepEqual(classify('429 rate limit reached'), { retryable: true, kind: 'rate_limit' });
    assert.deepEqual(classify('API overloaded (529)'), { retryable: true, kind: 'overloaded' });
    assert.deepEqual(classify('something else broke'), { retryable: false, kind: 'other' });
  });
});
