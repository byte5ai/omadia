/**
 * Identity guard (#2046, spec 2042 INV-3, §5.5, ADR-0013): mandatory and
 * fail-closed, independent of the fact verifier and its settings.
 *
 * Every `prose` emission passes it before publication:
 *  1. the deterministic layer (directory of names and aliases, human claims);
 *  2. the model layer, for text the deterministic layer marks suspicious (a
 *     colleague is mentioned, someone is introduced): a judge sees the masked
 *     text and decides whether it speaks as, or attributes words to, someone
 *     else. A judge error or timeout blocks: fail-closed.
 *
 * Streaming: {@link SentenceGate} releases complete sentences only, each one
 * checked together with all text of the answer so far, so a claim split
 * across chunks is caught before any of it is visible.
 */

import type { AgentSpeaker } from '@omadia/plugin-api';

import {
  IdentityGuardPatterns,
  type GuardDirectoryEntry,
  type IdentityGuardRule,
} from './deterministic.js';

/** The model layer may take this long before the guard fails closed. */
export const IDENTITY_GUARD_JUDGE_TIMEOUT_MS = 8_000;

export interface IdentityJudgeRequest {
  /** The answer so far, masked by the privacy shield. */
  readonly text: string;
  /** Who the speaking agent is. */
  readonly speakerName: string;
  /** Colleagues the text mentions. */
  readonly colleagues: readonly string[];
}

export interface IdentityJudgeVerdict {
  readonly verdict: 'pass' | 'block';
  readonly reason?: string;
}

/** The model layer. Runs as an internal helper of the speaking agent. */
export interface IdentityJudge {
  judge(request: IdentityJudgeRequest, signal: AbortSignal): Promise<IdentityJudgeVerdict>;
}

export type IdentityGuardResult =
  | { readonly outcome: 'pass'; readonly latencyMs: number; readonly modelLayer: boolean }
  | {
      readonly outcome: 'blocked';
      readonly layer: 'deterministic' | 'model';
      readonly rule?: IdentityGuardRule;
      readonly agent?: string;
      readonly latencyMs: number;
    }
  | {
      /** The model layer could not decide (error, timeout, no judge). */
      readonly outcome: 'unavailable';
      readonly cause: 'timeout' | 'error' | 'no_judge';
      /** With `error`: the error's message, for the operator log. */
      readonly detail?: string;
      readonly latencyMs: number;
    };

