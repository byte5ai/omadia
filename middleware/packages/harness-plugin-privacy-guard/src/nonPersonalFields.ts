/**
 * #1556 — the operator's list of fields that hold no personal data.
 *
 * The shape classifier masks every value it cannot positively recognize, and
 * an Odoo many2one pair `[4, "Research & Development"]` is one of them: the
 * same shape holds a person (`partner_id: [12, "Jonas Weber"]`). So the model
 * could never name a department in a sentence. Whether a field is personal is
 * a fact about the operator's data, not about its shape, so the operator says
 * it — `non_personal_fields`, empty by default:
 *
 *   odoo_execute:department_id      that tool's field
 *   *:job_id                        that field of any tool
 *   department_id                   same as `*:department_id`
 *
 * Entries are separated by newlines, `;` or `,`. A field matches by its exact
 * path. A verb-derived dataset (filter, sort, join, union) matches only when
 * the rule covers EVERY tool its rows came from, so a join cannot carry a
 * field into clear text that one of its sources did not clear.
 *
 * What still masks a listed field: a value that is not a string or a
 * `[number, string]` pair, and a hit of the identity detector (e-mail, IBAN,
 * phone, address, ID number) on any value. Person names are NOT detected
 * here: listing a field that holds names sends them to the model.
 */

import { isLinkKeyField } from './v4/verbs/predicate.js';

/** The config key on the privacy-guard plugin. */
export const NON_PERSONAL_FIELDS_CONFIG_KEY = 'non_personal_fields';

export interface NonPersonalFieldEntry {
  /** A tool name, or `*` for any tool. */
  readonly tool: string;
  readonly path: string;
}

export interface ParsedNonPersonalFields {
  readonly entries: readonly NonPersonalFieldEntry[];
  /** Entries that were not understood, as written. */
  readonly rejected: readonly string[];
}

const NAME = /^[^\s:;,]+$/u;

/** Parse the config value; never throws. */
export function parseNonPersonalFields(raw: string | undefined): ParsedNonPersonalFields {
  const entries: NonPersonalFieldEntry[] = [];
  const rejected: string[] = [];
  for (const item of (raw ?? '').split(/[\n;,]/u)) {
    const text = item.trim();
    if (text.length === 0) continue;
    const at = text.indexOf(':');
    const tool = at === -1 ? '*' : text.slice(0, at).trim();
    const path = at === -1 ? text : text.slice(at + 1).trim();
    // A link key is never a cleartext label (#1560): it is an identity handle,
    // also as the last segment of a nested path.
    if (!NAME.test(tool) || !NAME.test(path) || isLinkKeyField(path)) {
      rejected.push(text);
      continue;
    }
    entries.push({ tool, path });
  }
  return { entries, rejected };
}

/**
 * Pseudo-tools a `*` entry never covers: a sub-agent's free-form prose
 * narration interned as JSON. Its keys are whatever the sub-agent's model
 * wrote, not a tool's schema the operator looked at. Name it explicitly to
 * clear a field there.
 */
const WILDCARD_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['sub-agent']);

/**
 * The classifier rule for `entries`: `path` is non-personal when, for every
 * tool in `sourceTools`, an entry names that tool (or `*`) and that path.
 * `undefined` when there are no entries — the classifier then runs exactly as
 * without the setting.
 */
export function nonPersonalFieldRule(
  entries: readonly NonPersonalFieldEntry[],
): ((sourceTools: readonly string[], path: string) => boolean) | undefined {
  if (entries.length === 0) return undefined;
  return (sourceTools, path) =>
    sourceTools.length > 0 &&
    sourceTools.every((tool) =>
      entries.some(
        (e) =>
          e.path === path &&
          (e.tool === tool || (e.tool === '*' && !WILDCARD_EXCLUDED_TOOLS.has(tool))),
      ),
    );
}
