/**
 * Epic #470 W2 — runs exactly one pipeline phase and returns its phase-result
 * body. Split from `phaseLoop.ts` to keep both files within the 500-line rule.
 *
 * A `PhaseRunner` NEVER throws: any failure becomes `{ ok: false, error }` so the
 * MIDDLEWARE engine, not the runner, decides the job's fate. Each agent phase is
 * a fresh `claude -p` process with a fresh per-phase HOME (no context bleed);
 * `bootstrap` is a plain command; nothing is ever pushed. Node builtins only.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { HomeError } from './homeClient.js';
import { runGit, type GitOptions } from './gitOps.js';
import { runAgent } from './agentRunner.js';
import { buildPhasePrompt, PHASE_ARTIFACT_ENV, phaseWritesArtifactFile } from './phasePrompts.js';
import {
  isAgentSessionPhase,
  type AgentSessionPhase,
  type DevJobPhase,
  type DevJobSpec,
  type GateQuestion,
  type PhaseResultBody,
  type ReviewFinding,
  type RunnerEvent,
  type ShimEnv,
} from './protocol.js';

/** Bootstrap install budget — its own timeout, separate from the job wall clock. */
export const DEV_BOOTSTRAP_TIMEOUT_MS = 600_000;

/** Mutable per-provision state threaded across the phase runners. */
export interface Accumulated {
  analysis?: string;
  plan?: string;
  answers: { questionId: string; text: string }[];
  attempt: number;
  priorFindings: ReviewFinding[];
}

/** Kill-hook setter — the loop points its wall-clock / cancel kill at the child
 *  currently running. */
export type SetKill = (k: ((signal?: NodeJS.Signals) => void) | null) => void;

export interface PhaseRunnerCtx {
  spec: DevJobSpec;
  env: ShimEnv;
  repoDir: string;
  gitOpts: GitOptions;
  emit: (events: RunnerEvent[]) => void;
  acc: Accumulated;
  now?: () => string;
  setKill: SetKill;
  /** Returns a monotonic session index (fresh HOME per session). */
  session: () => number;
}

const ARTIFACT_KIND: Record<AgentSessionPhase, string> = {
  analyze: 'analysis',
  plan: 'plan',
  clarify: 'questions',
  implement: 'diff',
  review: 'review_verdict',
};

export class PhaseRunner {
  constructor(private readonly c: PhaseRunnerCtx) {}

  async run(phase: DevJobPhase): Promise<PhaseResultBody> {
    try {
      if (phase === 'bootstrap') return await this.runBootstrap();
      if (phase === 'implement') return await this.runImplement();
      if (isAgentSessionPhase(phase)) return await this.runArtifactPhase(phase);
      // await_human / pr are host-only — never handed to a runner.
      return { phase, ok: false, error: `phase '${phase}' is not runnable by the runner` };
    } catch (err) {
      return { phase, ok: false, error: errText(err) };
    }
  }

  /** analyze / plan / clarify / review — a fresh session that writes one JSON
   *  artifact to the OMADIA_PHASE_ARTIFACT file, which we read back. */
  private async runArtifactPhase(phase: AgentSessionPhase): Promise<PhaseResultBody> {
    const artifactFile = path.join(this.c.env.workspace, `artifact-${phase}-${this.c.acc.attempt}.json`);
    const prompt = buildPhasePrompt(phase, {
      brief: this.c.spec.brief,
      ...(phase === 'analyze' ? { repo: this.c.spec.repo } : {}),
      ...(this.c.acc.analysis !== undefined ? { analysis: this.c.acc.analysis } : {}),
      ...(this.c.acc.plan !== undefined ? { plan: this.c.acc.plan } : {}),
    });

    // review must not mutate the tree — capture HEAD before/after (spec §6).
    const headBefore = phase === 'review' ? await this.headSha() : '';

    const code = await this.runSession(phase, prompt, { [PHASE_ARTIFACT_ENV]: artifactFile });
    if (code !== 0) {
      return { phase, ok: false, error: `${phase} session exited with code ${String(code)}` };
    }

    if (phase === 'review') {
      const headAfter = await this.headSha();
      if (headBefore !== headAfter) {
        return { phase, ok: false, error: 'review mutated the work tree (HEAD moved) — protocol violation' };
      }
    }

    if (!phaseWritesArtifactFile(phase)) return { phase, ok: true };
    const content = await readArtifact(artifactFile);
    if (content === null) {
      return { phase, ok: false, error: `${phase} produced no ${PHASE_ARTIFACT_ENV} artifact` };
    }

    const body: PhaseResultBody = { phase, ok: true, artifact: { kind: ARTIFACT_KIND[phase], content } };
    if (phase === 'clarify') body.questions = parseQuestions(content);
    if (phase === 'review') {
      const verdict = parseJson(content);
      if (verdict === undefined) return { phase, ok: false, error: 'review verdict is not valid JSON' };
      body.verdict = verdict;
    }
    return body;
  }

