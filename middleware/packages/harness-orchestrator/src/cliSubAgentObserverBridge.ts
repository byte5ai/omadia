import type { ChatStreamEvent } from '@omadia/channel-sdk';

import type { CliChatHooks, CliUsage } from './cliChatAgent.js';
import { OMADIA_MCP_TOOL_PREFIX } from './cliSpawnGate.js';
import type { AskObserver } from './tools/domainQueryTool.js';

/** Window over which `tokensPerSec` is re-measured — same as `streaming.ts`. */
const TOKEN_RATE_WINDOW_MS = 500;
/** chars → tokens approximation, the same one `streaming.ts` uses. */
const CHARS_PER_TOKEN = 4;

type Phase = 'thinking' | 'streaming' | 'tool_running';

export interface CliObserverBridgeOptions {
  /** Sub-agent label for log lines. */
  readonly label: string;
  readonly observer?: AskObserver;
  /** Called with the raw name of a tool call that did not come through omadia's loopback server. */
  readonly onForeignToolUse?: (toolName: string) => void;
}

/**
 * #1072 — maps one `ask()`'s `CliChatAgent` event stream onto the
 * {@link AskObserver} the API-path sub-agent (`LocalSubAgent` +
 * `streaming.ts`) drives, so the builder's live view works on the
 * subscription path too.
 *
 * The CLI owns the model loop and only reports text deltas, whole tool calls,
 * tool results and one usage figure per spawn, so the mapping approximates:
 * - an iteration ends when the model speaks again after a tool result (or the
 *   spawn ends after one) — that is where the API path would start its next
 *   model call;
 * - tokens are `ceil(chars / 4)` of the text deltas, per iteration;
 * - usage is reported once per spawn, on the spawn's last iteration.
 *
 * Only omadia tools (`mcp__omadia__*`) reach the observer, with the prefix
 * stripped: the builder UI and the obligation check compare bare ids. A
 * foreign call (one of the CLI's own tools, OM-81) is never forwarded — the
 * builder trace has no way to mark it as foreign — and goes to
 * `onForeignToolUse` instead.
 *
 * Iteration numbers continue across spawns (a re-prompt does not restart at
 * 0). Every observer callback is wrapped: a buggy listener cannot fail a turn.
 */
export class CliObserverBridge {
  private readonly called = new Set<string>();
  private readonly forwardedIds = new Set<string>();
  private iteration = -1;
  private phase: Phase | undefined;
  private toolUseCount = 0;
  private textLength = 0;
  private cumulativeTokens = 0;
  private windowStart = 0;
  private windowTokens = 0;
  private tokensPerSec = 0;
  /** A tool result arrived; the next model output belongs to a new iteration. */
  private pendingBoundary = false;
  private spawnUsage: CliUsage | undefined;

  public constructor(private readonly options: CliObserverBridgeOptions) {}

  /** Bare names of the omadia tools called so far, across every spawn. */
  public get calledTools(): ReadonlySet<string> {
    return this.called;
  }

  /** Open a spawn (its first iteration) and return the hooks for its `chat()`. */
  public beginSpawn(): CliChatHooks {
    this.spawnUsage = undefined;
    this.pendingBoundary = false;
    this.openIteration();
    return {
      onEvent: (event) => this.handleEvent(event),
      onUsage: (usage) => {
        this.spawnUsage = usage;
      },
    };
  }

  /** Close a spawn that completed: its last iteration ends with `end_turn`. */
  public endSpawn(): void {
    if (this.pendingBoundary) this.crossBoundary();
    const usage = this.spawnUsage;
    if (usage !== undefined) {
      const iteration = this.iteration;
      this.notify('onIterationUsage', () =>
        this.options.observer?.onIterationUsage?.({
          iteration,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
        }),
      );
    }
    this.closeIteration('end_turn');
  }

  /** The `idle` phase, on every exit path of `ask()`. */
  public finish(): void {
    const iteration = Math.max(0, this.iteration);
    this.notify('onIterationPhase', () =>
      this.options.observer?.onIterationPhase?.({ iteration, phase: 'idle' }),
    );
  }