export interface IdentityGuardOptions {
  readonly speaker: AgentSpeaker;
  readonly directory: readonly GuardDirectoryEntry[];
  /** The model layer; absent: suspicious text fails closed. */
  readonly judge?: IdentityJudge;
  /** Masks text before the judge sees it (privacy shield). Identity when absent. */
  readonly mask?: (text: string) => Promise<string>;
  readonly judgeTimeoutMs?: number;
  readonly now?: () => number;
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; cause: 'timeout' | 'error'; detail?: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const raced = await Promise.race([run(controller.signal), timeout]);
    if (raced === 'timeout') {
      controller.abort();
      return { ok: false, cause: 'timeout' };
    }
    return { ok: true, value: raced };
  } catch (err) {
    return { ok: false, cause: 'error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 120) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class IdentityGuard {
  private readonly patterns: IdentityGuardPatterns;
  private readonly now: () => number;

  constructor(private readonly options: IdentityGuardOptions) {
    this.patterns = new IdentityGuardPatterns(
      {
        agentId: options.speaker.agentId,
        slug: options.speaker.slug,
        displayName: options.speaker.displayName,
      },
      options.directory,
    );
    this.now = options.now ?? Date.now;
  }

  /**
   * Checks the whole text an agent wants to publish (or has so far).
   * `segment` is the part of `text` not checked before (streaming): when the
   * segment alone gives the model layer nothing to look at, the earlier
   * verdict on the rest stands and no model call is made for it again.
   */
  async check(text: string, segment?: string): Promise<IdentityGuardResult> {
    const started = this.now();
    const deterministic = this.patterns.check(text);
    if (deterministic.verdict === 'block') {
      return {
        outcome: 'blocked',
        layer: 'deterministic',
        rule: deterministic.rule,
        ...(deterministic.agent ? { agent: deterministic.agent } : {}),
        latencyMs: this.now() - started,
      };
    }
    if (!deterministic.suspicious || (segment !== undefined && this.segmentIsPlain(segment))) {
      return { outcome: 'pass', latencyMs: this.now() - started, modelLayer: false };
    }
    const judge = this.options.judge;
    if (!judge) {
      return { outcome: 'unavailable', cause: 'no_judge', latencyMs: this.now() - started };
    }
    const timeoutMs = this.options.judgeTimeoutMs ?? IDENTITY_GUARD_JUDGE_TIMEOUT_MS;
    const judged = await withTimeout(async (signal) => {
      const masked = this.options.mask ? await this.options.mask(text) : text;
      return judge.judge(
        {
          text: masked,
          speakerName: this.options.speaker.displayName,
          colleagues: deterministic.mentions,
        },
        signal,
      );
    }, timeoutMs);
    const latencyMs = this.now() - started;
    if (!judged.ok) {
      return {
        outcome: 'unavailable',
        cause: judged.cause,
        ...(judged.detail !== undefined ? { detail: judged.detail } : {}),
        latencyMs,
      };
    }
    if (judged.value.verdict === 'block') {
      return { outcome: 'blocked', layer: 'model', latencyMs };
    }
    return { outcome: 'pass', latencyMs, modelLayer: true };
  }

  private segmentIsPlain(segment: string): boolean {
    const verdict = this.patterns.check(segment);
    return verdict.verdict === 'pass' && !verdict.suspicious;
  }
}

/**
 * The end of a sentence: terminal punctuation followed by whitespace, or a
 * line break. A decimal point ("3.5") or an abbreviation without a following
 * space is not one.
 */
const SENTENCE_END = /(?:[.!?…]+["'”’)\]]*\s+|\n+)/gu;

/** The released prefix of `buffer`: everything up to the last sentence end. */
export function completeSentencePrefix(buffer: string): string {
  let end = 0;
  for (const match of buffer.matchAll(SENTENCE_END)) {
    end = (match.index ?? 0) + match[0].length;
  }
  return buffer.slice(0, end);
}

/** Whether a check went to the model layer (the judge). */
export function usedModelLayer(result: IdentityGuardResult): boolean {
  if (result.outcome === 'pass') return result.modelLayer;
  return result.outcome === 'unavailable' || result.layer === 'model';
}

export type GateStep =
  | { readonly kind: 'release'; readonly text: string }
  | { readonly kind: 'hold' }
  | { readonly kind: 'blocked'; readonly result: Exclude<IdentityGuardResult, { outcome: 'pass' }> };

/**
 * Sentence-wise release for a streamed answer. Feed deltas with
 * {@link push}; call {@link finish} at the end of the stream. Once a check
 * fails, nothing more is released.
 */
export class SentenceGate {
  private buffer = '';
  private released = '';
  private stopped = false;
  private judged = false;
  private readonly latencies: number[] = [];

  constructor(private readonly guard: IdentityGuard) {}

  /** Text released so far. */
  get releasedText(): string {
    return this.released;
  }

  /** Guard latency of every check, in order. */
  get latencyMs(): readonly number[] {
    return this.latencies;
  }

  async push(delta: string): Promise<GateStep> {
    if (this.stopped) return { kind: 'hold' };
    this.buffer += delta;
    const complete = completeSentencePrefix(this.buffer);
    if (complete.length === 0) return { kind: 'hold' };
    return this.release(complete);
  }

  /**
   * The inner stream took back its last `chars` characters (`text_retract`).
   * Held text goes first; returns how many already released characters the
   * client must drop as well.
   */
  retract(chars: number): number {
    const fromBuffer = Math.min(chars, this.buffer.length);
    this.buffer = this.buffer.slice(0, this.buffer.length - fromBuffer);
    const fromReleased = Math.min(chars - fromBuffer, this.released.length);
    this.released = this.released.slice(0, this.released.length - fromReleased);
    return fromReleased;
  }

  /** True once a check went to the model layer (the judge). */
  get usedModelLayer(): boolean {
    return this.judged;
  }

  /** True once a check failed: nothing more is released. */
  get blocked(): boolean {
    return this.stopped;
  }

  async finish(): Promise<GateStep> {
    if (this.stopped) return { kind: 'hold' };
    if (this.buffer.length === 0) return { kind: 'hold' };
    return this.release(this.buffer);
  }

  private async release(chunk: string): Promise<GateStep> {
    const result = await this.guard.check(
      this.released + chunk,
      this.released.length > 0 ? chunk : undefined,
    );
    this.latencies.push(result.latencyMs);
    if (usedModelLayer(result)) this.judged = true;
    if (result.outcome !== 'pass') {
      this.stopped = true;
      this.buffer = '';
      return { kind: 'blocked', result };
    }
    this.released += chunk;
    this.buffer = this.buffer.slice(chunk.length);
    return { kind: 'release', text: chunk };
  }
}
