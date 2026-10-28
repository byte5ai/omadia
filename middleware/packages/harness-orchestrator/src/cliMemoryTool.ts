import type {
  DispatchableToolSpec,
  ToolDispatchResult,
  ToolDispatchService,
} from './toolDispatchService.js';
import {
  MEMORY_TOOL_COMMANDS_HELP,
  MEMORY_TOOL_INPUT_SCHEMA,
  MEMORY_TOOL_NAME,
} from './registry/subAgentMemoryTool.js';
import type { SubAgentMemoryHandler } from './turnContext.js';

/** The slice of the dispatch service the loopback MCP server calls. */
export type LoopbackDispatch = Pick<ToolDispatchService, 'dispatch'>;

/**
 * #1102 — what a CLI turn's memory binding yields: the handler the in-process
 * loop would dispatch `memory` to for the same turn, and the rules the
 * in-process system prompt states for it (namespaces, the curated `_rules/`
 * tree, the context-memory tier block), which the CLI prompt must carry too.
 */
export interface CliTurnMemory {
  readonly handler: SubAgentMemoryHandler;
  readonly instructions: string;
}

/**
 * The memory conventions the in-process system prompt gives the model
 * (`buildSystemPrompt`, "Memory-Namensräume"), for the CLI. The `_rules/` line
 * matters most: that tree is shared and curated, and a write there
 * auto-promotes into durable knowledge.
 */
export const CLI_MEMORY_RULES = [
  'Memory conventions for the `memory` tool:',
  '- /memories/_rules/… holds curated rules. Read the relevant ones before answering a new domain question and follow them. Never overwrite or delete them on your own; add to them only when the user explicitly confirms.',
  '- /memories/customers/… holds stable facts about individual customers; /memories/observations/… holds dated observations.',
  '- /memories/sessions/… holds chat transcripts written by omadia, not by you. Look there only when the user refers to an earlier conversation. While the Privacy Shield is active the tool refuses this path; earlier conversations then come only through the recalled context.',
  '- Store new learnings and user preferences in topic files. Only say you saved something after the tool call succeeded.',
].join('\n');

/**
 * #1102 — the `memory` tool as the subscription CLI sees it over the loopback
 * MCP server. In-process the orchestrator advertises Anthropic's typed tool
 * (`memory_20250818`), which an MCP listing cannot express, so the commands are
 * spelled out like the sub-agent memory tool's (#904).
 */
export const CLI_MEMORY_TOOL_SPEC: DispatchableToolSpec = {
  name: MEMORY_TOOL_NAME,
  description:
    'Your long-term memory: notes that persist across chats. Use it when the ' +
    'user asks you to remember something, and to look up what you noted ' +
    'before. ' +
    MEMORY_TOOL_COMMANDS_HELP,
  input_schema: MEMORY_TOOL_INPUT_SCHEMA,
};

/**
 * #1102 — the tool list a CLI turn advertises when the orchestrator bound a
 * memory handler for it: the shared list plus {@link CLI_MEMORY_TOOL_SPEC}.
 * Any `memory` entry already in the list is replaced, so the CLI never sees
 * a second spec under that name.
 */
export function withCliMemoryTool(
  tools: readonly DispatchableToolSpec[],
): readonly DispatchableToolSpec[] {
  return [...tools.filter((tool) => tool.name !== MEMORY_TOOL_NAME), CLI_MEMORY_TOOL_SPEC].sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** Returned to the CLI when a turn without a memory binding calls `memory`. */
export const CLI_MEMORY_UNBOUND_ERROR =
  'Error: tool `memory` is unavailable in this turn — no memory store is bound to it.';

/**
 * #1102 — a per-turn dispatch that serves `memory` from the handler bound to
 * THIS turn and passes every other call to the agent's shared dispatch.
 *
 * Why not register `memory` in the shared registry: the native registry is
 * process-wide, and its `memory` entry belongs to the memory provider plugin,
 * bound to the raw root store below every scoping wrapper. Dispatch prefers a
 * native registration over everything else, so any route through the shared
 * dispatch would read and write outside this agent's tree and, with context
 * memory on, outside the chat context's tier. The handler here is the one the
 * in-process loop would use for the same turn (`MemoryBinder`), so both paths
 * write into the same scope by construction.
 */
export function turnMemoryDispatch(
  base: LoopbackDispatch,
  memory: SubAgentMemoryHandler | undefined,
): LoopbackDispatch {
  return {
    dispatch: async (name, input, options): Promise<ToolDispatchResult> => {
      if (name !== MEMORY_TOOL_NAME) return base.dispatch(name, input, options);
      // Unbound turn: refuse here as well, so the shared dispatch — whose
      // `memory` is the raw root store — is never one guard away.
      if (memory === undefined) {
        return { content: CLI_MEMORY_UNBOUND_ERROR, isError: true };
      }
      try {
        const content = await memory.handle(input);
        return { content, ...(content.startsWith('Error:') ? { isError: true } : {}) };
      } catch (error) {
        return {
          content: `Error: memory failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}
