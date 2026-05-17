import type Anthropic from '@anthropic-ai/sdk';
import type {
  LocalSubAgentTool,
  LocalSubAgentToolSpec,
} from '@omadia/plugin-api';
import { streamMessageWithObserver } from './streaming.js';
import type { AskObserver } from './tools/domainQueryTool.js';
import { buildDateHeader, turnContext } from './turnContext.js';

// `LocalSubAgentTool` and `LocalSubAgentToolSpec` were inlined here
// pre-S+9.3. They have moved to `@omadia/plugin-api` so plugin-side
// tool factories (e.g. `createGraphLookupTool` in `@omadia/verifier`)
// can produce values of those shapes without reaching back into kernel
// source. Re-exported for kernel-internal consumers that previously
// imported from `./localSubAgent.js`.
export type { LocalSubAgentTool, LocalSubAgentToolSpec };

interface LocalSubAgentOptions {
  /** Label used in logs — typically the domain, e.g. `odoo-hr`. */
  name: string;
  client: Anthropic;
  model: string;
  maxTokens: number;
  maxIterations: number;
  systemPrompt: string;
  tools: LocalSubAgentTool[];
}

/**
 * Per-call options for `ask()`. Threaded as the optional third argument
 * so existing callers (`subAgent.ask(question)` / `subAgent.ask(q, observer)`)
 * keep working unchanged.
 */
export interface AskOptions {
  /**
   * Name of a tool that *must* be invoked at least once during this turn.
   * If the model exits with `stop_reason !== 'tool_use'` without ever
   * having called it, the loop performs ONE escalation iteration with
   * `tool_choice: { type: 'tool', name: expectedTurnToolUse }` plus a
   * synthetic user-message reminder. Catches the OB-31 "promise without
   * delivery" pattern (model emits Build-Ankündigung text, ends turn,
   * never calls `fill_slot`). Phase-detection (when to set this) lives
   * in the calling agent — LocalSubAgent stays domain-agnostic.
   */
  expectedTurnToolUse?: string;
  /**
   * Cap on escalation iterations triggered by `expectedTurnToolUse`.
   * Default 1. Bound exists so a stubbornly mute model cannot generate
   * an infinite forced-tool-choice loop. After the budget is exhausted
   * we honor the stop_reason and return whatever text the model gave us.
   */
  maxEscalations?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContentBlock = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = any;

/**
 * A tool-loop agent that runs entirely inside this middleware process. Replaces
 * the former Anthropic-hosted Managed Agent per domain — skill stays as the
 * system prompt, tools call straight into our Odoo/Confluence code paths, and
 * the whole thing is observable in the local logs + EntityRef bus.
 *
 * Matches the old `OdooAgentClient.ask(question)` signature so the orchestrator
 * and `domainQueryTool` don't need to know whether they're talking to a
 * Managed Agent or a local sub-agent.
 */
export class LocalSubAgent {
  private readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly maxIterations: number;
  private readonly systemPrompt: string;
  private readonly toolsByName: Map<string, LocalSubAgentTool>;
  private readonly toolSpecs: LocalSubAgentToolSpec[];

  constructor(options: LocalSubAgentOptions) {
    this.name = options.name;
    this.client = options.client;
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.maxIterations = options.maxIterations;
    this.systemPrompt = options.systemPrompt;
    this.toolsByName = new Map(options.tools.map((t) => [t.spec.name, t]));
    // Prompt-cache the tool-spec list. Marking the FINAL spec with
    // `cache_control: ephemeral` tells Anthropic to cache everything up to
    // this point. The sub-agent's tool list is stable across iterations
    // within a turn, so iter 2..N skip re-ingesting the schemas server-side
    // and the model's TTFT drops noticeably.
    const baseSpecs = options.tools.map((t) => t.spec);
    if (baseSpecs.length > 0) {
      const last = baseSpecs[baseSpecs.length - 1];
      if (last) {
        baseSpecs[baseSpecs.length - 1] = {
          ...last,
           
          cache_control: { type: 'ephemeral' },
        } as unknown as typeof last;
      }
    }
    this.toolSpecs = baseSpecs;
  }

