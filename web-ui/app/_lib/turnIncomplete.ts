/**
 * #1094 — a DEGRADED turn: one where a tool call already committed a real side
 * effect and a LATER step of the same turn threw. The orchestrator must still
 * report `done` (reporting `error` would make the next turn re-invoke the
 * committed tool — the #506 guarantee), but it no longer fakes an answer. It
 * emits a neutral, language-free marker instead:
 *
 *   <turn-incomplete tools="memory,query_dataset" ref="<turnId>"></turn-incomplete>
 *
 * (produced by `turnIncompleteMarker` in
 * `middleware/packages/harness-orchestrator/src/orchestrator.ts` — the shape is
 * duplicated here because the web UI does not import middleware packages, the
 * same way the `<mcp-auth-required>` block is.)
 *
 * The marker never reaches the screen: this parser lifts it out of the answer
 * so the bubble can render a LOCALIZED warning (the old behavior was a
 * hardcoded English sentence shown in normal answer styling, in a German UI).
 * The streaming `done` event also carries `degraded` / `committedTools` /
 * `correlationId` as first-class fields; this parser is what covers the paths
 * where only the persisted answer text survives — a reloaded session restored
 * from the server-side mirror.
 */
export interface TurnIncomplete {
  /** Distinct tool names that committed before the throw, in commit order.
   *  Not a call count — the orchestrator deduplicates by name. */
  committedTools: string[];
  /** The turn's correlation token, matching the `[orchestrator] turn failed
   *  (correlationId=…)` server log line. Absent on older middleware. */
  correlationId?: string;
  /** The answer text with the marker removed — what the user should read. */
  cleaned: string;
}

// Anchored at the START of the text on purpose: the orchestrator always emits
// the marker as the whole answer (the AI-Act disclosure line is folded on
// AFTER it). An unanchored match would misread a healthy answer that merely
// mentions the tag — e.g. a turn explaining what `<turn-incomplete>` means —
// as a degraded turn, and would silently delete that span from the bubble.
const BLOCK_REGEX = /^\s*<turn-incomplete\b([^>]*?)\/?>(?:<\/turn-incomplete>)?/;
const TOOLS_ATTR = /\btools="([^"]*)"/;
const REF_ATTR = /\bref="([^"]*)"/;

/** Extract the `<turn-incomplete>` marker from an answer. Returns `null` when
 *  the text carries no marker — the ordinary case for every healthy turn. */
export function parseTurnIncomplete(text: string): TurnIncomplete | null {
  if (!text.trimStart().startsWith('<turn-incomplete')) return null;
  const block = BLOCK_REGEX.exec(text);
  if (!block) return null;

  const attrs = block[1] ?? '';
  const tools = (TOOLS_ATTR.exec(attrs)?.[1] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const ref = REF_ATTR.exec(attrs)?.[1]?.trim();
  const cleaned = text.replace(BLOCK_REGEX, '').trim();

  return {
    committedTools: tools,
    ...(ref ? { correlationId: ref } : {}),
    cleaned,
  };
}
