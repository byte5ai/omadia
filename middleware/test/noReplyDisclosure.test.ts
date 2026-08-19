import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  applyAiDisclosure,
  isNoReply,
  resolveAiDisclosure,
  toSemanticAnswer,
} from '@omadia/channel-sdk';

const DE_STANDARD = 'Diese Antwort wurde von einem KI-System erzeugt.';

/**
 * Regression guard: suppression must precede decoration.
 *
 * `isNoReply` anchors the lenient sentinel form at the END of the message
 * (`/(?:^|\n)\s*NO_REPLY\s*$/`). The AI-Act Art. 50 marking (#643/#644) folds
 * a line into the very same `text`. Folding it onto a NO_REPLY answer appends
 * text AFTER the sentinel, the end-anchor stops matching, and a routine that
 * deliberately had nothing to report delivers its full reasoning instead.
 *
 * That is the 2026-08-17 incident: the weekly "Urlaubsanträge zur Genehmigung"
 * routine emitted the sentinel exactly as instructed (it does in all four
 * recorded runs) and still pushed 9,381 characters into the operator's Teams
 * chat, because the middleware deployed on 2026-08-14 had started folding the
 * marking.
 */

/** The literal tail of the 2026-08-17 routine answer. */
const PROSE_SENTINEL =
  "Per the task instruction, no notification when there's nothing to approve.\n\nNO_REPLY";

function turn(answer: string) {
  return { answer, toolCalls: 0, iterations: 1 };
}

describe('NO_REPLY survives the AI-Act disclosure fold', () => {
  it('keeps the strict sentinel suppressible', () => {
    const out = applyAiDisclosure('NO_REPLY');
    assert.equal(out.text, 'NO_REPLY', 'the marking must not be folded onto a sentinel');
    assert.ok(isNoReply({ text: out.text }), 'the sentinel still suppresses delivery');
  });

  it('keeps the lenient trailing sentinel suppressible', () => {
    const out = applyAiDisclosure(PROSE_SENTINEL);
    assert.ok(
      isNoReply({ text: out.text }),
      'prose + trailing NO_REPLY must stay suppressible after disclosure resolution',
    );
    assert.ok(!out.text.includes(DE_STANDARD), 'no marking is appended after the sentinel');
  });

  it('still forwards the structured marker for the audit trail', () => {
    const out = applyAiDisclosure(PROSE_SENTINEL);
    assert.ok(out.aiDisclosure, 'the resolved marker is still returned — only the fold is skipped');
  });

  it('reproduces the routine delivery path end to end (the 2026-08-17 incident)', () => {
    // routineRunner.ts: `toSemanticAnswer(result)` with NO ctx — the marking
    // rides `result.aiDisclosure`, resolved by the orchestrator (#644).
    const sa = toSemanticAnswer({
      ...turn(PROSE_SENTINEL),
      aiDisclosure: resolveAiDisclosure(),
    });
    assert.ok(
      isNoReply(sa),
      'the message handed to the channel sender must still be recognised as NO_REPLY',
    );
  });

  it('does NOT weaken the marking on a real answer', () => {
    const sa = toSemanticAnswer({
      ...turn('Es liegen 3 Urlaubsanträge zur Genehmigung vor.'),
      aiDisclosure: resolveAiDisclosure(),
    });
    assert.match(sa.text, /KI-System/, 'a deliverable answer keeps its Art. 50 marking');
    assert.ok(!isNoReply(sa), 'a real answer is delivered');
  });

  it('does not spend the scope first-turn marking slot on a withheld message', () => {
    // `shouldFold` marks the scope seen as a side effect, and the marking is
    // folded only on a scope's FIRST turn. A withheld message must not consume
    // that one slot — otherwise the next answer that really is delivered would
    // ship without its Art. 50 marking.
    const seen = new Set<string>();
    const store = {
      hasSeen: (scope: string) => seen.has(scope),
      markSeen: (scope: string) => {
        seen.add(scope);
      },
    };

    const withheld = applyAiDisclosure(PROSE_SENTINEL, { scope: 'routine:abc', seen: store });
    assert.ok(isNoReply({ text: withheld.text }), 'the withheld turn stays suppressible');
    assert.equal(seen.size, 0, 'a withheld turn does not mark the scope seen');

    const delivered = applyAiDisclosure('Es liegen 3 Anträge vor.', {
      scope: 'routine:abc',
      seen: store,
    });
    assert.match(delivered.text, /KI-System/, 'the next delivered answer still gets marked');
  });

  it('does not treat a quoted sentinel mid-answer as a suppression', () => {
    const sa = toSemanticAnswer({
      ...turn('Die Routine antwortet mit NO_REPLY, wenn nichts anliegt. Heute: 2 Anträge.'),
      aiDisclosure: resolveAiDisclosure(),
    });
    assert.ok(!isNoReply(sa), 'a mid-answer mention is not a sentinel');
    assert.match(sa.text, /KI-System/, 'and it keeps its marking');
  });
});
