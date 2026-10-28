import type { ChatStreamEvent, RevisionId } from '@omadia/channel-sdk';

/**
 * The canvas skeleton on a base that holds content until the verdict
 * (`ChatAgent.holdsContentUntilVerdict`: the answer verifier in `enforce`
 * mode).
 *
 * The skeleton goes out IMMEDIATELY, before the main turn runs: it is built
 * from the user's request only (the composer is told to name what is shown,
 * never figures), and the verifier never judges it — holding it bought no
 * safety and cost the whole verification wait as a blank canvas. What the
 * verdict still gates is everything the TURN produces: the base holds its
 * text and the tool results the surface patches are synthesised from, so
 * those arrive with the release exactly as before.
 *
 * A turn the base withholds (`done.answerSource: 'verifier-blocked'`) or that
 * fails (`error`) must not leave the skeleton's loading placeholders on the
 * canvas: {@link replaceSkeletonOnWithheld} puts a status tree in its place
 * right before that terminal event.
 */

const FAILED_TEXT = 'The request could not be completed.';
const WITHHELD_TEXT = 'The answer was withheld.';

/** The tree that replaces the skeleton of a withheld/failed turn. Valid
 *  against canvas-core's canvas-tree schema (pinned by test). */
export function withheldTree(kind: 'withheld' | 'failed', text?: string): unknown {
  const fallback = kind === 'withheld' ? WITHHELD_TEXT : FAILED_TEXT;
  return {
    type: 'container',
    id: 'root',
    layout: 'stack',
    children: [
      {
        type: 'status',
        id: 'st',
        text: text !== undefined && text.trim().length > 0 ? text.trim() : fallback,
        tone: kind === 'withheld' ? 'warning' : 'danger',
      },
    ],
  };
}

/**
 * Pass the (already skeleton-led) turn through unchanged; on a withheld or
 * failed terminal, first emit a `surface_snapshot` replacing the skeleton.
 * Seq/revision continue after the last surface event seen (the skeleton's
 * by default). A withheld turn's status carries the verifier's notice — the
 * one `text_delta` such a turn streams, already localised and user-facing.
 */
export async function* replaceSkeletonOnWithheld(
  turn: AsyncIterable<ChatStreamEvent>,
  opts: {
    canvasSessionId: string;
    protocolVersion: string;
    opsCatalogVersion: string;
    /** seq/revision of the skeleton snapshot already sent. */
    lastSurfaceSeq: number;
    lastRevision: RevisionId;
  },
): AsyncGenerator<ChatStreamEvent> {
  let seq = opts.lastSurfaceSeq;
  let revision = Number(opts.lastRevision);
  let lastText: string | undefined;
  const replacement = (kind: 'withheld' | 'failed'): ChatStreamEvent => ({
    type: 'surface_snapshot',
    canvasSessionId: opts.canvasSessionId,
    surfaceSeq: ++seq,
    producesRevision: String(++revision) as RevisionId,
    tree: withheldTree(kind, kind === 'withheld' ? lastText : undefined),
    protocolVersion: opts.protocolVersion,
    opsCatalogVersion: opts.opsCatalogVersion,
  });
  for await (const event of turn) {
    if (event.type === 'surface_snapshot' || event.type === 'surface_patch') {
      seq = Math.max(seq, event.surfaceSeq);
      revision = Math.max(revision, Number(event.producesRevision));
    } else if (event.type.startsWith('surface_')) {
      seq = Math.max(seq, (event as { surfaceSeq: number }).surfaceSeq);
    } else if (event.type === 'text_delta') {
      lastText = event.text;
    }
    if (event.type === 'done' && event.answerSource === 'verifier-blocked') {
      yield replacement('withheld');
    } else if (event.type === 'error') {
      yield replacement('failed');
    }
    yield event;
  }
}

