/**
 * #2301 (ADR-0268) — a CLI sub-agent inside a guarded turn works under the
 * calling turn's Privacy Shield the way the main turn does.
 *
 * Its own tools are interned by `ToolDispatchService` through the ambient
 * handle already (ADR-0195), so the sub-agent model only sees digests. Without
 * the v4 verb tools it could not filter, group or count those datasets, and its
 * tool inputs kept the prompt surrogates. Under the caller's handle the
 * sub-agent now gets:
 *
 *  - the v4 verb tools (`v4_filter`, `v4_aggregate`, …) over the same loopback
 *    server, served by the caller's handle — the datasets are the turn's;
 *  - tool inputs with the turn's prompt surrogates restored (except for tools
 *    that run on model input, which keep them) and results re-masked, as
 *    `Orchestrator.cliTurnPrivacy` does for the main turn.
 *
 * `v4_render_answer` stays with the calling turn: a render is the turn's
 * answer, and a sub-agent's answer is an input to that turn, not the answer.
 */

import type { LoopbackDispatch } from './cliMemoryTool.js';
import type { PrivacyTurnHandle } from './privacyHandle.js';
import { runsOnModelInput } from './privacyInternPolicy.js';
import {
  remaskEchoedValues,
  restorePromptSurrogatesInToolInput,
} from './promptSurrogateToolInput.js';
import type { DispatchableToolSpec } from './toolDispatchService.js';
import { V4_RENDER_TOOL_NAME } from './v4RenderSideChannel.js';

/** The directive appended to a guarded CLI sub-agent's system prompt. */
export const CALLER_PRIVACY_SUB_AGENT_DIRECTIVE = [
  '# DATENSCHUTZ (Privacy Shield)',
  'Werkzeug-Ergebnisse kommen als Datensatz-Übersicht (Digest) mit Platzhaltern statt echter Werte.',
  'Zum Filtern, Sortieren, Gruppieren, Zählen und Aggregieren nutze die `v4_*`-Werkzeuge auf der Datensatz-ID.',
  'Gib Platzhalter unverändert weiter; deine Antwort geht an den aufrufenden Agenten, der die Darstellung übernimmt.',
].join('\n');

/** The v4 verb tools a guarded sub-agent gets: all but the render tool. */
export function callerPrivacyTools(handle: PrivacyTurnHandle): readonly DispatchableToolSpec[] {
  // A provider without the v4 data plane offers nothing to add.
  if (typeof handle.v4ToolSpecs !== 'function') return [];
  return handle
    .v4ToolSpecs()
    .filter((spec) => spec.name !== V4_RENDER_TOOL_NAME)
    .map((spec) => ({
      name: spec.name,
      description: spec.description,
      input_schema: spec.input_schema as DispatchableToolSpec['input_schema'],
    }));
}

/**
 * The sub-agent's loopback dispatch under the caller's handle: `v4_*` verbs
 * served by the handle (the render tool is refused), every other call with
 * the prompt surrogates restored in its input and its result re-masked.
 */
export function withCallerPrivacyDispatch(
  handle: PrivacyTurnHandle,
  base: LoopbackDispatch,
): LoopbackDispatch {
  return {
    dispatch: async (name, toolInput, options) => {
      if (name === V4_RENDER_TOOL_NAME) {
        return {
          content: `Error: \`${V4_RENDER_TOOL_NAME}\` is not available to a sub-agent; answer in prose, the calling agent renders.`,
          isError: true,
        };
      }
      if (name.startsWith('v4_')) {
        const result = await handle.runV4Tool({ toolName: name, input: toolInput });
        return { content: result.resultText };
      }
      // #1544 — tools that run on model input (process, memory, card tools)
      // keep the surrogates, as `Orchestrator.toolKeepsSurrogates` rules for
      // the main turn: a restored value would be stored in clear.
      const restored = runsOnModelInput(name)
        ? toolInput
        : restorePromptSurrogatesInToolInput(handle, toolInput);
      const result = await base.dispatch(name, restored, options);
      return { ...result, content: remaskEchoedValues(handle, result.content) };
    },
  };
}