  private handleEvent(event: ChatStreamEvent): void {
    if (event.type === 'text_delta') {
      if (this.pendingBoundary) this.crossBoundary();
      this.setPhase('streaming');
      this.textLength += event.text.length;
      if (event.text.length > 0) this.emitTokenChunk(event.text);
      return;
    }
    if (event.type === 'tool_use') {
      this.handleToolUse(event);
      return;
    }
    if (event.type === 'tool_result') {
      this.pendingBoundary = true;
      if (!this.forwardedIds.has(event.id)) return;
      const result = {
        id: event.id,
        output: event.output,
        durationMs: event.durationMs,
        // `bridgeBuilderTool` and the kernel tools signal failure with an
        // `Error:` prefix; LocalSubAgent reads it the same way.
        isError: event.isError === true || event.output.startsWith('Error:'),
      };
      this.notify('onSubToolResult', () => this.options.observer?.onSubToolResult?.(result));
    }
  }

  private handleToolUse(event: Extract<ChatStreamEvent, { type: 'tool_use' }>): void {
    if (this.pendingBoundary) this.crossBoundary();
    if (event.foreign === true || !event.name.startsWith(OMADIA_MCP_TOOL_PREFIX)) {
      this.reportForeign(event.name);
      return;
    }
    const name = event.name.slice(OMADIA_MCP_TOOL_PREFIX.length);
    this.setPhase('tool_running');
    this.toolUseCount += 1;
    this.forwardedIds.add(event.id);
    this.called.add(name);
    const use = { id: event.id, name, input: event.input };
    this.notify('onSubToolUse', () => this.options.observer?.onSubToolUse?.(use));
  }

  private reportForeign(toolName: string): void {
    const onForeign = this.options.onForeignToolUse;
    if (onForeign) {
      this.notify('onForeignToolUse', () => onForeign(toolName));
      return;
    }
    console.error(
      `[security] FOREIGN tool call "${toolName}" in CLI sub-agent "${this.options.label}" — ` +
        "this call did NOT go through omadia's loopback MCP server, so the " +
        'subscription-CLI spawn gate (OM-81) did not hold. It was dropped from the sub-agent trace.',
    );
  }

  private crossBoundary(): void {
    this.pendingBoundary = false;
    this.closeIteration('tool_use');
    this.openIteration();
  }

  private openIteration(): void {
    this.iteration += 1;
    this.toolUseCount = 0;
    this.textLength = 0;
    this.cumulativeTokens = 0;
    this.windowStart = Date.now();
    this.windowTokens = 0;
    this.tokensPerSec = 0;
    this.phase = undefined;
    const iteration = this.iteration;
    this.notify('onIteration', () => this.options.observer?.onIteration?.({ iteration }));
    this.setPhase('thinking');
  }

  private closeIteration(stopReason: string): void {
    const ev = {
      iteration: this.iteration,
      stopReason,
      toolUseCount: this.toolUseCount,
      textLength: this.textLength,
    };
    this.notify('onIterationEnd', () => this.options.observer?.onIterationEnd?.(ev));
  }

  private setPhase(phase: Phase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    const iteration = this.iteration;
    this.notify('onIterationPhase', () =>
      this.options.observer?.onIterationPhase?.({ iteration, phase }),
    );
  }

  private emitTokenChunk(text: string): void {
    const deltaTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
    this.cumulativeTokens += deltaTokens;
    this.windowTokens += deltaTokens;
    const now = Date.now();
    const windowMs = now - this.windowStart;
    if (windowMs >= TOKEN_RATE_WINDOW_MS) {
      this.tokensPerSec = (this.windowTokens / windowMs) * 1000;
      this.windowStart = now;
      this.windowTokens = 0;
    }
    const chunk = {
      iteration: this.iteration,
      deltaTokens,
      cumulativeOutputTokens: this.cumulativeTokens,
      tokensPerSec: this.tokensPerSec,
    };
    this.notify('onTokenChunk', () => this.options.observer?.onTokenChunk?.(chunk));
  }

  private notify(hook: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.warn(`[cli-sub-agent ${this.options.label}] observer.${hook} threw:`, err);
    }
  }
}