  async ask(
    question: string,
    observer?: AskObserver,
    options?: AskOptions,
  ): Promise<string> {
    const messages: Array<{
      role: 'user' | 'assistant';
      content: ContentBlock[] | string;
    }> = [{ role: 'user', content: question }];
    const textParts: string[] = [];

    // Repeat-failure detection. Tracks every tool call in the order they
    // arrive across iterations. When the last
    // REPEAT_FAILURE_THRESHOLD calls all share (toolName, canonical-input,
    // isError=true), the next iteration is forced into `tool_choice:none`
    // so the model emits a text summary instead of bleeding through
    // maxIterations re-trying the same broken call. The most common
    // trigger is a strict-mode schema rejection on patch_spec / fill_slot
    // — without this, the agent burns ~20 LLM round-trips on the same
    // payload before maxIterations stops it.
    const recentToolCalls: Array<{
      name: string;
      inputHash: string;
      isError: boolean;
    }> = [];
    let repeatFailureDetected = false;
    let lastIteration = 0;

    // OB-31: per-turn tool obligation. When the caller declares a tool
    // that *must* be invoked at least once during this turn (e.g.
    // `fill_slot` for a Build-intent BuilderAgent turn), and the model
    // would naturally exit (`stop_reason !== 'tool_use'`) without ever
    // having called it, we force one re-iteration with
    // `tool_choice: { type: 'tool', name: expectedTurnToolUse }` and a
    // synthetic user-message reminder. Bounded by `maxEscalations`
    // (default 1) so a stubbornly mute model cannot create an infinite
    // loop. Phase-detection (when to set the obligation) lives in the
    // BuilderAgent — LocalSubAgent stays domain-agnostic.
    const expectedTurnToolUse = options?.expectedTurnToolUse;
    const maxEscalations = options?.maxEscalations ?? 1;
    let calledExpectedTool = false;
    let escalationsUsed = 0;
    let forceExpectedToolNext = false;

    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        lastIteration = iteration;
        // Observer callbacks must never bubble; a buggy listener should not kill
        // the turn. Log and swallow in every branch.
        try {
          observer?.onIteration?.({ iteration });
        } catch (err) {
          console.warn(`[sub-agent ${this.name}] observer.onIteration threw:`, err);
        }

        // On the final allowed iteration, forbid further tool use. The model
        // is forced to emit a text answer from whatever it has already
        // gathered — no more Odoo/Confluence probes. Without this, long
        // multi-step queries hit the iteration cap and we threw away every
        // partial insight the agent had accumulated. See the `tool_choice`
        // docs on https://docs.anthropic.com/en/docs/agents-and-tools.
        const isLastIteration = iteration === this.maxIterations - 1;
        const forceTextOnly = isLastIteration || repeatFailureDetected;
        // OB-31: forcing the obligation tool only makes sense when we
        // *can* still dispatch tools — final iteration always wins.
        const forceExpectedTool =
          forceExpectedToolNext &&
          !forceTextOnly &&
          expectedTurnToolUse !== undefined;
        // Consume the one-shot flag so the next iteration only escalates
        // if the model *still* refuses to call the obligation tool.
        forceExpectedToolNext = false;

        let trailer = buildDateHeader(turnContext.currentTurnDate());
        if (repeatFailureDetected && !isLastIteration) {
          trailer = `${trailer}\n\nIMPORTANT: Du hast denselben Tool-Call mit identischem Input mehrfach hintereinander aufgerufen und immer denselben Fehler bekommen. Rufe diesen Tool-Call NICHT erneut auf. Fasse stattdessen zusammen, was du versucht hast, welcher Fehler aufgetreten ist und was als Nächstes nötig wäre — entweder eine andere Strategie ODER ein operatorseitiger Fix. Gib jetzt eine abschließende Antwort.`;
        } else if (isLastIteration) {
          trailer = `${trailer}\n\nIMPORTANT: Dies ist deine letzte Iteration. Du darfst KEINE weiteren Tools aufrufen. Fasse alle Zwischenergebnisse zusammen und gib eine abschließende Antwort — auch wenn die Datenlage unvollständig ist. Benenne fehlende Informationen explizit.`;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let toolChoice: any = undefined;
        if (forceTextOnly) {
          toolChoice = { type: 'none' };
        } else if (forceExpectedTool && expectedTurnToolUse) {
          toolChoice = { type: 'tool', name: expectedTurnToolUse };
        }

        const response: Message = await streamMessageWithObserver(
          this.client,
          {
            model: this.model,
            max_tokens: this.maxTokens,
            // Two-block system: stable prompt (cache-eligible) + the turn's
            // frozen date from turnContext. Falls back to a fresh date when
            // called outside any turn (tests / ad-hoc invocations).
            system: [
              {
                type: 'text',
                text: this.systemPrompt,
                cache_control: { type: 'ephemeral' },
              },
              {
                type: 'text',
                text: trailer,
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ] as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tools: this.toolSpecs as any,
            messages,
            ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
          },
          observer,
          iteration,
          `sub-agent ${this.name}`,
        );

        messages.push({ role: 'assistant', content: response.content });
        const iterationTextBlocks = collectTextBlocks(response.content);
        textParts.push(...iterationTextBlocks);

        // Iteration-end telemetry. Fires before any stop/dispatch decision
        // so consumers see every iteration's stop_reason — including the
        // pathological `end_turn` + 0 tool_use case the BuilderAgent
        // wants to trap (OB-31). Wrapped in try/catch like every other
        // observer hook: a buggy listener must not kill the turn.
        try {
          const toolUseCount = response.content.filter(
            (b: ContentBlock) => b.type === 'tool_use',
          ).length;
          const textLength = iterationTextBlocks.reduce(
            (acc: number, t: string) => acc + t.length,
            0,
          );
          const stopReasonStr = String(response.stop_reason ?? 'unknown');
          console.log(
            `[sub-agent ${this.name}] iter ${String(iteration)} → stop_reason=${stopReasonStr}, tool_use=${String(toolUseCount)}, text_len=${String(textLength)}`,
          );
          observer?.onIterationEnd?.({
            iteration,
            stopReason: stopReasonStr,
            toolUseCount,
            textLength,
          });
        } catch (err) {
          console.warn(
            `[sub-agent ${this.name}] observer.onIterationEnd threw:`,
            err,
          );
        }

        // Detect tool_use blocks in this iteration's content regardless of
        // stop_reason. The Anthropic API contract requires that any
        // assistant message with tool_use blocks be immediately followed
        // by a user message of tool_result blocks — no other shape works.
        // Most of the time stop_reason='tool_use' iff there are tool_use
        // blocks, but edge cases (`max_tokens` mid-tool-call, `pause_turn`
        // with extended thinking, partial streams) can produce tool_use
        // blocks alongside a non-`tool_use` stop_reason. Without this
        // check the OB-31 escalation below would push a synthetic user
        // reminder on top of a still-pending tool_use, and Anthropic
        // rejects the next request with `messages.N: tool_use ids were
        // found without tool_result blocks immediately after`.
        const hasPendingToolUse = response.content.some(
          (b: ContentBlock) => b.type === 'tool_use',
        );

        if (response.stop_reason !== 'tool_use' && !hasPendingToolUse) {
          // OB-31 escalation: caller declared an obligation tool, model
          // would exit without ever calling it, escalation budget unspent,
          // and we have iteration headroom. Synthesize a user-message
          // reminder + flip `tool_choice` for next iteration so the API
          // *forces* the call. After the escalation iteration we honor
          // whatever stop_reason comes back — no second-chance loop.
          if (
            expectedTurnToolUse !== undefined &&
            !calledExpectedTool &&
            escalationsUsed < maxEscalations &&
            !isLastIteration
          ) {
            escalationsUsed += 1;
            forceExpectedToolNext = true;
            messages.push({
              role: 'user',
              content:
                `Du hast den Turn beendet ohne den erwarteten Tool-Call \`${expectedTurnToolUse}\` aufzurufen. ` +
                `Rufe \`${expectedTurnToolUse}\` jetzt auf, oder antworte konkret warum das in diesem Schritt nicht möglich ist ` +
                `(z.B. fehlende Vorinformation, Spec-Frage offen).`,
            });
            console.warn(
              `[sub-agent ${this.name}] expectedTurnToolUse '${expectedTurnToolUse}' not called by iter ${String(iteration)} — escalating with tool_choice for next iteration`,
            );
            continue;
          }
          const answer = textParts.join('\n\n').trim();
          if (answer.length === 0) {
            throw new Error(`Sub-agent ${this.name} returned an empty answer.`);
          }
          return answer;
        }
        // Either stop_reason === 'tool_use' (the normal hot path) OR an
        // unusual stop_reason came back alongside pending tool_use blocks
        // (max_tokens mid-call, pause_turn, …). Both flow into the same
        // dispatch loop below so tool_results land in messages and the
        // contract holds. If it was the unusual case, the iteration that
        // follows starts with a complete (assistant-tool_use → user-
        // tool_result) pair and the loop's existing mechanisms (max
        // iterations, repeat-failure detection) bound the recovery.

        // Defensive phase emit: stream-side helper already flips to
        // 'tool_running' when it sees a tool_use content_block_start, but
        // re-emit here so subscribers that joined mid-stream still get a
        // consistent state before the dispatch loop runs.
        try {
          observer?.onIterationPhase?.({ iteration, phase: 'tool_running' });
        } catch (err) {
          console.warn(`[sub-agent ${this.name}] observer.onIterationPhase threw:`, err);
        }

        const toolUses = response.content.filter(
          (b: ContentBlock) => b.type === 'tool_use',
        );
        // OB-31: mark obligation as fulfilled the moment the expected
        // tool name appears in this iteration's tool_use blocks. Cheap
        // string check — runs once per iteration, no canonical-hash needed.
        if (
          expectedTurnToolUse !== undefined &&
          !calledExpectedTool &&
          toolUses.some(
            (b: ContentBlock) => String(b.name) === expectedTurnToolUse,
          )
        ) {
          calledExpectedTool = true;
        }
        const toolResults: ContentBlock[] = [];
        for (const use of toolUses) {
          try {
            observer?.onSubToolUse?.({
              id: String(use.id),
              name: String(use.name),
              input: use.input,
            });
          } catch (err) {
            console.warn(`[sub-agent ${this.name}] observer.onSubToolUse threw:`, err);
          }
          const started = Date.now();
          const output = await this.dispatch(use.name, use.input);
          const elapsed = Date.now() - started;
          const isError = output.startsWith('Error:');
          console.log(
            `[sub-agent ${this.name}] ${String(use.name)} ${isError ? '→ ERR' : '→ ok'} (${String(elapsed)}ms, ${String(output.length)} chars)`,
          );
          try {
            observer?.onSubToolResult?.({
              id: String(use.id),
              output,
              durationMs: elapsed,
              isError,
            });
          } catch (err) {
            console.warn(`[sub-agent ${this.name}] observer.onSubToolResult threw:`, err);
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: output,
            ...(isError ? { is_error: true } : {}),
          });
          recentToolCalls.push({
            name: String(use.name),
            inputHash: canonicalHash(use.input),
            isError,
          });
        }
        messages.push({ role: 'user', content: toolResults });

        // Detect "stuck": last N tool calls all matched on (name, input)
        // AND all errored. Trigger one early-termination round (forced
        // tool_choice:none + addendum in the system trailer) instead of
        // looping until maxIterations.
        if (recentToolCalls.length >= REPEAT_FAILURE_THRESHOLD) {
          const tail = recentToolCalls.slice(-REPEAT_FAILURE_THRESHOLD);
          const first = tail[0]!;
          const stuck = tail.every(
            (c) =>
              c.name === first.name &&
              c.inputHash === first.inputHash &&
              c.isError,
          );
          if (stuck && !repeatFailureDetected) {
            repeatFailureDetected = true;
            console.warn(
              `[sub-agent ${this.name}] repeat-failure detected on '${first.name}' (${String(REPEAT_FAILURE_THRESHOLD)}× identical-input failures) — forcing text-only on next iteration`,
            );
          }
        }
      }

      // Unreachable under normal operation: the final iteration runs with
      // `tool_choice: { type: 'none' }`, which forces Anthropic to emit a
      // non-tool-use stop_reason and we return from inside the loop. This
      // branch is a belt-and-braces fallback — if the API contract ever
      // changes, surface whatever text the agent accumulated instead of
      // throwing away every partial insight.
      const partial = textParts.join('\n\n').trim();
      if (partial.length > 0) {
        console.warn(
          `[sub-agent ${this.name}] max-iterations reached without final answer — returning partial (${String(partial.length)} chars)`,
        );
        return `[Hinweis: Sub-Agent hat das Iterationslimit erreicht — Antwort ist möglicherweise unvollständig.]\n\n${partial}`;
      }
      throw new Error(
        `Sub-agent ${this.name} exceeded maxIterations=${String(this.maxIterations)} without reaching a final answer.`,
      );
    } finally {
      // Phase 'idle' on every exit path — clean return, thrown error, or
      // max-iterations fallback. UI subscribers rely on this to clear the
      // phase pill so a follow-up turn starts from a known state.
      try {
        observer?.onIterationPhase?.({ iteration: lastIteration, phase: 'idle' });
      } catch (err) {
        console.warn(`[sub-agent ${this.name}] observer.onIterationPhase threw:`, err);
      }
    }
  }

