/**
 * Observer the orchestrator can pass down to a sub-agent so its inner
 * iterations and tool calls can be streamed out to the UI. All callbacks are
 * optional — if an Askable doesn't support observability it simply ignores
 * the parameter and the orchestrator falls back to "opaque black box".
 *
 * Events are fire-and-forget — the caller buffers them and drains on its own
 * schedule. Never throw from these callbacks.
 */
export interface AskObserver {
  onIteration?(ev: { iteration: number }): void;
  onSubToolUse?(ev: { id: string; name: string; input: unknown }): void;
  onSubToolResult?(ev: {
    id: string;
    output: string;
    durationMs: number;
    isError: boolean;
  }): void;
  onIterationPhase?(ev: {
    iteration: number;
    phase: 'thinking' | 'streaming' | 'tool_running' | 'idle';
  }): void;
  onTokenChunk?(ev: {
    iteration: number;
    deltaTokens: number;
    cumulativeOutputTokens: number;
    tokensPerSec: number;
  }): void;
  onIterationUsage?(ev: {
    iteration: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }): void;
  /**
   * Fires once per iteration after the model response is in, before the
   * loop decides whether to dispatch tools or return. Carries the raw
   * `stop_reason` plus per-iteration tool-use and text-length counts so
   * higher layers (e.g. BuilderAgent) can detect "promise without
   * tool_use" patterns where the model emits text + ends the turn
   * without ever calling the tool the user asked for. The hook fires
   * for *every* iteration regardless of stop_reason — consumers filter.
   */
  onIterationEnd?(ev: {
    iteration: number;
    stopReason: string;
    toolUseCount: number;
    textLength: number;
  }): void;
}

/**
 * Any object that can answer a natural-language question. Both the local
 * sub-agents and any future remote-agent client satisfy this — the orchestrator
 * doesn't care which. `observer` is optional so remote agents without
 * introspection support remain compatible.
 */
export interface Askable {
  ask(question: string, observer?: AskObserver): Promise<string>;
}

/**
 * A domain-specific delegation tool. Each DomainTool wraps one sub-agent
 * (e.g. an accounting agent, an HR agent, a documentation agent). The orchestrator
 * exposes all configured DomainTools to Claude simultaneously and lets the
 * LLM pick by tool name + description.
 *
 * OB-77 (Palaia Phase 8): every DomainTool declares its `domain` (lowercase
 * dotted identifier — `confluence`, `odoo.hr`, `m365.calendar`). The
 * orchestrator threads it onto every emitted `ReadonlyToolTraceEntry` so
 * the Nudge-Pipeline's multi-domain trigger can count distinct domains.
 */
import type { ToolPIIField } from '@omadia/plugin-api';

export interface DomainTool {
  name: string;
  spec: DomainToolSpec;
  /** OB-77 — see `PLUGIN_DOMAIN_REGEX` for the naming convention. */
  domain: string;
  /**
   * Slice 2.5 — originating agent plugin's id (manifest `identity.id`),
   * e.g. `@omadia/agent-confluence`. Used by the orchestrator's privacy
   * bypass resolver to look up the operator-set `_privacy_mode` on the
   * agent that owns this domain tool — so `bypass` on the agent applies
   * BOTH to the domain tool itself AND to every sub-agent inner tool
   * call that runs within its dispatch.
   */
  agentId?: string;
  handle(input: unknown, observer?: AskObserver): Promise<string>;
  /**
   * Privacy-Shield v3 (stable-id tokenization, slice 1) — optional PII
   * field annotations. When present, the orchestrator's
   * `dispatchTool` runs a stable-id tokenization pass on the tool's
   * raw result JSON BEFORE serialising to string and BEFORE the
   * NER-based detectors run. Each annotated field gets a stable token
   * of the form `«<TYPE>_<id>»` where `<id>` is the value at `idPath`.
   *
   * Annotations live on the wrapper (not on `spec`) because Anthropic
   * rejects unknown fields on a tool spec and PII metadata is a
   * runtime concern of the harness, not a model-facing one.
   *
   * See `@omadia/plugin-api`'s `piiAnnotation.ts` for the full schema.
   */
  piiFields?: readonly ToolPIIField[];
}

export interface DomainToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

interface DomainToolOptions {
  /** Unique tool name, e.g. `query_odoo_accounting`. Must match tool_use.name. */
  name: string;
  /** Description Claude sees to decide when to pick this tool. */
  description: string;
  /** Wrapped sub-agent. Anything with an `ask(question)` method works. */
  agent: Askable;
  /**
   * OB-77 — Domain identifier (lowercase, dotted). Required. See
   * `PLUGIN_DOMAIN_REGEX` from `@omadia/plugin-api`. Threaded onto
   * each emitted ToolTrace entry by the orchestrator so the Phase-8
   * Nudge-Pipeline can detect multi-domain workflows.
   */
  domain: string;
  /**
   * Slice 2.5 — owning agent plugin id (manifest `identity.id`).
   * Optional for back-compat with existing callers; when present, the
   * orchestrator's privacy bypass resolver consults the operator's
   * `_privacy_mode` setting on this plugin for BOTH the domain tool
   * dispatch AND every sub-agent inner tool call within it.
   */
  agentId?: string;
}

export function createDomainTool(options: DomainToolOptions): DomainTool {
  const spec: DomainToolSpec = {
    name: options.name,
    description: options.description,
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'Natürlichsprachige Einzel-Frage für den Fach-Agenten, auf Deutsch wenn der Nutzer Deutsch geschrieben hat. Inklusive aller IDs/Namen/Zeiträume, die der Agent braucht.',
        },
      },
      required: ['question'],
    },
  };

  return {
    name: options.name,
    spec,
    domain: options.domain,
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    async handle(input: unknown, observer?: AskObserver): Promise<string> {
      if (typeof input !== 'object' || input === null) {
        return 'Error: tool input must be an object.';
      }
      const question = (input as Record<string, unknown>)['question'];
      if (typeof question !== 'string' || question.trim().length === 0) {
        return 'Error: `question` must be a non-empty string.';
      }
      const started = Date.now();
      const preview = question.replace(/\s+/g, ' ').slice(0, 140);
      // Log tag is the tool's own domain — not a hardcoded `[odoo]`, which
      // mislabelled every non-Odoo sub-agent (flight-scout, github, …).
      const logTag = `[domain:${options.domain}]`;
      console.log(`${logTag} ${options.name} → START: ${preview}`);
      try {
        const answer = await options.agent.ask(question, observer);
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`${logTag} ${options.name} → ok (${elapsed}s, ${answer.length} chars)`);
        return answer;
      } catch (err) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${logTag} ${options.name} → ERROR (${elapsed}s): ${message}`);
        return `Error while querying ${options.name}: ${message}`;
      }
    },
  };
}
