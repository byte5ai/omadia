import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { CliChatAgent } from './cliChatAgent.js';
import type { CliChatAgentDeps } from './cliChatAgent.js';
import { OMADIA_MCP_TOOL_PREFIX } from './cliSpawnGate.js';
import { CliObserverBridge } from './cliSubAgentObserverBridge.js';
import { NativeToolRegistry } from './nativeToolRegistry.js';
import { ToolDispatchService } from './toolDispatchService.js';
import type { DomainTool, DomainToolSpec } from './tools/domainQueryTool.js';
import type { AskObserver, AskOptions, Askable } from './tools/domainQueryTool.js';

export interface CliSubAgentOptions {
  /** Sub-agent label for logs/domains, e.g. the short agent name. */
  readonly name: string;
  /** Sub-agent system prompt (skill body / composed prompt). */
  readonly systemPrompt: string;
  /** CLI model alias already stripped of any `-cli` suffix (`opus`/`sonnet`/`haiku`). */
  readonly model: string;
  /** The sub-agent's own tools, in kernel `LocalSubAgentTool` shape. */
  readonly tools: readonly LocalSubAgentTool[];
  /**
   * #1072 — called with the raw name of a tool call that did NOT go through
   * omadia's loopback MCP server (one of the CLI's own tools, OM-81). Such a
   * call is never forwarded to the observer. The app layer wires this to
   * `recordForeignToolCall` so it is counted; without it the call is logged
   * at error level.
   */
  readonly onForeignToolUse?: (toolName: string) => void;
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
 *
 * #1072 — `ask()` honours the full `Askable` contract: the observer receives
 * the turn's tool calls, token chunks, phases, iterations and usage (see
 * `CliObserverBridge`), and `options.expectedTurnToolUse` is enforced with a
 * post-turn check plus exactly one re-prompt (see `Askable`).
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
  const label = options.name;

  const runSpawn = async (bridge: CliObserverBridge, userMessage: string): Promise<string> => {
    const hooks = bridge.beginSpawn();
    const answer = await agent.chat({ userMessage }, hooks);
    bridge.endSpawn();
    return answer.text;
  };

  return {
    async ask(
      question: string,
      observer?: AskObserver,
      askOptions?: AskOptions,
    ): Promise<string> {
      const bridge = new CliObserverBridge({
        label,
        ...(observer ? { observer } : {}),
        ...(options.onForeignToolUse ? { onForeignToolUse: options.onForeignToolUse } : {}),
      });
      try {
        const first = await runSpawn(bridge, question);
        const expected = bareToolName(askOptions?.expectedTurnToolUse);
        const budget = askOptions?.maxEscalations ?? 1;
        if (expected === undefined || !(budget >= 1) || bridge.calledTools.has(expected)) {
          return first;
        }
        console.warn(
          `[cli-sub-agent ${label}] expectedTurnToolUse '${expected}' not called — re-prompting once`,
        );
        const reprompt = composeObligationReprompt(question, first, expected, [
          ...bridge.calledTools,
        ]);
        // A failing re-prompt propagates, as a failing escalation iteration
        // does in LocalSubAgent: the first answer is, by definition, the
        // "promise without delivery" the obligation exists to stop. It is
        // wrapped so the log says a first pass already completed (its tool
        // side effects remain) and which tools it ran.
        let second: string;
        try {
          second = await runSpawn(bridge, reprompt);
        } catch (err) {
          throw rePromptError(label, expected, [...bridge.calledTools], err);
        }
        if (!bridge.calledTools.has(expected)) {
          console.warn(
            `[cli-sub-agent ${label}] expectedTurnToolUse '${expected}' still not called after one re-prompt — returning the answer as is`,
          );
        }
        return second.trim().length > 0 ? second : first;
      } finally {
        bridge.finish();
      }
    },
  };
}

function rePromptError(
  label: string,
  expected: string,
  alreadyCalled: readonly string[],
  cause: unknown,
): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const ran = alreadyCalled.length > 0 ? alreadyCalled.join(', ') : 'none';
  return new Error(
    `[cli-sub-agent ${label}] re-prompt for expectedTurnToolUse '${expected}' failed after a completed first pass (tools already run: ${ran}): ${reason}`,
    { cause },
  );
}

function bareToolName(name: string | undefined): string | undefined {
  if (name === undefined || name.length === 0) return undefined;
  return name.startsWith(OMADIA_MCP_TOOL_PREFIX)
    ? name.slice(OMADIA_MCP_TOOL_PREFIX.length)
    : name;
}

/**
 * The one re-prompt for a missed `expectedTurnToolUse`. It rides the user
 * message, not `priorTurns`: the replay truncates user text to 600 chars and
 * the builder's contextual message is longer. The CLI spawn is stateless, so
 * the original question and the first answer travel with it. The second
 * spawn cannot see what the first spawn's tool calls returned, so only calls
 * that change state are off limits; read-only calls may run again when the
 * model needs their result. German like the API-path reminder in
 * `LocalSubAgent`.
 */
function composeObligationReprompt(
  question: string,
  firstAnswer: string,
  expected: string,
  alreadyCalled: readonly string[],
): string {
  const tool = `${OMADIA_MCP_TOOL_PREFIX}${expected}`;
  const lines = [
    question,
    '',
    '<vorheriger-durchlauf-antwort>',
    firstAnswer.trim().length > 0 ? firstAnswer : '(leer)',
    '</vorheriger-durchlauf-antwort>',
    '',
    `WICHTIG: Du hast den vorherigen Durchlauf beendet, ohne den erwarteten Tool-Call \`${tool}\` aufzurufen. ` +
      'Die Antwort oben wurde dem Nutzer NICHT angezeigt. ' +
      `Rufe \`${tool}\` jetzt auf, oder antworte konkret, warum das in diesem Schritt nicht möglich ist ` +
      '(z.B. fehlende Vorinformation, Spec-Frage offen).',
  ];
  if (alreadyCalled.length > 0) {
    lines.push(
      `Diese Tool-Calls liefen bereits im vorherigen Durchlauf: ${alreadyCalled
        .map((name) => `\`${OMADIA_MCP_TOOL_PREFIX}${name}\``)
        .join(', ')}. ` +
        'Ihre Ergebnisse siehst du hier nicht mehr. Lesende Calls darfst du erneut ausführen, wenn du ihr Ergebnis brauchst. ' +
        'Wiederhole keine Calls, die Zustand ändern: deren Wirkung besteht bereits.',
    );
  }
  return lines.join('\n');
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
