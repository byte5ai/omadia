import { randomUUID } from 'node:crypto';

import { type PluginContext } from '@omadia/plugin-api';
import { type ChatStreamEvent, type ChatTurnInput, type RevisionId } from '@omadia/channel-sdk';

import {
  CANVAS_CHOICE_TOOL,
  CANVAS_LUMEN_TOOL,
  CANVAS_PUBLISH_TOOL,
  V4_RENDER_TOOL,
} from './canvasPublishHandlers.js';
import { CANVAS_PROTOCOL_VERSION, OPS_CATALOG_VERSION } from './canvasProtocol.js';
import { type CanvasRuntime } from './canvasRuntime.js';
import { deriveDataRequirements } from './dataRequirements.js';
import { synthesizeSurfaceEvents } from './surfaceSynthesis.js';

/** This plugin's own canvas tools — always runnable on its own canvas. */
const OWN_CANVAS_TOOLS: ReadonlySet<string> = new Set([
  CANVAS_PUBLISH_TOOL,
  CANVAS_CHOICE_TOOL,
  CANVAS_LUMEN_TOOL,
  V4_RENDER_TOOL,
]);

/** The kernel's invoke-one-agent-tool-by-id service (`agentToolInvoker`). */
interface AgentToolInvoker {
  invoke(toolId: string, input: unknown): Promise<string | undefined>;
  hasStream?(toolId: string): boolean;
  invokeStream?(toolId: string, input: unknown): AsyncGenerator<string>;
}

/** ── Deterministic action (LLM-free) ────────────────────────────────────
 *  The structured action names a tool whose result is FULLY plugin-determined
 *  (a saved-page recall, a status flip, a list view). There is nothing for the
 *  model to decide: invoke the tool DIRECTLY with the action payload and feed
 *  its sentinel through the SAME synthesis pipeline the agent path uses — no
 *  skeleton, no model turn, instant. Deny-by-default: the tool must be in the
 *  deterministic-action allow-set AND remain canvas-output-authorised for its
 *  sentinel to resolve. Any miss (undefined) falls through to the
 *  in-place/agent paths.
 *
 *  Two invocation sources, tried in order: (1) the native tool registry
 *  (integrations + the orchestrator's own producer tools), then (2) the
 *  `agentToolInvoker` service — the kernel's invoke-one-agent-tool-by-id
 *  path, so AGENT-plugin tools (which live behind a `query_<domain>`
 *  sub-agent, not in the native registry) are reachable LLM-free too. */
