import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A fake `claude` binary on the PATH, for tests that exercise the REAL
 * subscription-CLI factories (`createCliSubAgent` → `CliChatAgent` → spawn)
 * without a logged-in CLI. Precedent for doctoring PATH:
 * `test/cliInstallService.test.ts`.
 *
 * The script answers `--version`, reads the prompt from stdin, appends one
 * line per spawn to a counter file and replays scripted stream-json:
 * `message_start`, one `text_delta`, optionally an assistant `tool_use` plus
 * the user `tool_result`, and a terminal `result` with usage. It never talks
 * to the loopback MCP server, so the tool does not actually run — the tests
 * only observe the event stream.
 *
 * The scenario is baked into the script text: the CLI spawn gate passes only
 * an allowlisted environment to the child, so an env var would not arrive.
 */
export interface FakeClaudeScenario {
  /** Tool the fake "calls", e.g. `mcp__omadia__fill_slot`. Omit for a text-only turn. */
  readonly toolName?: string;
  /** Input recorded on the fake tool_use block. */
  readonly toolInput?: unknown;
  /**
   * When set, the tool call is only emitted on a spawn whose stdin contains
   * this marker (a re-prompt); other spawns answer with text only.
   */
  readonly toolOnlyWhenStdinIncludes?: string;
  /** Text the fake streams and returns as its final answer. */
  readonly answer?: string;
}

export interface FakeClaudeCli {
  /** How many non-`--version` spawns the fake has served. */
  spawnCount(): number;
  /** The stdin each spawn received, in order. */
  prompts(): string[];
  /** Restore PATH and delete the fake. */
  dispose(): void;
}

export function installFakeClaudeCli(scenario: FakeClaudeScenario): FakeClaudeCli {
  const binDir = mkdtempSync(path.join(tmpdir(), 'fake-claude-bin-'));
  const logFile = path.join(binDir, 'spawns.jsonl');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const scenario = ${JSON.stringify(scenario)};
const logFile = ${JSON.stringify(logFile)};
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.259 (Claude Code)\\n');
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(logFile, JSON.stringify({ stdin }) + '\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const answer = scenario.answer || 'fake answer';
  const callTool =
    typeof scenario.toolName === 'string' &&
    (scenario.toolOnlyWhenStdinIncludes === undefined ||
      stdin.includes(scenario.toolOnlyWhenStdinIncludes));
  out({ type: 'stream_event', event: { type: 'message_start' } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } });
  if (callTool) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_fake_1', name: scenario.toolName, input: scenario.toolInput ?? {} }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fake_1', content: [{ type: 'text', text: 'ok' }] }] } });
  }
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: answer,
    num_turns: callTool ? 2 : 1,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
});
`;
  const bin = path.join(binDir, 'claude');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);

  const previousPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}${path.delimiter}${previousPath ?? ''}`;

  const readLog = (): string[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => (JSON.parse(l) as { stdin: string }).stdin)
      : [];

  return {
    spawnCount: () => readLog().length,
    prompts: readLog,
    dispose() {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}
