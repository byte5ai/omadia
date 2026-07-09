/**
 * Epic #470 W0 — drive the headless `claude` CLI (spec §5 step 4/5).
 *
 * Spawns `claude -p --output-format stream-json --include-partial-messages
 * --verbose … --dangerously-skip-permissions` with cwd = the clone, the prompt
 * on STDIN (never argv), and an ALLOWLIST-built environment. The env is built
 * up, not scrubbed down: the middleware's `CLI_ENV_SCRUB_KEYS` strips
 * `ANTHROPIC_BASE_URL`, which is exactly the var the W1 LLM proxy needs, so this
 * shim deliberately does NOT reuse that list (spec §5 step 4).
 *
 * stdout NDJSON is translated (`CliEventTranslator`) and stderr lines become
 * `log {stream:'stderr'}` events; both are batched and flushed every 1 s or 50
 * events (spec §5 step 5).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { CliEventTranslator } from './eventTranslate.js';
import type { DevJobSpec, RunnerEvent } from './protocol.js';

export interface AgentRunOptions {
  cliBin: string;
  cwd: string;
  spec: DevJobSpec;
  /** W1 LLM proxy base URL → `ANTHROPIC_BASE_URL`. Absent in the W0 walking skeleton. */
  proxyBaseUrl?: string;
  /** Per-job bearer for the proxy → `ANTHROPIC_AUTH_TOKEN`. */
  proxyToken?: string;
  /** Batched event sink. The caller assigns `seq` and posts to the home API. */
  emit: (events: RunnerEvent[]) => void;
  now?: () => string;
  flushIntervalMs?: number;
  flushMaxEvents?: number;
}

export interface AgentRunHandle {
  /** Resolves with the CLI exit code once stdio has drained. */
  done: Promise<{ code: number }>;
  /** Cooperative stop — SIGTERM the CLI (cancel path, spec §5 step 3). */
  kill: () => void;
}

export function runAgent(opts: AgentRunOptions): AgentRunHandle {
  const flushMax = opts.flushMaxEvents ?? 50;
  const flushEveryMs = opts.flushIntervalMs ?? 1000;
  const translator = new CliEventTranslator(opts.now);

  // --- batching sink -------------------------------------------------------
  let pending: RunnerEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    opts.emit(batch);
  };
  const enqueue = (events: RunnerEvent[]): void => {
    if (events.length === 0) return;
    pending.push(...events);
    if (pending.length >= flushMax) {
      flush();
      return;
    }
    timer ??= setTimeout(() => {
      timer = null;
      flush();
    }, flushEveryMs);
  };

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
  if (opts.spec.agent.model) args.push('--model', opts.spec.agent.model);
  if (opts.spec.agent.maxTurns !== undefined) args.push('--max-turns', String(opts.spec.agent.maxTurns));

  const child = spawn(opts.cliBin, args, {
    cwd: opts.cwd,
    env: buildAgentEnv(opts),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  wireLineStream(child, translator, enqueue);

  // The prompt goes on stdin, never argv — argv is world-readable via `ps`.
  child.stdin.end(opts.spec.brief);

  const done = new Promise<{ code: number }>((resolve, reject) => {
    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      enqueue(translator.finish());
      flush();
      resolve({ code: code ?? -1 });
    });
  });

  return {
    done,
    kill: () => {
      child.kill('SIGTERM');
    },
  };
}

/**
 * The env allowlist (spec §5 step 4). Only what the CLI genuinely needs, plus
 * the proxy routing. Deliberately NOT a scrub-list: nothing about the parent
 * environment is trusted to be absent, so we start empty and add.
 */
export function buildAgentEnv(opts: Pick<AgentRunOptions, 'cwd' | 'proxyBaseUrl' | 'proxyToken'>): NodeJS.ProcessEnv {
  const parent = process.env;
  const env: NodeJS.ProcessEnv = {
    PATH: parent['PATH'] ?? '/usr/bin:/bin',
    HOME: parent['HOME'] ?? opts.cwd,
    LANG: parent['LANG'] ?? 'C.UTF-8',
    ...(parent['TERM'] ? { TERM: parent['TERM'] } : {}),
  };
  // The W1 LLM proxy — API-key jobs reach the model only through it. In the W0
  // walking skeleton these are absent and the CLI uses its own host login.
  if (opts.proxyBaseUrl) env['ANTHROPIC_BASE_URL'] = opts.proxyBaseUrl;
  if (opts.proxyToken) env['ANTHROPIC_AUTH_TOKEN'] = opts.proxyToken;
  return env;
}

/** Split stdout into NDJSON lines → translator; stderr into `log` events. */
function wireLineStream(
  child: ChildProcessWithoutNullStreams,
  translator: CliEventTranslator,
  enqueue: (events: RunnerEvent[]) => void,
): void {
  let outBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    outBuf += chunk;
    let nl: number;
    while ((nl = outBuf.indexOf('\n')) !== -1) {
      const line = outBuf.slice(0, nl);
      outBuf = outBuf.slice(nl + 1);
      enqueue(translator.push(line));
    }
  });
  child.stdout.on('end', () => {
    if (outBuf.length > 0) enqueue(translator.push(outBuf));
  });

  let errBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errBuf += chunk;
    let nl: number;
    while ((nl = errBuf.indexOf('\n')) !== -1) {
      const line = errBuf.slice(0, nl).trimEnd();
      errBuf = errBuf.slice(nl + 1);
      if (line.length > 0) {
        enqueue([{ type: 'log', ts: new Date().toISOString(), payload: { stream: 'stderr', text: line } }]);
      }
    }
  });
  child.stderr.on('end', () => {
    const line = errBuf.trimEnd();
    if (line.length > 0) {
      enqueue([{ type: 'log', ts: new Date().toISOString(), payload: { stream: 'stderr', text: line } }]);
    }
  });
}
