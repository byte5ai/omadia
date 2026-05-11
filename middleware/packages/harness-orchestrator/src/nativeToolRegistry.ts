/**
 * Orchestrator-native tool registry.
 *
 * Mirrors the existing DomainTool hot-register pattern (registerDomainTool /
 * unregisterDomainTool on the Orchestrator) for the **second** tool class:
 * orchestrator-native tools (memory, query_knowledge_graph, render_diagram,
 * ask_user_choice, …). These are the tools the top-level Orchestrator calls
 * directly — never delegated to a sub-agent.
 *
 * v2: entries can carry `{spec, handler, promptDoc, attachmentSink}`. Two
 * registration flavors coexist during the plugin-extraction transition:
 *   - **Name-only**: `register(name)` — marker that the orchestrator's own
 *     hardcoded dispatch knows this tool (memory, knowledge_graph, …). No
 *     handler stored; the orchestrator's `if (name === X)` branch still
 *     handles dispatch, and buildSystemPrompt picks up the doc from its own
 *     hardcoded template.
 *   - **Full**: `register(name, { handler, spec, promptDoc, attachmentSink })`
 *     — contributed by a plugin. The orchestrator routes dispatch through
 *     the stored handler, appends the promptDoc (if any) to the tool-list
 *     section, and drains the attachmentSink at turn end.
 *
 * Plugins always use the full form. Kernel-internal code may still use the
 * marker form until the specific tool migrates to plugin-contributed.
 */

import type {
  NativeToolAttachmentSink,
  NativeToolHandler,
  NativeToolSpec,
} from '@omadia/plugin-api';

export interface NativeToolRegistration {
  readonly name: string;
  /** Present iff the tool was registered with a handler (plugin-contributed
   *  or kernel-refactored to full form). Absent for marker-only kernel
   *  registrations; dispatch falls through to the hardcoded branches. */
  readonly handler?: NativeToolHandler;
  /** Canonical spec for the system-prompt tool list. Required whenever
   *  handler is present. */
  readonly spec?: NativeToolSpec;
  /** Optional system-prompt doc block, spliced into the tool-list section. */
  readonly promptDoc?: string;
  /** Optional per-turn attachment collector; drained after each turn. */
  readonly attachmentSink?: NativeToolAttachmentSink;
  /**
   * OB-77 (Palaia Phase 8) — Domain bucket for Nudge-Pipeline multi-domain
   * detection. Set by the kernel at registration time: spec.domain wins
   * (per-spec override), else the plugin's manifest domain (`ctx.domain`),
   * else `unknown.<plugin-id>` fallback. Always present for full
   * registrations; absent for marker-only kernel entries (memory,
   * query_knowledge_graph etc. are meta-tools that intentionally don't
   * count toward multi-domain triggers).
   */
  readonly domain?: string;
}

export interface NativeToolRegistrationOptions {
  handler: NativeToolHandler;
  spec: NativeToolSpec;
  promptDoc?: string;
  attachmentSink?: NativeToolAttachmentSink;
  /** OB-77 — see `NativeToolRegistration.domain`. Resolved by the kernel
   *  before calling `register`. */
  domain?: string;
}

/**
 * Options for the handler-only registration path. Used by plugins that
 * ship a handler for a tool whose wire-spec the kernel emits itself — the
 * canonical case today is the Anthropic-native `memory` tool, which uses
 * `{type: 'memory_20250818', name: 'memory'}` rather than the generic
 * `{name, description, input_schema}` shape.
 */
export interface NativeToolHandlerRegistrationOptions {
  handler: NativeToolHandler;
  promptDoc?: string;
  attachmentSink?: NativeToolAttachmentSink;
}

export class NativeToolRegistry {
  private readonly entries = new Map<string, NativeToolRegistration>();

  /**
   * Marker-only registration (kernel path). Throws on duplicate.
   */
  register(name: string): () => void;
  /**
   * Full registration with handler + spec. Use from plugins or when a
   * kernel tool is refactored to self-register. Throws on duplicate.
   */
  register(name: string, options: NativeToolRegistrationOptions): () => void;
  register(
    name: string,
    options?: NativeToolRegistrationOptions,
  ): () => void {
    if (this.entries.has(name)) {
      throw new Error(
        `NativeToolRegistry: duplicate native-tool name '${name}'`,
      );
    }
    const entry: NativeToolRegistration = options
      ? {
          name,
          handler: options.handler,
          spec: options.spec,
          ...(options.promptDoc !== undefined
            ? { promptDoc: options.promptDoc }
            : {}),
          ...(options.attachmentSink
            ? { attachmentSink: options.attachmentSink }
            : {}),
          ...(options.domain !== undefined ? { domain: options.domain } : {}),
        }
      : { name };
    this.entries.set(name, entry);
    return () => {
      this.entries.delete(name);
    };
  }

  /**
   * Handler-only registration. Used for tools whose spec the kernel emits
   * itself (e.g. `memory_20250818`). The registry stores the handler,
   * promptDoc, and attachmentSink — dispatch finds the handler by name but
   * the system-prompt tool list picks up `spec` only from full registrations,
   * so this entry never contributes an `input_schema` tool. Throws on
   * duplicate.
   */
  registerHandler(
    name: string,
    options: NativeToolHandlerRegistrationOptions,
  ): () => void {
    if (this.entries.has(name)) {
      throw new Error(
        `NativeToolRegistry: duplicate native-tool name '${name}'`,
      );
    }
    const entry: NativeToolRegistration = {
      name,
      handler: options.handler,
      ...(options.promptDoc !== undefined
        ? { promptDoc: options.promptDoc }
        : {}),
      ...(options.attachmentSink
        ? { attachmentSink: options.attachmentSink }
        : {}),
    };
    this.entries.set(name, entry);
    return () => {
      this.entries.delete(name);
    };
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Name-only list — kept for API compatibility with the v1 consumer in
   *  the orchestrator's existing dispatch bookkeeping. */
  list(): readonly string[] {
    return Array.from(this.entries.keys());
  }

  /** Full entry for a given name, or undefined. */
  get(name: string): NativeToolRegistration | undefined {
    return this.entries.get(name);
  }

  /**
   * OB-77 — domain lookup for the Nudge-Pipeline ToolTrace builder. Returns
   * `undefined` for unknown names AND for marker-only kernel meta-tools
   * (memory, query_knowledge_graph, ask_user_choice, suggest_follow_ups)
   * that intentionally don't carry a domain.
   */
  getDomain(name: string): string | undefined {
    return this.entries.get(name)?.domain;
  }

  /** All entries, in registration order. */
  listEntries(): readonly NativeToolRegistration[] {
    return Array.from(this.entries.values());
  }

  /** Entries that carry a handler (registered with full options). */
  listWithHandler(): readonly NativeToolRegistration[] {
    return Array.from(this.entries.values()).filter((e) => !!e.handler);
  }
}
