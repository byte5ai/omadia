/**
 * #1556 — the operator's list of fields that hold no personal data.
 *
 * The shape classifier masks every value it cannot positively recognize, and
 * an Odoo many2one pair `[4, "Research & Development"]` is one of them: the
 * same shape holds a person (`partner_id: [12, "Jonas Weber"]`). So the model
 * could never name a department in a sentence. Whether a field is personal is
 * a fact about the operator's data, not about its shape, so the operator says
 * it — `non_personal_fields`, empty by default.
 *
 * Scoped entries (decision Marcel, 2026-10-30) name the source AND the model
 * the field belongs to, so the same field name in another model stays masked:
 *
 *   odoo_execute:hr.employee/department_id   a tool's field in one model
 *   dataset:<dataset uuid>/Abteilung         a column of one uploaded dataset
 *   some_mcp_tool:-/category                 a tool whose results name no model
 *
 * Legacy entries (#1629) stay valid and apply to EVERY model of the source:
 *
 *   odoo_execute:department_id               that tool, any model
 *   *:job_id   or   job_id                   any tool, any model
 *
 * Entries are separated by newlines, `;` or `,`. A dataset or a verb result
 * matches only when the rule covers EVERY source its rows came from (tool +
 * scope), so a join cannot carry a field into clear text that one of its
 * sources did not clear.
 *
 * What still masks a listed field: a value that is not a string or a
 * `[number, string]` pair, and a hit of the identity detector (e-mail, IBAN,
 * phone, address, ID number) on any value. Person names are NOT detected
 * here: listing a field that holds names sends them to the model.
 */

import { isLinkKeyField } from './v4/verbs/predicate.js';

/** The config key on the privacy-guard plugin. */
export const NON_PERSONAL_FIELDS_CONFIG_KEY = 'non_personal_fields';

/** The source token of a scoped entry for an uploaded dataset; it matches
 *  rows read through `query_dataset`. */
export const DATASET_SOURCE = 'dataset';
/** The tool an uploaded dataset is read through. */
export const DATASET_TOOL = 'query_dataset';
/** The scope of a source whose results name no model. */
export const NO_SCOPE = '-';

/**
 * Where a dataset's rows came from: the tool, and the model / dataset its
 * rows belong to (`-` when the result names none). The unit an entry scopes.
 */
export interface FieldSource {
  readonly tool: string;
  readonly scope: string;
}

export type NonPersonalFieldEntry =
  | {
      readonly kind: 'legacy';
      /** A tool name, or `*` for any tool. */
      readonly tool: string;
      readonly path: string;
    }
  | {
      readonly kind: 'scoped';
      /** A tool name, or `dataset` for an uploaded dataset. */
      readonly source: string;
      /** A model (`hr.employee`), a dataset id, or `-`. */
      readonly scope: string;
      readonly path: string;
    };

export interface ParsedNonPersonalFields {
  readonly entries: readonly NonPersonalFieldEntry[];
  /** Entries that were not understood, as written. */
  readonly rejected: readonly string[];
}

/** A tool name or a legacy path: no whitespace and no separator. */
const NAME = /^[^\s:;,/]+$/u;
/** A model (`hr.employee`, `x_custom.region`), a dataset uuid, or `-`. */
export const SCOPE_GRAMMAR = /^(?:-|[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
/** A scoped field: an Odoo field, a JSON key or a CSV header. Inner spaces
 *  are fine ("Abteilung Name"), separators and line breaks are not. */
export const SCOPED_FIELD_GRAMMAR = /^[^\s:;,/](?:[^\n\r:;,/]{0,198}[^\s:;,/])?$/u;

function parseItem(text: string): NonPersonalFieldEntry | undefined {
  const at = text.indexOf(':');
  if (at === -1) {
    return NAME.test(text) && !isLinkKeyField(text) ? { kind: 'legacy', tool: '*', path: text } : undefined;
  }
  const head = text.slice(0, at).trim();
  const rest = text.slice(at + 1).trim();
  const slash = rest.indexOf('/');
  if (slash === -1) {
    return NAME.test(head) && NAME.test(rest) && !isLinkKeyField(rest)
      ? { kind: 'legacy', tool: head, path: rest }
      : undefined;
  }
  const scope = rest.slice(0, slash).trim();
  const path = rest.slice(slash + 1).trim();
  if (head === '*' || !NAME.test(head) || !SCOPE_GRAMMAR.test(scope) || !SCOPED_FIELD_GRAMMAR.test(path)) {
    return undefined;
  }
  if (path.startsWith('__k_') || isLinkKeyField(path)) return undefined;
  return { kind: 'scoped', source: head, scope, path };
}

/** Parse the config value; never throws. */
export function parseNonPersonalFields(raw: string | undefined): ParsedNonPersonalFields {
  const entries: NonPersonalFieldEntry[] = [];
  const rejected: string[] = [];
  for (const item of (raw ?? '').split(/[\n;,]/u)) {
    const text = item.trim();
    if (text.length === 0) continue;
    const entry = parseItem(text);
    if (entry === undefined) rejected.push(text);
    else entries.push(entry);
  }
  return { entries, rejected };
}

/** The scoped entry text for a source + field; `undefined` when the parts
 *  cannot form one entry that parses back to exactly them. */
export function formatScopedEntry(source: FieldSource, path: string): string | undefined {
  const head = source.tool === DATASET_TOOL ? DATASET_SOURCE : source.tool;
  const text = `${head}:${source.scope}/${path}`;
  const parsed = parseNonPersonalFields(text);
  const only = parsed.entries[0];
  if (parsed.rejected.length > 0 || parsed.entries.length !== 1 || only?.kind !== 'scoped') return undefined;
  return only.source === head && only.scope === source.scope && only.path === path ? text : undefined;
}

/**
 * Pseudo-tools a `*` entry never covers: a sub-agent's free-form prose
 * narration interned as JSON. Its keys are whatever the sub-agent's model
 * wrote, not a tool's schema the operator looked at. Name it explicitly to
 * clear a field there.
 */
const WILDCARD_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['sub-agent']);

/** Does `entry` cover `path` of rows from `source`? */
export function entryCovers(entry: NonPersonalFieldEntry, source: FieldSource, path: string): boolean {
  if (entry.path !== path) return false;
  if (entry.kind === 'legacy') {
    return entry.tool === source.tool || (entry.tool === '*' && !WILDCARD_EXCLUDED_TOOLS.has(source.tool));
  }
  const tool = entry.source === DATASET_SOURCE ? DATASET_TOOL : entry.source;
  return tool === source.tool && entry.scope.toLowerCase() === source.scope.toLowerCase();
}

/**
 * The classifier rule for `entries`: `path` is non-personal when, for every
 * source in `sources`, an entry covers it. `undefined` when there are no
 * entries — the classifier then runs exactly as without the setting.
 */
export function nonPersonalFieldRule(
  entries: readonly NonPersonalFieldEntry[],
): ((sources: readonly FieldSource[], path: string) => boolean) | undefined {
  if (entries.length === 0) return undefined;
  return (sources, path) =>
    sources.length > 0 && sources.every((source) => entries.some((e) => entryCovers(e, source, path)));
}
