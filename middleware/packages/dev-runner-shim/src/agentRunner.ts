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
  /**
   * Fresh, job-scoped HOME for the child CLI. MUST live inside the job
   * workspace. The parent HOME is NEVER inherited — it holds the runner
   * user's real `~/.claude` CLI credentials and config.
   */
  homeDir?: string;
  /** W1 LLM proxy base URL → `ANTHROPIC_BASE_URL`. Absent in the W0 walking skeleton. */
  proxyBaseUrl?: string;
  /** Per-job bearer for the proxy → `ANTHROPIC_AUTH_TOKEN`. */
  proxyToken?: string;
  /**
   * Gate for handing LLM auth to the child. `false` (the default) refuses to
   * wire `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` even when a caller
   * supplies them — in W0 the token is a long-lived middleware secret, so it
   * crosses into the child ONLY under the jail acknowledgment
   * (`OMADIA_LLM_ENV_ALLOWED=true`, see `ShimEnv.llmEnvAllowed`). W1's
   * per-job proxy tokens replace this.
   */
  llmEnvAllowed?: boolean;
  /** Batched event sink. The caller assigns `seq` and posts to the home API. */
  emit: (events: RunnerEvent[]) => void;
  now?: () => string;
  flushIntervalMs?: number;
  flushMaxEvents?: number;
  /**
   * W2 — the exact prompt to hand the session on STDIN. When set it REPLACES
   * `spec.brief` (the W0 collapsed input). The phase loop uses it to feed a
   * per-phase system-prompt-plus-inputs bundle; a fresh process per phase means
   * no context bleeds between phases. Absent ⇒ W0 behaviour (`spec.brief`).
   */
  promptOverride?: string;
  /**
   * W2 — extra environment for the child, merged over the allowlisted base env
   * (e.g. `OMADIA_PHASE_ARTIFACT`, the file a phase writes its JSON artifact to).
   * Merged last, but the HOME/LLM-auth invariants in `buildAgentEnv` are set on
   * the base and callers pass only non-secret routing here.
   */
  extraEnv?: NodeJS.ProcessEnv;
}

export interface AgentRunHandle {
  /** Resolves with the CLI exit code once stdio has drained. */
  done: Promise<{ code: number }>;
  /**
   * Cooperative stop — SIGTERM by default (cancel path, spec §5 step 3).
   * Pass `'SIGKILL'` to escalate on a CLI that ignores the term.
   */
  kill: (signal?: NodeJS.Signals) => void;
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

  const baseEnv = buildAgentEnv(opts);
  const child = spawn(opts.cliBin, args, {
    cwd: opts.cwd,
    env: opts.extraEnv ? { ...baseEnv, ...opts.extraEnv } : baseEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  wireLineStream(child, translator, enqueue);

  // The prompt goes on stdin, never argv — argv is world-readable via `ps`. W2
  // phases supply `promptOverride` (system prompt + explicit inputs); W0 uses
  // the collapsed brief.
  child.stdin.end(opts.promptOverride ?? opts.spec.brief);

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
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      child.kill(signal);
    },
  };
}

/**
 * The env allowlist (spec §5 step 4). Only what the CLI genuinely needs, plus
 * the proxy routing. Deliberately NOT a scrub-list: nothing about the parent
 * environment is trusted to be absent, so we start empty and add.
 *
 * Two invariants live here, both regression-tested:
 *   1. HOME is ALWAYS job-scoped (`homeDir`, falling back to the clone dir) —
 *      never the parent HOME, which holds the runner user's real `~/.claude`
 *      credentials and CLI config.
 *   2. LLM auth crosses into the child only when `llmEnvAllowed` is true (the
 *      W0 jail acknowledgment; W1 per-job proxy tokens replace it).
 */
export function buildAgentEnv(
  opts: Pick<AgentRunOptions, 'cwd' | 'homeDir' | 'proxyBaseUrl' | 'proxyToken' | 'llmEnvAllowed'>,
): NodeJS.ProcessEnv {
  const parent = process.env;
  const env: NodeJS.ProcessEnv = {
    PATH: parent['PATH'] ?? '/usr/bin:/bin',
    HOME: opts.homeDir ?? opts.cwd,
    LANG: parent['LANG'] ?? 'C.UTF-8',
    ...(parent['TERM'] ? { TERM: parent['TERM'] } : {}),
  };
  // LLM routing — gated. In W0 the token is the middleware's own proxy secret,
  // so it is wired ONLY under the jail acknowledgment; in W1 the caller hands
  // in a per-job proxy token and sets the gate itself.
  if (opts.llmEnvAllowed === true) {
    if (opts.proxyBaseUrl) env['ANTHROPIC_BASE_URL'] = opts.proxyBaseUrl;
    if (opts.proxyToken) env['ANTHROPIC_AUTH_TOKEN'] = opts.proxyToken;
  }
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