  /** implement — a fresh session edits the tree; the shim collects the diff vs the
   *  pinned base sha (the agent may or may not commit) and reports it. */
  private async runImplement(): Promise<PhaseResultBody> {
    const prompt = buildPhasePrompt('implement', {
      brief: this.c.spec.brief,
      ...(this.c.acc.plan !== undefined ? { plan: this.c.acc.plan } : {}),
      answers: this.c.acc.answers,
      attempt: this.c.acc.attempt,
      priorFindings: this.c.acc.priorFindings,
    });
    const code = await this.runSession('implement', prompt, {});
    if (code !== 0) {
      return { phase: 'implement', ok: false, error: `implement session exited with code ${String(code)}` };
    }

    const { diff, numstat, hasChanges } = await this.collectDiffFromBase();
    if (!hasChanges) return { phase: 'implement', ok: false, error: 'implement produced no changes' };
    const headSha = await this.headSha();
    return {
      phase: 'implement',
      ok: true,
      artifact: { kind: 'diff', content: diff, meta: { numstat } },
      diffstat: numstat,
      ...(headSha ? { headSha } : {}),
    };
  }

  /** bootstrap — dependency install as a COMMAND (spec §4), not a CLI session. */
  private async runBootstrap(): Promise<PhaseResultBody> {
    const boot = this.c.spec.bootstrap;
    if (!boot?.command) {
      return { phase: 'bootstrap', ok: false, error: 'no bootstrap command provisioned for this repo' };
    }
    const timeoutMs = boot.timeoutMs ?? DEV_BOOTSTRAP_TIMEOUT_MS;
    const started = Date.now();
    const result = await runCommand(boot.command, {
      cwd: this.c.repoDir,
      env: bootstrapEnv(this.c.env.workspace),
      timeoutMs,
      setKill: this.c.setKill,
    });
    const durationMs = Date.now() - started;
    const report = JSON.stringify({
      command: boot.command,
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs,
    });
    if (result.code !== 0) {
      return {
        phase: 'bootstrap',
        ok: false,
        error: result.timedOut
          ? `bootstrap timed out after ${String(timeoutMs)} ms`
          : `bootstrap exited with code ${String(result.code)}`,
        artifact: { kind: 'bootstrap_report', content: report },
      };
    }
    return { phase: 'bootstrap', ok: true, artifact: { kind: 'bootstrap_report', content: report } };
  }

  /** Spawn a fresh `claude -p` session with a FRESH per-phase HOME (no session
   *  state bleeds between phases) and the phase prompt on STDIN. */
  private async runSession(
    phase: AgentSessionPhase,
    prompt: string,
    extraEnv: NodeJS.ProcessEnv,
  ): Promise<number> {
    const sessionIdx = this.c.session();
    const homeDir = path.join(this.c.env.workspace, 'home', `${phase}-${sessionIdx}`);
    await mkdir(homeDir, { recursive: true });

    const proxyBaseUrl = process.env['OMADIA_ANTHROPIC_BASE_URL']?.trim();
    const proxyToken = process.env['OMADIA_ANTHROPIC_AUTH_TOKEN']?.trim();
    const agent = runAgent({
      cliBin: this.c.env.cliBin,
      cwd: this.c.repoDir,
      homeDir,
      spec: this.c.spec,
      llmEnvAllowed: this.c.env.llmEnvAllowed,
      ...(proxyBaseUrl ? { proxyBaseUrl } : {}),
      ...(proxyToken ? { proxyToken } : {}),
      promptOverride: prompt,
      extraEnv,
      emit: this.c.emit,
      ...(this.c.now ? { now: this.c.now } : {}),
    });
    this.c.setKill(agent.kill);
    const { code } = await agent.done;
    return code;
  }

