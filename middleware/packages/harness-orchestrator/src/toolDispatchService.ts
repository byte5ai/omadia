/**
 * M1 library code for #309 Shape-3 OpenClaw.
 *
 * This standalone dispatcher executes tools outside the Orchestrator turn loop.
 * It intentionally replicates only the native-handler and DomainTool branches
 * of `Orchestrator.dispatchToolInner`; kernel-tool branches plus privacy/trace
 * seams are deferred to M2.
 */

import type { DomainTool } from './tools/domainQueryTool.js';
import type { NativeToolRegistry } from './nativeToolRegistry.js';

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface DispatchableToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

export class ToolDispatchService {
  constructor(
    private readonly deps: {
      readonly nativeTools: NativeToolRegistry;
      /** Static sub-agent tools (M1 tests / fixed sets). */
      readonly domainTools?: readonly DomainTool[];
      /** Live sub-agent tools — read on every dispatch/list so sub-agents that
       *  attach to the orchestrator AFTER construction (the normal post-activate
       *  flow via `registerDomainTool`) are reachable. Takes precedence over the
       *  static list when present. */
      readonly domainToolsProvider?: () => readonly DomainTool[];
    },
  ) {}

  private domainTools(): readonly DomainTool[] {
    return this.deps.domainToolsProvider?.() ?? this.deps.domainTools ?? [];
  }

  async dispatch(name: string, input: unknown): Promise<ToolDispatchResult> {
    const nativeRegistration = this.deps.nativeTools.get(name);
    // Mirrors Orchestrator ordering: plugin/native handlers win first.
    if (nativeRegistration?.handler) {
      try {
        return { content: await nativeRegistration.handler(input) };
      } catch (error) {
        return { content: this.errMsg(error), isError: true };
      }
    }

    const domainTool = this.domainTools().find((t) => t.name === name);
    if (domainTool) {
      try {
        return { content: await domainTool.handle(input) };
      } catch (error) {
        return { content: this.errMsg(error), isError: true };
      }
    }

    return { content: `Error: unknown tool \`${name}\`.`, isError: true };
  }

  listDispatchableToolSpecs(): readonly DispatchableToolSpec[] {
    const advertised = new Map<string, DispatchableToolSpec>();

    for (const registration of this.deps.nativeTools.listWithHandler()) {
      if (!registration.spec) {
        // Handler-only registrations remain dispatchable by name, but cannot be
        // advertised without a stable tool spec.
        continue;
      }

      advertised.set(registration.name, {
        name: registration.spec.name,
        description: registration.spec.description,
        input_schema: registration.spec.input_schema,
      });
    }

    for (const tool of this.domainTools()) {
      // Native tools keep precedence on collisions to mirror dispatch order.
      if (advertised.has(tool.name)) {
        continue;
      }
      advertised.set(tool.name, {
        name: tool.spec.name,
        description: tool.spec.description,
        input_schema: tool.spec.input_schema,
      });
    }

    return Array.from(advertised.values());
  }

  private errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

// SEAM (M2): kernel-tool branches (knowledge_graph, chat_participants,
// ask_user_choice, suggest_follow_ups, find_free_slots, book_meeting,
// read_attachment) and scoped-memory shadowing, plus privacy interning /
// trace capture, are intentionally NOT replicated here — see
// Orchestrator.dispatchToolInner.
