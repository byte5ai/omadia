/**
 * ADR-0195 (#2239) — the Privacy Shield on the subscription-CLI path.
 *
 * The CLI child is a model that reads everything on its stdin and every tool
 * result the loopback MCP server hands it. Under a privacy guard the turn
 * therefore runs through the same handle an in-process turn uses:
 *
 *  - the user message and the recalled context are masked before the spawn,
 *    the replayed history through `CliChatAgent.maskHistory`;
 *  - every loopback tool call has its prompt surrogates restored before the
 *    handler runs and its result masked again (`wrapDispatch`); the tool
 *    result itself is interned by `ToolDispatchService` through the ambient
 *    handle, and the v4 verb + render tools are served over the same server;
 *  - the streamed text is restored on the way out (`StreamSurrogateRestorer`),
 *    the final answer through the orchestrator's restore (`releaseAnswer`),
 *    and the turn's receipt is drained once (`finalize`).
 *
 * The orchestrator builds a {@link CliTurnPrivacy} per turn
 * (`Orchestrator.cliTurnPrivacy`); this module only holds the contract and the
 * pieces that need no orchestrator state.
 */

import type { PrivacyReceipt } from '@omadia/plugin-api';

import type { LoopbackDispatch } from './cliMemoryTool.js';
import type { PrivacyTurnHandle } from './privacyHandle.js';
import type { DispatchableToolSpec } from './toolDispatchService.js';

/** The final answer of a guarded CLI turn, ready for the `done` event. */
export interface CliReleasedAnswer {
  readonly answer: string;
  /** `'privacy-render'` when a `v4_render_answer` call produced the answer. */
  readonly answerSource?: 'privacy-render';
  readonly answerIsError?: boolean;
  readonly maskedValues?: readonly string[];
}

/** What the turn's receipt adds to the `done` event. */
export interface CliPrivacyReceiptFields {
  readonly privacyReceipt?: PrivacyReceipt;
  readonly receiptId?: string;
}

/**
 * One guarded CLI turn's privacy state. Every method runs in the turn's
 * captured context (the caller wraps it in `runInTurnContext`): the room's
 * field rights and the canvas sink are read from there.
 */
export interface CliTurnPrivacy {
  /** The turn's handle; installed as `turnContext.privacyHandle`. */
  readonly handle: PrivacyTurnHandle;
  /** The v4 verb + render tools, advertised over the loopback server. */
  readonly tools: readonly DispatchableToolSpec[];
  /** The data-plane directive for the system prompt. */
  readonly directive: string;
  /** Mask the user's message. Throws the orchestrator's
   *  `PromptMaskBlockedError` on the fail-closed `blocked` outcome. */
  maskUserMessage(text: string): Promise<string>;
  /** Mask the recalled context like a replayed answer. Throws like
   *  {@link maskUserMessage}. */
  maskRecalled(text: string): Promise<string>;
  /** The loopback dispatch with tool inputs restored and results re-masked,
   *  and the `v4_*` tools served by the handle. */
  wrapDispatch(base: LoopbackDispatch): LoopbackDispatch;
  /** A synchronous restorer for streamed text, or `undefined` when the room
   *  may not see the restored values (the deltas then keep the surrogates). */
  streamRestorer(): Promise<((text: string) => string) | undefined>;
  /** The render swap and the restore of the final answer. */
  releaseAnswer(answer: string): Promise<CliReleasedAnswer>;
  /** Drain the receipt and drop the turn's privacy state. Never throws. */
  finalize(userMessage: string): Promise<CliPrivacyReceiptFields>;
  /** The user-facing refusal when `error` is a blocked mask, else `undefined`. */
  refusalFor(error: unknown): string | undefined;
}

/** Longest tail kept back so a surrogate split across chunks restores whole.
 *  Surrogates are far shorter (`PLATZHALTER-CUSTOM-<n>`, a pool name, a pool
 *  address at `example.net`). */
export const STREAM_RESTORE_HOLDBACK = 96;

const LINE_BREAK = '\n';
/** Whitespace cuts tried per chunk before waiting for more text. */
const MAX_CUT_CANDIDATES = 8;

/**
 * Restores prompt surrogates in streamed text deltas. A surrogate the CLI
 * streams in two chunks ("PLATZHAL" + "TER-NAME-1") is held back until it is
 * whole: text is released only up to a cut after which no surrogate can still
 * be open. The cut is the last line break, or a whitespace at least
 * {@link STREAM_RESTORE_HOLDBACK} characters before the end whose restored
 * prefix agrees with the restore of everything buffered (so a multi-word
 * surrogate is never split). `flush()` releases the rest at the end of the
 * turn. The `done` answer stays authoritative.
 */
export class StreamSurrogateRestorer {
  private pending = '';

  public constructor(private readonly restore: (text: string) => string) {}

  /** Buffer `delta`; return the text that may be shown now ('' if none). */
  public push(delta: string): string {
    this.pending += delta;
    const cut = this.safeCut();
    if (cut <= 0) return '';
    const out = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return this.restore(out);
  }

  /** Release everything still held back. */
  public flush(): string {
    const out = this.pending;
    this.pending = '';
    return out.length === 0 ? '' : this.restore(out);
  }

  private safeCut(): number {
    const text = this.pending;
    const lineCut = text.lastIndexOf(LINE_BREAK) + 1;
    const limit = text.length - STREAM_RESTORE_HOLDBACK;
    if (limit <= lineCut) return lineCut;
    const whole = this.restore(text);
    let tried = 0;
    for (let i = limit; i > lineCut && tried < MAX_CUT_CANDIDATES; i -= 1) {
      if (!/\s/.test(text[i - 1]!)) continue;
      tried += 1;
      if (whole.startsWith(this.restore(text.slice(0, i)))) return i;
    }
    return lineCut;
  }
}
