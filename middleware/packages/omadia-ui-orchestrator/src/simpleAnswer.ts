import type { ChatStreamEvent, RevisionId } from '@omadia/channel-sdk';

import { simpleTree } from './decisionCanvas.js';

/** A simple answer is a sentence or two; a longer one is cut for the view. */
const MAX_ANSWER = 2000;

/**
 * The simple view (`decisionCanvas.ts` `simpleSkeleton`) filled with the
 * agent's answer. Canvas prose is otherwise debug-only, so without this a
 * greeting would leave the loading text on screen. Right before `done`, and
 * only when the turn published nothing onto the canvas itself, a
 * `surface_snapshot` puts the answer in place of the loading text.
 * Seq/revision continue after the last surface event seen.
 */
export async function* fillSimpleAnswer(
  turn: AsyncIterable<ChatStreamEvent>,
  opts: {
    question: string;
    canvasSessionId: string;
    protocolVersion: string;
    opsCatalogVersion: string;
    lastSurfaceSeq: number;
    lastRevision: RevisionId;
  },
): AsyncGenerator<ChatStreamEvent> {
  let seq = opts.lastSurfaceSeq;
  let revision = Number(opts.lastRevision);
  let published = false;
  let prose = '';
  for await (const event of turn) {
    if (event.type === 'surface_snapshot' || event.type === 'surface_patch') {
      published = true;
      seq = Math.max(seq, event.surfaceSeq);
      revision = Math.max(revision, Number(event.producesRevision));
    } else if (event.type.startsWith('surface_')) {
      seq = Math.max(seq, (event as { surfaceSeq: number }).surfaceSeq);
    } else if (event.type === 'text_delta') {
      prose += event.text;
    }
    if (event.type === 'done' && !published && event.answerSource !== 'verifier-blocked') {
      const text = (event.answer.trim().length > 0 ? event.answer : prose).trim().slice(0, MAX_ANSWER);
      if (text.length > 0) {
        yield {
          type: 'surface_snapshot',
          canvasSessionId: opts.canvasSessionId,
          surfaceSeq: ++seq,
          producesRevision: String(++revision) as RevisionId,
          tree: simpleTree(opts.question, { text }),
          protocolVersion: opts.protocolVersion,
          opsCatalogVersion: opts.opsCatalogVersion,
        };
      }
    }
    yield event;
  }
}
