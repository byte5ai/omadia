/**
 * Scripted orchestrator turns for the `enforce` stream tests: live telemetry
 * interleaved with content that states the figure the fixture verdicts are
 * about (`AMOUNT_TEXT`), ending in a `done`. Shared by the stream suites so
 * they assert against one script.
 */

import type { RevisionId } from '../../packages/harness-channel-sdk/src/surface.js';
import type { ChatStreamEvent } from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { AMOUNT_TEXT } from './verifierVerdictFixtures.js';

export type DoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;

export const ANSWER = `Der Umsatz im dritten Quartal beträgt ${AMOUNT_TEXT}.`;

/** Events in {@link turn} that reach the consumer while the verdict is
 *  pending. `sub_iteration` is held with its parent `tool_use`. */
export const LIVE_TYPES: ReadonlySet<string> = new Set([
  'iteration_start',
  'turn_routing',
  'tool_progress',
  'iteration_usage',
]);

export const DISCLOSURE = {
  text: 'Diese Antwort wurde von einem KI-System erzeugt.',
  level: 'standard' as const,
  locale: 'de',
  source: 'operator' as const,
  operatorNote: 'Bei Fragen: Support-Team.',
};

/** The block the orchestrator folds into a first turn's `done.answer`. */
export const DISCLOSURE_BLOCK = `${DISCLOSURE.text}\n\n${DISCLOSURE.operatorNote}`;

export function done(extra: Partial<DoneEvent> = {}, answer = ANSWER): DoneEvent {
  return { type: 'done', answer, toolCalls: 1, iterations: 1, ...extra };
}

/** A full turn: live telemetry interleaved with content that states the
 *  figure the verdict is about. */
export function turn(terminal: DoneEvent = done()): ChatStreamEvent[] {
  return [
    { type: 'iteration_start', iteration: 1 },
    { type: 'turn_routing', bucket: 'complex', classifierModel: 'class:fast', model: 'class:smart' },
    { type: 'tool_use', id: 't1', name: 'query_odoo_accounting', input: { question: 'Umsatz Q3' } },
    { type: 'tool_progress', id: 't1', elapsedMs: 5000 },
    { type: 'sub_iteration', parentId: 't1', iteration: 1 },
    { type: 'sub_tool_use', parentId: 't1', id: 's1', name: 'odoo_execute', input: { model: 'account.move' } },
    { type: 'sub_tool_result', parentId: 't1', id: 's1', output: `amount_total ${AMOUNT_TEXT}`, durationMs: 40, isError: false },
    { type: 'tool_result', id: 't1', output: `Umsatz Q3: ${AMOUNT_TEXT}`, durationMs: 900 },
    { type: 'nudge', id: 't1', nudgeId: 'n1', text: `${AMOUNT_TEXT} als Notiz speichern?` },
    {
      type: 'iteration_usage',
      iteration: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    { type: 'turn_annotation', channel: 'kg_insert', payload: { nodes: [{ id: 'k1', label: AMOUNT_TEXT }] } },
    {
      type: 'surface_snapshot',
      canvasSessionId: 'canvas-1',
      surfaceSeq: 1,
      producesRevision: '1' as RevisionId,
      tree: { type: 'text', content: AMOUNT_TEXT },
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
    },
    { type: 'text_delta', text: 'Der Umsatz im dritten Quartal ' },
    { type: 'text_delta', text: `beträgt ${AMOUNT_TEXT}.` },
    terminal,
  ];
}

/**
 * What a client receives of `script` when `enforce` releases it with the
 * terminal `released` (`terminal` plus whatever the release adds): the live
 * events as they came, then the held events in order without their text
 * deltas, the text of `answerText` as one delta, and the terminal.
 */
export function releasedAs(
  script: readonly ChatStreamEvent[],
  released: DoneEvent,
  answerText = released.answer,
): ChatStreamEvent[] {
  const live = script.filter((e) => LIVE_TYPES.has(e.type));
  const held = script.filter(
    (e) => !LIVE_TYPES.has(e.type) && e.type !== 'text_delta' && e.type !== 'done',
  );
  return [
    ...live,
    ...held,
    ...(answerText.length > 0 ? [{ type: 'text_delta' as const, text: answerText }] : []),
    released,
  ];
}

export const doneOf = (events: readonly ChatStreamEvent[]): DoneEvent | undefined =>
  events.find((e): e is DoneEvent => e.type === 'done');

export const deltasOf = (events: readonly ChatStreamEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : []));
