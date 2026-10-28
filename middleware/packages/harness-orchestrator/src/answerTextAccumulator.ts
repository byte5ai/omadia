/**
 * #1500 — collects the turn's answer text across tool-loop iterations and
 * keeps preamble out of it.
 *
 * Text the model writes next to a tool call BEFORE any work result arrived
 * ("I'll check my memory directory first.", "Ich frage Odoo ab.") cannot be
 * an answer yet — the model has no data. It is held back as provisional and
 * dropped as soon as a later iteration writes text of its own. Text written
 * once a work tool returned — an answer next to `suggest_follow_ups`, an
 * analysis next to `create_xlsx` — is answer text and is joined as before.
 *
 * An iteration only counts as preamble when every call it makes gathers
 * data (`memory` or a work tool). Text next to `suggest_follow_ups`,
 * `ask_user_choice` or `v4_render_answer` is attached to an answer, never a
 * preamble.
 *
 * When no later text arrives (the final message is empty, or a choice card
 * ends the turn), the provisional text is all there is and is delivered.
 */

import { MEMORY_TOOL_NAME } from './registry/subAgentMemoryTool.js';
import { isBookkeepingTool } from './toolCallOutcome.js';

export class AnswerTextAccumulator {
  private kept: string[] = [];
  private provisional: string[] = [];
  private workResultSeen = false;

  /** Record one model iteration: its text blocks and the tools it called. */
  addIteration(text: readonly string[], toolNames: readonly string[]): void {
    const gathersData =
      toolNames.length > 0 &&
      toolNames.every((n) => n === MEMORY_TOOL_NAME || !isBookkeepingTool(n));
    if (text.length > 0) {
      if (gathersData && !this.workResultSeen) {
        this.provisional = [...this.provisional, ...text];
      } else {
        this.kept = [...this.kept, ...text];
        this.provisional = [];
      }
    }
    if (toolNames.some((n) => !isBookkeepingTool(n))) this.workResultSeen = true;
  }

  /** The answer parts collected so far. */
  parts(): string[] {
    return this.kept.length > 0 ? [...this.kept] : [...this.provisional];
  }

  /** Drop all text (a forced retry starts the answer over). */
  reset(): void {
    this.kept = [];
    this.provisional = [];
  }
}
