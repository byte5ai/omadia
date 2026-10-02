import type { ChatStreamEvent } from '@omadia/channel-sdk';

/**
 * The canvas skeleton on a base that holds content until the verdict
 * (`ChatAgent.holdsContentUntilVerdict`: the answer verifier in `enforce`
 * mode). The skeleton is model output — the composer writes its headings,
 * labels and text from the user's request — so it waits for the verdict like
 * the turn's own content, and only a released turn shows it: it goes out
 * right before the turn's first surface event (whose revisions build on it)
 * or, in a turn without one, before the releasing `done`, and ahead of the
 * turn's answer text either way. A turn the base withholds
 * (`done.answerSource: 'verifier-blocked'`) or that fails (`error`) never
 * shows it.
 *
 * Every event of the base goes out unchanged and in order; while the
 * skeleton waits, text deltas wait with it so the answer text cannot overtake
 * it. Before the verdict the base sends liveness, progress and usage events
 * only, and the surfaces synthesised from its tool results arrive with its
 * release, so the wait adds no delay of its own.
 */
export async function* skeletonOnRelease(
  skeleton: ChatStreamEvent,
  turn: AsyncIterable<ChatStreamEvent>,
): AsyncGenerator<ChatStreamEvent> {
  let pending: ChatStreamEvent | undefined = skeleton;
  let text: ChatStreamEvent[] = [];
  for await (const event of turn) {
    if (pending === undefined) {
      yield event;
      continue;
    }
    if (event.type === 'text_delta') {
      text = [...text, event];
      continue;
    }
    const released =
      event.type.startsWith('surface_') ||
      (event.type === 'done' && event.answerSource !== 'verifier-blocked');
    if (released) yield pending;
    if (released || event.type === 'done' || event.type === 'error') {
      pending = undefined;
      yield* text;
      text = [];
    }
    yield event;
  }
  // A stream that ended without a terminal event released no turn: its text
  // goes out as the base sent it, the skeleton does not.
  yield* text;
}
