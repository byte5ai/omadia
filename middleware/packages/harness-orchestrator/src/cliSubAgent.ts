import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { CliChatAgent } from './cliChatAgent.js';
import type { CliChatAgentDeps } from './cliChatAgent.js';
import { NativeToolRegistry } from './nativeToolRegistry.js';
import { ToolDispatchService } from './toolDispatchService.js';
import type { DomainTool, DomainToolSpec } from './tools/domainQueryTool.js';
import type { AskObserver, Askable } from './tools/domainQueryTool.js';

export interface CliSubAgentOptions {
  /** Sub-agent label for logs/domains, e.g. the short agent name. */
  readonly name: string;
  /** Sub-agent system prompt (skill body / composed prompt). */
  readonly systemPrompt: string;
  /** CLI model alias already stripped of any `-cli` suffix (`opus`/`sonnet`/`haiku`). */
  readonly model: string;
  /** The sub-agent's own tools, in kernel `LocalSubAgentTool` shape. */
  readonly tools: readonly LocalSubAgentTool[];
  /** Test seam: override CliChatAgent construction (inject fake spawn/loopback). */
  readonly createCliAgent?: (deps: CliChatAgentDeps) => CliChatAgent;
}

/**
 * Build an `Askable` whose `ask()` runs the sub-agent's loop through a dedicated
 * `CliChatAgent`. The official `claude` CLI owns the loop; the sub-agent's own
 * tools reach it over a fresh loopback MCP server scoped to THIS sub-agent — no
 * native kernel tools are exposed (an empty `NativeToolRegistry`). Used for
 * recursive Shape 3 (#309) so tool-using sub-agents work on the subscription
 * provider, where the in-process `LocalSubAgent` would break (its provider
 * rejects any request carrying tools).
 */
export function createCliSubAgent(options: CliSubAgentOptions): Askable {
  const dispatch = new ToolDispatchService({
    nativeTools: new NativeToolRegistry(),
    domainTools: options.tools.map((tool) => adaptSubAgentTool(tool)),
  });
  const make =
    options.createCliAgent ??
    ((deps: CliChatAgentDeps) => new CliChatAgent(deps));
  const agent = make({
    dispatch,
    model: options.model,
    systemPrompt: options.systemPrompt,
  });
  return {
    async ask(question: string, _observer?: AskObserver): Promise<string> {
      const answer = await agent.chat({ userMessage: question });
      return answer.text;
    },
  };
}

/**
 * Adapt one kernel `LocalSubAgentTool` (`{ spec, handle }`, handle returns
 * `string | LocalSubAgentToolResult`) into the `DomainTool` shape the loopback
 * dispatch serves. The dispatch contract requires a `string` result, so the
 * structured union is unwrapped to its `.output`. Each adapted tool gets a
 * stable per-tool domain so trace labelling stays unique.
 */
function adaptSubAgentTool(tool: LocalSubAgentTool): DomainTool {
  return {
    name: tool.spec.name,
    spec: {
      name: tool.spec.name,
      description: tool.spec.description,
      // LocalSubAgentToolSpec allows broader property values than DomainToolSpec.
      input_schema: tool.spec.input_schema as DomainToolSpec['input_schema'],
    },
    domain: `subagent.tool.${tool.spec.name}`,
    async handle(input: unknown): Promise<string> {
      const raw = await tool.handle(input);
      return typeof raw === 'string' ? raw : raw.output;
    },
  };
}
