/**
 * The claim extractor's verbatim guard: a claim must quote the answer.
 *
 * The model is told to copy each claim's text out of the answer, but it does
 * not always reproduce the answer's whitespace — a line break comes back as a
 * space, a non-breaking space as a plain one. Such a claim still quotes the
 * answer and is checked like any other. A claim that differs in anything but
 * case and whitespace — a paraphrase, or a subject stitched in from elsewhere
 * in the sentence — quotes nothing; the extractor keeps it from the checkers
 * and reports the miss as a coverage gap, since the part of the answer it
 * stood for is then not checked.
 *
 * Linear in the answer's length: both sides are folded once (lower case, each
 * whitespace run as one space) and searched with `indexOf`, so a long answer
 * full of near matches cannot stall the event loop the way a backtracking
 * pattern could.
 */

/** A string folded for comparison, with the original offset of each unit. */
interface Folded {
  text: string;
  from: number[];
}

/** JavaScript's `\s`: whitespace and line terminators (all in the BMP). */
function isWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Lower case of one code unit, or the unit itself when lower-casing would
 *  change its length (e.g. U+0130) and shift every later offset. */
function lowerUnit(unit: string): string {
  const lower = unit.toLowerCase();
  return lower.length === 1 ? lower : unit;
}

function fold(value: string): Folded {
  const lower = value.toLowerCase();
  const sameLength = lower.length === value.length;
  const units: string[] = [];
  const from: number[] = [];
  let inRun = false;
  for (let i = 0; i < value.length; i += 1) {
    if (isWhitespace(value.charCodeAt(i))) {
      if (!inRun) {
        units.push(' ');
        from.push(i);
      }
      inRun = true;
      continue;
    }
    units.push(sameLength ? (lower[i] ?? '') : lowerUnit(value.charAt(i)));
    from.push(i);
    inRun = false;
  }
  return { text: units.join(''), from };
}

/**
 * For one answer, the span each claim text quotes, or `undefined` when it
 * quotes none. Case is ignored, and each run of whitespace in the claim
 * matches any run of whitespace in the answer. The span is cut from the
 * answer itself, so a claim built from it is always part of the answer as
 * written. The answer is folded once, however many claims are looked up.
 */
export function verbatimSpans(answer: string): (claimText: string) => string | undefined {
  const hay = fold(answer);
  return (claimText) => {
    const needle = fold(claimText.trim()).text;
    if (needle.length === 0) return undefined;
    const at = hay.text.indexOf(needle);
    if (at < 0) return undefined;
    const start = hay.from[at];
    const last = hay.from[at + needle.length - 1];
    return start === undefined || last === undefined
      ? undefined
      : answer.slice(start, last + 1);
  };
}
