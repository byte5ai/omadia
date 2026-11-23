/**
 * Spec 2042 §6 criteria 3c / 18 — what the privacy shield may give back to
 * the room. The shield restores masked values for the turn; in a room where
 * not every member holds the right to personal fields
 * (`discretion/fieldRights.ts`) nothing masked is given back: the rendered
 * answer keeps the mask placeholder and the prompt surrogates stay in place.
 * The model never saw those values, so nothing else of them can be in the
 * answer.
 */

import type { PrivacyRenderedAnswer } from '@omadia/plugin-api';

import { personalFieldsWithheld } from './discretion/fieldRights.js';

/** What the shield puts in place of a masked value (the privacy guard's `[masked]`). */
export const FIELD_MASK_PLACEHOLDER = '[masked]';

const FIELD_WITHHELD_NOTICE_DE =
  'Einige Angaben bleiben hier maskiert, weil nicht alle in dieser Unterhaltung sie sehen dürfen.';
const FIELD_WITHHELD_NOTICE_EN =
  'Some details stay masked here because not everyone in this conversation may see them.';

/** The note under an answer whose masked values were not restored for the room. */
export const FIELD_WITHHELD_NOTICE = `${FIELD_WITHHELD_NOTICE_DE} / ${FIELD_WITHHELD_NOTICE_EN}`;

/** `text` with every occurrence of `values` replaced by the mask placeholder (longest first). */
export function maskValuesInText(text: string, values: readonly string[]): string {
  const ordered = [...new Set(values)].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  return ordered.reduce((out, value) => out.split(value).join(FIELD_MASK_PLACEHOLDER), text);
}

/**
 * A `v4_render_answer` result as the room may see it: unchanged when every
 * member may know personal fields (or nothing masked was rendered), else with
 * the materialized values masked again and no `maskedValues` left to
 * highlight.
 */
export async function renderedAnswerForAudience(
  rendered: PrivacyRenderedAnswer,
): Promise<PrivacyRenderedAnswer> {
  if (rendered.maskedValues.length === 0) return rendered;
  if (!(await personalFieldsWithheld())) return rendered;
  return {
    ...rendered,
    text: `${maskValuesInText(rendered.text, rendered.maskedValues)}\n\n${FIELD_WITHHELD_NOTICE}`,
    maskedValues: [],
  };
}
