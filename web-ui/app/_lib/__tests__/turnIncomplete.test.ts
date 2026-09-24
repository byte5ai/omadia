import { describe, expect, it } from 'vitest';

import { parseTurnIncomplete } from '../turnIncomplete';

/**
 * #1094 — a turn that throws after a tool already committed used to arrive as
 * an English pseudo-success ("The requested action (memory) completed
 * successfully, …") rendered in normal answer styling. The orchestrator now
 * sends a neutral, language-free marker instead; this parser is what turns it
 * back into something the UI can render a LOCALIZED warning from.
 *
 * The marker must never reach the screen — these assert on the absence of the
 * machine text in `cleaned`, not merely on the presence of the parsed fields.
 */

/** The exact shape `turnIncompleteMarker` emits in the orchestrator. */
const MARKER =
  '<turn-incomplete tools="memory,query_dataset" ref="0f8f1a2b-1111-4222-8333-444455556666"></turn-incomplete>';

describe('parseTurnIncomplete', () => {
  it('returns null for an ordinary answer', () => {
    expect(parseTurnIncomplete('Hier sind deine Termine für morgen.')).toBeNull();
  });

  it('extracts the committed tools and the support token', () => {
    const parsed = parseTurnIncomplete(MARKER);
    expect(parsed).not.toBeNull();
    expect(parsed?.committedTools).toEqual(['memory', 'query_dataset']);
    expect(parsed?.correlationId).toBe('0f8f1a2b-1111-4222-8333-444455556666');
  });

  it('strips the marker from the text the user sees', () => {
    // The AI-Act disclosure line is folded onto the answer at the delivery
    // boundary (#644), so the marker is never alone in the string.
    const parsed = parseTurnIncomplete(
      `${MARKER}\n\nDiese Antwort wurde von einem KI-System erzeugt.`,
    );
    expect(parsed?.cleaned).toBe('Diese Antwort wurde von einem KI-System erzeugt.');
    expect(parsed?.cleaned).not.toContain('turn-incomplete');
    expect(parsed?.cleaned).not.toContain('tools=');
  });

  it('parses a marker without a correlation token', () => {
    // `currentTurnId()` can be absent; the marker then carries no `ref`.
    const parsed = parseTurnIncomplete('<turn-incomplete tools="memory"></turn-incomplete>');
    expect(parsed?.committedTools).toEqual(['memory']);
    expect(parsed?.correlationId).toBeUndefined();
    expect(parsed?.cleaned).toBe('');
  });

  it('parses a marker with no committed tools rather than returning null', () => {
    // Defensive: a degraded turn is still degraded even if the tool list is
    // empty — dropping the warning would put the user back in #1094.
    const parsed = parseTurnIncomplete('<turn-incomplete tools=""></turn-incomplete>');
    expect(parsed).not.toBeNull();
    expect(parsed?.committedTools).toEqual([]);
  });

  it('ignores a marker that is not the machine block', () => {
    expect(parseTurnIncomplete('we discussed <turn-incompleteness> yesterday')).toBeNull();
  });
});
