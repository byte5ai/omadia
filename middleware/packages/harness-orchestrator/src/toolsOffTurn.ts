import type { ChatTurnInput } from '@omadia/channel-sdk';

/**
 * #2217 — a tool-less turn (`ChatTurnInput.toolsOff`). The model gets no tool
 * definitions and answers in prose only. The Conductor's draft preview uses it
 * to run an agent step as the real agent (prompt, model, persona, verifier)
 * without letting the rehearsal touch a connector, write memory or call a
 * sub-agent (ADR 0043).
 *
 * Shared by both tool loops, so the streaming and the buffered path cannot
 * drift apart on what "off" means.
 */

/** Per-turn system directive for a tool-less turn. Static prose, no user data:
 *  it joins the unmasked per-turn hint blocks like the fresh-check notice. */
export const TOOLS_OFF_DIRECTIVE = `# TURN OHNE WERKZEUGE

In diesem Turn stehen dir keine Werkzeuge zur Verfügung: kein Fach-Werkzeug, kein \`memory\`, keine Sub-Agents. Kündige keine Werkzeug-Aufrufe an und beschreibe keine geplanten Abfragen. Antworte direkt mit dem, was in der Nachricht und im mitgegebenen Kontext steht. Wenn die Antwort Daten bräuchte, die du nur über ein Werkzeug bekämst, sag das in einem Satz und antworte so gut es ohne sie geht. Halte dich an das verlangte Antwortformat (z. B. einen \`\`\`json-Block), wenn die Aufgabe eines vorgibt.`;

/** Thrown when a model answers a tool-less turn with a tool call anyway. The
 *  call is never dispatched: a turn that promised no side effects keeps that
 *  promise even when a provider ignores an empty tool list. */
export class ToolsOffViolationError extends Error {
  constructor(readonly toolNames: readonly string[]) {
    super(
      `the model called ${toolNames.map((n) => `'${n}'`).join(', ')} in a turn that runs without tools; ` +
        'the call was not dispatched',
    );
    this.name = 'ToolsOffViolationError';
  }
}

export function isToolsOffTurn(input: Pick<ChatTurnInput, 'toolsOff'>): boolean {
  return input.toolsOff === true;
}

/** The tool list one request of a turn sends: none in a tool-less turn. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolsForTurn(input: Pick<ChatTurnInput, 'toolsOff'>, build: () => any[]): any[] {
  return isToolsOffTurn(input) ? [] : build();
}

/** Refuse, before dispatch, every tool call a model emitted in a tool-less turn. */
export function assertNoToolUseInToolsOffTurn(
  input: Pick<ChatTurnInput, 'toolsOff'>,
  toolUses: ReadonlyArray<{ name?: unknown }>,
): void {
  if (!isToolsOffTurn(input) || toolUses.length === 0) return;
  throw new ToolsOffViolationError(
    toolUses.map((u) => (typeof u.name === 'string' ? u.name : '?')),
  );
}