  private async dispatch(toolName: string, input: unknown): Promise<string> {
    const tool = this.toolsByName.get(toolName);
    if (!tool) return `Error: unknown tool \`${toolName}\`.`;

    // Slice 2.2 — privacy-proxy tool roundtrip for sub-agent inner calls.
    //
    // Same contract as orchestrator.dispatchTool: restore tokens in the
    // input BEFORE the tool handler runs (so query_graph / odoo_execute
    // see the actual employee name rather than `tok_<hex>_name`), and
    // re-tokenise PII in the textual result AFTER the handler returns
    // (so the next sub-agent LLM call doesn't see fresh plaintext PII
    // it would otherwise have to be defensively cautious about).
    //
    // The privacy handle is threaded through `turnContext.privacyHandle`
    // — sub-agents inherit it from the parent orchestrator's turn scope.
    // Absent ⇒ no privacy provider installed; degrade to byte-identical
    // pre-Slice-2.2 behaviour.
    const privacy = turnContext.current()?.privacyHandle;
    let dispatchInput = input;
    if (privacy !== undefined) {
      try {
        const restored = await privacy.processToolInput({
          toolName,
          input,
        });
        dispatchInput = restored.input;
      } catch (err) {
        console.warn(
          `[sub-agent ${this.name}] privacy.processToolInput threw on '${toolName}' — proceeding with original input:`,
          err,
        );
      }
    }
    const result = await tool.handle(dispatchInput);
    // Phase C.2 — Raw tool-result capture (parallel to orchestrator.dispatchTool).
    // Sub-agent tool calls also feed routine templates, so the capture
    // hook must fire here too. Same last-write-wins semantics; absent
    // callback ⇒ no capture.
    const capture = turnContext.current()?.captureRawToolResult;
    if (capture !== undefined && typeof result === 'string') {
      try {
        capture(toolName, result);
      } catch (err) {
        console.warn(
          `[sub-agent ${this.name}] captureRawToolResult threw on '${toolName}' — continuing without capture:`,
          err,
        );
      }
    }
    if (privacy !== undefined && typeof result === 'string' && result.length > 0) {
      try {
        const tokenised = await privacy.processToolResult({
          toolName,
          text: result,
        });
        return tokenised.text;
      } catch (err) {
        console.warn(
          `[sub-agent ${this.name}] privacy.processToolResult threw on '${toolName}' — sending original result:`,
          err,
        );
      }
    }
    return result;
  }
}

function collectTextBlocks(content: ContentBlock[]): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (
      block?.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0
    ) {
      parts.push(block.text);
    }
  }
  return parts;
}

// How many consecutive identical-and-failing tool calls trigger forced
// text-only on the next iteration. 3 lets a transient hiccup self-recover
// (try → fail → tweak → succeed) while bounding the worst-case bleed.
export const REPEAT_FAILURE_THRESHOLD = 3;

/**
 * Stable string for comparing tool inputs across iterations. Recursively
 * sorts object keys so the same payload with shuffled key-order hashes
 * to the same string. Arrays preserve order (semantically meaningful).
 * Primitive scalars round-trip through JSON.stringify directly.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function canonicalHash(input: unknown): string {
  return JSON.stringify(canonicalize(input));
}