export function deterministicActionStream(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  canvasSessionId: string,
  /** #1598 — the tools the canvas's orchestrator offers (`ChatAgent
   *  .offeredToolNames`); a NATIVE tool runs here only when it is in it (or is
   *  this plugin's own canvas tool). Agent-plugin tools are checked by the
   *  kernel's `agentToolInvoker`. */
  permitted?: ReadonlySet<string>,
): AsyncGenerator<ChatStreamEvent> | undefined {
  const { ctx, toolsAccessor, deterministicActionTools } = rt;
  const directActionTool =
    input.action && typeof (input.action as { type?: unknown }).type === 'string'
      ? ((input.action as { type: string }).type)
      : undefined;
  // #1598 — `ctx.tools.invoke` knows no orchestrator: only a tool the canvas's
  // orchestrator is offered (plugin assigned + ready), or our own canvas tool.
  const nativeAllowed =
    directActionTool !== undefined &&
    (OWN_CANVAS_TOOLS.has(directActionTool) || permitted?.has(directActionTool) === true);
  const directInvoke = nativeAllowed ? toolsAccessor?.invoke?.bind(toolsAccessor) : undefined;
  const agentToolInvoker = ctx.services?.get<AgentToolInvoker>('agentToolInvoker');
  const directInvokeStream = agentToolInvoker?.invokeStream?.bind(agentToolInvoker);
  // Streaming deterministic action: an AGENT-plugin tool may emit several
  // sentinel-bearing results during ONE dispatch (progress snapshot →
  // patches → final snapshot). Decide synchronously up-front; when no stream
  // exists, the legacy one-shot directEvents generator below is reused
  // verbatim.
  const hasDirectStream =
    directActionTool !== undefined &&
    deterministicActionTools.has(directActionTool) &&
    agentToolInvoker?.hasStream?.(directActionTool) === true &&
    directInvokeStream !== undefined;
  if (hasDirectStream && directActionTool && directInvokeStream) {
    const directPayload =
      (input.action as { payload?: unknown }).payload ?? {};
    return synthesizeDirectAction(
      rt,
      input,
      canvasSessionId,
      streamedDirectEvents(ctx, directActionTool, directPayload, directInvokeStream),
    );
  }
  if (
    directActionTool &&
    deterministicActionTools.has(directActionTool) &&
    (directInvoke || agentToolInvoker)
  ) {
    const directPayload =
      (input.action as { payload?: unknown }).payload ?? {};
    // native registry first, then the agent-plugin invoker — the first source
    // that yields a result wins. Throws only when neither can resolve the id.
    const resolveDirect = async (): Promise<string> => {
      if (directInvoke) {
        try {
          const raw = await directInvoke(directActionTool, directPayload);
          return typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (nativeErr) {
          if (!agentToolInvoker) throw nativeErr;
          // native miss (unknown/handler-less) → try the agent-plugin tool
        }
      }
      const viaAgent = await agentToolInvoker?.invoke(directActionTool, directPayload);
      if (viaAgent !== undefined) return viaAgent;
      throw new Error(
        `deterministic-action: '${directActionTool}' not resolvable ` +
          `(native registry miss and no agent-plugin tool of that id)`,
      );
    };
    return synthesizeDirectAction(
      rt,
      input,
      canvasSessionId,
      oneShotDirectEvents(ctx, directActionTool, directPayload, resolveDirect),
    );
  }
  return undefined;
}

/** The direct dispatch's synthetic tool events through the agent path's
 *  synthesis pipeline, on top of the client's tree when it sent one. */
function synthesizeDirectAction(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  canvasSessionId: string,
  directEvents: AsyncGenerator<ChatStreamEvent>,
): AsyncGenerator<ChatStreamEvent> {
  const { ctx, canvasOutputTools, captureSource, deriveSource, registerVariants } = rt;
  const baseRevision = (input.canvasState?.basedOnRevision ?? '0') as RevisionId;
  const baseTree = input.canvasState?.currentTree;
  return synthesizeSurfaceEvents(directEvents, {
    canvasSessionId,
    authorizedToolNames: canvasOutputTools,
    protocolVersion: CANVAS_PROTOCOL_VERSION,
    opsCatalogVersion: OPS_CATALOG_VERSION,
    startSurfaceSeq: 0,
    baseRevision,
    baseTree,
    dataRequirements: baseTree ? deriveDataRequirements(baseTree) : [],
    onPublishedSource: captureSource(canvasSessionId),
    deriveSource,
    onPublishedActions: registerVariants(canvasSessionId),
    log: (message) => ctx.log(message),
  });
}

/** Streaming dispatch: one tool_use/tool_result pair per streamed chunk; a
 *  throw becomes one `{ ok: false }` result. */
async function* streamedDirectEvents(
  ctx: PluginContext,
  directActionTool: string,
  directPayload: unknown,
  directInvokeStream: (toolId: string, input: unknown) => AsyncGenerator<string>,
): AsyncGenerator<ChatStreamEvent> {
  let streamedChunks = 0;
  const t0 = Date.now();
  try {
    for await (const output of directInvokeStream(directActionTool, directPayload)) {
      streamedChunks += 1;
      const id = randomUUID();
      yield { type: 'tool_use', id, name: directActionTool, input: directPayload };
      yield { type: 'tool_result', id, output, durationMs: 0 };
    }
    ctx.log(
      `[deterministic-action] ${directActionTool} STREAMED ${streamedChunks} chunks ` +
        `LLM-free in ${Date.now() - t0}ms (no model turn)`,
    );
  } catch (err) {
    const id = randomUUID();
    const output = JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    ctx.log(
      `[deterministic-action] ${directActionTool} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    yield { type: 'tool_use', id, name: directActionTool, input: directPayload };
    yield { type: 'tool_result', id, output, durationMs: 0 };
  }
}

/** One-shot dispatch: a single tool_use/tool_result pair; a throw becomes a
 *  `{ ok: false }` result. */
async function* oneShotDirectEvents(
  ctx: PluginContext,
  directActionTool: string,
  directPayload: unknown,
  resolveDirect: () => Promise<string>,
): AsyncGenerator<ChatStreamEvent> {
  const id = randomUUID();
  yield { type: 'tool_use', id, name: directActionTool, input: directPayload };
  let output: string;
  try {
    const t0 = Date.now();
    output = await resolveDirect();
    ctx.log(
      `[deterministic-action] ${directActionTool} dispatched LLM-free in ` +
        `${Date.now() - t0}ms (no model turn)`,
    );
  } catch (err) {
    output = JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    ctx.log(
      `[deterministic-action] ${directActionTool} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  yield { type: 'tool_result', id, output, durationMs: 0 };
}
