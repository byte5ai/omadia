import type { LocalSubAgentTool } from '@omadia/plugin-api';

import type { SubAgentMemoryHandler } from '../turnContext.js';

/**
 * Name of the Anthropic-native memory tool. Single source of truth: the
 * orchestrator's dispatch, the tool-list assembly and the sub-agent grant
 * adapter all key on the same literal, and a sub-agent path that spelled it
 * differently would silently reopen the hole this module closes (#904).
 */
export const MEMORY_TOOL_NAME = 'memory';

/**
 * Resolves the memory handler bound to the turn currently delegating to this
 * sub-agent, or `undefined` when there is none.
 *
 * `undefined` MUST mean "refuse", never "fall back to something wider" — see
 * {@link createScopedMemorySubAgentTool}.
 */
export type SubAgentMemoryResolver = () => SubAgentMemoryHandler | undefined;

/**
 * Model-facing spec for a sub-agent's `memory` tool.
 *
 * The top-level orchestrator advertises memory as Anthropic's typed tool
 * (`{type: 'memory_20250818', name: 'memory'}`), a shape `LocalSubAgentToolSpec`
 * cannot express — it is a `{name, description, input_schema}` contract. So the
 * six commands `MemoryToolHandler` implements are spelled out here instead. The
 * HANDLER is unchanged either way: the same parser, the same store, the same
 * result strings, so a sub-agent's writes are indistinguishable from the
 * parent's once they reach storage.
 */
const SUB_AGENT_MEMORY_TOOL_SPEC: LocalSubAgentTool['spec'] = {
  name: MEMORY_TOOL_NAME,
  description:
    'Read and write the long-term memory of the agent that delegated to you. ' +
    'Paths live under /memories. Commands: view (path, optional view_range), ' +
    'create (path, file_text), str_replace (path, old_str, new_str), ' +
    'insert (path, insert_line, insert_text), delete (path), ' +
    'rename (old_path, new_path).',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
        description: 'Which memory operation to perform.',
      },
      path: { type: 'string', description: 'Target path under /memories.' },
      file_text: { type: 'string', description: 'File content for `create`.' },
      view_range: {
        type: 'array',
        items: { type: 'number' },
        description: 'Optional [start, end] line range for `view`.',
      },
      old_str: { type: 'string', description: 'Text to replace, for `str_replace`.' },
      new_str: { type: 'string', description: 'Replacement text, for `str_replace`.' },
      insert_line: { type: 'number', description: 'Line to insert after, for `insert`.' },
      insert_text: { type: 'string', description: 'Text to insert, for `insert`.' },
      old_path: { type: 'string', description: 'Source path, for `rename`.' },
      new_path: { type: 'string', description: 'Destination path, for `rename`.' },
    },
    required: ['command'],
  },
};

/** Returned verbatim to the sub-agent's model when no turn store is bound. */
export const SUB_AGENT_MEMORY_UNBOUND_ERROR =
  'Error: tool `memory` is unavailable — this delegation is not bound to a ' +
  'scoped memory store, and writing to the unscoped one is not permitted.';

/**
 * The `memory` tool a sub-agent gets when an operator grants it (#904).
 *
 * What it deliberately does NOT do is resolve `memory` out of the process-wide
 * `NativeToolRegistry`. That entry belongs to the memory PROVIDER plugin
 * (`@omadia/memory`, `@omadia/memory-postgres`) and is bound to the raw root
 * store — the one below every scoping wrapper. A sub-agent dispatching through
 * it reads and writes outside its parent agent's `orchestrator:<slug>:*`
 * subtree, and, with the chat-context ACL enabled, outside its team's and
 * channel's tiers as well.
 *
 * Instead the tool resolves the handler the PARENT's own dispatch is using for
 * the turn that is delegating right now — the turn-bound stack
 * `MemoryBinder.forOrigin` produced, or the build-time agent-scoped handler
 * when context memory is off. Sub-agent and parent therefore share one scope by
 * construction rather than by two code paths agreeing.
 *
 * **Fail closed.** With no bound handler the call is refused. This is the
 * property that makes an ambient resolver acceptable here: `DomainTool.handle`
 * takes `(input, observer)` and nothing else, so a scoped store cannot be
 * threaded in as a parameter the way #903 threaded `turnMemory` through
 * `dispatchTool`. A lost async context therefore denies the tool — it can never
 * silently widen its reach, which is the failure mode that made this a
 * vulnerability in the first place.
 */
export function createScopedMemorySubAgentTool(
  resolveTurnMemory: SubAgentMemoryResolver,
): LocalSubAgentTool {
  return {
    spec: SUB_AGENT_MEMORY_TOOL_SPEC,
    handle: async (input: unknown): Promise<string> => {
      const handler = resolveTurnMemory();
      if (handler === undefined) return SUB_AGENT_MEMORY_UNBOUND_ERROR;
      return handler.handle(input);
    },
  };
}