  private async headSha(): Promise<string> {
    const r = await runGit(this.c.gitOpts, ['-C', this.c.repoDir, 'rev-parse', 'HEAD'], this.c.repoDir);
    return r.code === 0 ? r.stdout.trim() : '';
  }

  /** Diff the current tree against the pinned base sha (captures both committed
   *  and uncommitted work). NO push, ever. */
  private async collectDiffFromBase(): Promise<{ diff: string; numstat: string; hasChanges: boolean }> {
    await runGit(this.c.gitOpts, ['-C', this.c.repoDir, 'add', '-A'], this.c.repoDir);
    const base = this.c.spec.repo.baseSha;
    const cachedArgs = base ? ['--cached', base] : ['--cached'];
    const diff = await runGit(
      this.c.gitOpts,
      ['-C', this.c.repoDir, 'diff', '--binary', ...cachedArgs],
      this.c.repoDir,
    );
    if (diff.code !== 0) throw new Error(`git diff failed (${String(diff.code)}): ${diff.stderr.trim()}`);
    const numstat = await runGit(
      this.c.gitOpts,
      ['-C', this.c.repoDir, 'diff', '--numstat', ...cachedArgs],
      this.c.repoDir,
    );
    if (numstat.code !== 0) throw new Error(`git diff --numstat failed (${String(numstat.code)})`);
    return { diff: diff.stdout, numstat: numstat.stdout, hasChanges: diff.stdout.trim().length > 0 };
  }
}

/** Fold a completed phase's product into the accumulator so downstream phases in
 *  the same provision can use it as an explicit input. */
export function absorb(acc: Accumulated, phase: DevJobPhase, body: PhaseResultBody): void {
  if (!body.ok || !body.artifact) return;
  if (phase === 'analyze' && body.artifact.kind === 'analysis') acc.analysis = body.artifact.content;
  if (phase === 'plan' && body.artifact.kind === 'plan') acc.plan = body.artifact.content;
  if (phase === 'review' && body.artifact.kind === 'review_verdict') {
    acc.priorFindings = extractFindings(body.artifact.content);
  }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

interface CommandResult {
  code: number;
  timedOut: boolean;
}

/** Run a shell command with its own timeout. Used only for `bootstrap`. */
function runCommand(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; setKill: SetKill },
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    opts.setKill((signal: NodeJS.Signals = 'SIGTERM') => child.kill(signal));
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, timedOut });
    });
  });
}

/** Minimal hermetic env for the bootstrap command — no LLM auth, job-scoped HOME. */
function bootstrapEnv(workspace: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: path.join(workspace, 'home'),
    LANG: process.env['LANG'] ?? 'C.UTF-8',
  };
}

/** Read the artifact file a phase wrote; null if it is missing or empty. */
async function readArtifact(file: string): Promise<string | null> {
  try {
    const raw = (await readFile(file, 'utf8')).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** clarify's artifact is a JSON array of { id, text }; malformed ⇒ empty (an
 *  empty questions array is a valid clarify result — approval-only gate). */
function parseQuestions(text: string): GateQuestion[] {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (q): q is GateQuestion =>
        !!q &&
        typeof q === 'object' &&
        typeof (q as GateQuestion).id === 'string' &&
        typeof (q as GateQuestion).text === 'string',
    )
    .map((q) => ({ id: q.id, text: q.text }));
}

function extractFindings(text: string): ReviewFinding[] {
  const parsed = parseJson(text);
  if (!parsed || typeof parsed !== 'object') return [];
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  return findings.filter(
    (f): f is ReviewFinding =>
      !!f &&
      typeof f === 'object' &&
      typeof (f as ReviewFinding).file === 'string' &&
      typeof (f as ReviewFinding).issue === 'string',
  );
}

export function errText(err: unknown): string {
  if (err instanceof HomeError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
