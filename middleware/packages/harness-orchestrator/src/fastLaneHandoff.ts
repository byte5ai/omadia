import type { ChatTriageOutcome } from '@omadia/fast-path';
import type { ChatTurnInput } from '@omadia/channel-sdk';

/**
 * #2300 / ADR-0265 (supersedes ADR-0221) — what the agent gets from a call
 * the fast lane already ran before its miss.
 *
 * The call travels as `ChatTurnInput.fastLaneCall`. The orchestrator replays
 * it as the turn's first tool round — the call as a `tool_use`, its output as
 * the `tool_result` — through the ordinary dispatch path
 * (`Orchestrator.dispatchTool` with the output preset): the Privacy Shield
 * interns it like any result of that tool, the replay ledger records it, and
 * the run trace lists it, so the answer verifier counts it as evidence. Raw
 * tool output never enters a system block.
 *
 * The note below is kernel-authored and data-free (tool name and miss reason
 * only): it follows the tool result in the user role so the agent knows the
 * call is not to be repeated.
 */

type ExecutedCall = NonNullable<Extract<ChatTriageOutcome, { kind: 'agent' }>['executed']>;
export type FastLaneCall = NonNullable<ChatTurnInput['fastLaneCall']>;

/** Output beyond this is cut; the agent can still call the tool for more. */
export const FAST_LANE_HANDOFF_MAX_OUTPUT_CHARS = 12_000;

/** The carrier for the agent turn, from the fast lane's executed call. */
export function fastLaneCallOf(executed: ExecutedCall & { rows?: number }, reason: string): FastLaneCall {
  const cut = executed.output.length > FAST_LANE_HANDOFF_MAX_OUTPUT_CHARS;
  return {
    tool: executed.tool,
    input: executed.input,
    output: cut ? executed.output.slice(0, FAST_LANE_HANDOFF_MAX_OUTPUT_CHARS) : executed.output,
    reason,
    ...(executed.rows !== undefined ? { rows: executed.rows } : {}),
    ...(cut ? { truncated: true } : {}),
  };
}

/** The data-free note that follows the replayed tool result. */
export function fastLaneToolResultNote(call: FastLaneCall): string {
  const head = `[Kernel-Hinweis] Das Werkzeug-Ergebnis oben stammt aus der Schnellspur: \`${call.tool}\` lief vor diesem Turn bereits (Grund, warum daraus keine fertige Antwort wurde: ${call.reason}).`;
  if (call.rows === 0) {
    return `${head} Es lieferte keine Datensätze. Rufe es nicht mit derselben Eingabe erneut auf; sag das dem Nutzer oder frage mit anderer Eingabe nach.`;
  }
  if (call.reason === 'tool-error') {
    return `${head} Das Werkzeug meldete einen Fehler. Ein erneuter Aufruf mit angepasster Eingabe ist erlaubt, wenn der Fehler das nahelegt.`;
  }
  return (
    `${head} Rufe dasselbe Werkzeug nicht mit derselben Eingabe erneut auf; arbeite mit diesem Ergebnis` +
    (call.truncated === true ? ' (gekürzt — für den Rest rufe das Werkzeug mit eingeschränkter Eingabe auf)' : '') +
    '.'
  );
}

/**
 * For an agent that cannot take a replayed tool round (the subscription CLI
 * path): a data-free hint. The output stays out of the system text; the agent
 * calls the tool itself if it needs the data.
 */
export function fastLaneCliHint(call: FastLaneCall): string {
  if (call.rows === 0) {
    return `Vor diesem Turn lief \`${call.tool}\` bereits (Schnellspur) und lieferte keine Datensätze. Rufe es nicht mit derselben Eingabe erneut auf.`;
  }
  return `Vor diesem Turn lief \`${call.tool}\` bereits (Schnellspur, Grund: ${call.reason}); das Ergebnis liegt dir hier nicht vor. Brauchst du die Daten, rufe das Werkzeug selbst auf.`;
}
