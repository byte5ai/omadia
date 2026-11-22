/**
 * Spec 2042 §5.10 — a tool's declared PII fields (`ToolRegistrationOptions
 * .piiFields`, `piiAnnotation.ts`) at the data-plane boundary.
 *
 * The classifier decides per column whether a field may cross the wire in
 * clear. A field the tool itself declares as PII is masked whatever the
 * classifier (or an operator's non-personal entry) says: the declaration only
 * ever adds masking, it never clears a field.
 *
 * A declaration names a JSON path in the RAW result; the boundary classifies
 * the parsed rows. Only paths that name one column of those rows apply:
 *
 *   `name`, `manager.name`          — a field of an object result / every row
 *   `[].name`                       — a field of a top-level array of rows
 *   `<items>[].name`                — a field of the rows under the envelope's
 *                                     items key (`{ items: [...], total }`)
 *
 * each with an optional trailing `[N]` (Odoo's many2one `[id, label]`): the
 * whole column is masked then. A deeper path (an array inside a row, an index
 * in the middle) names no column and is ignored.
 */

import type { ToolPIIField } from '@omadia/plugin-api';

import type { DatasetSchema } from './types.js';

const TRAILING_INDEX = /\[\d+\]$/;

/** The row columns the declarations name. */
export function declaredPiiColumns(
  fields: readonly ToolPIIField[] | undefined,
  itemsPath?: string,
): ReadonlySet<string> {
  const columns = new Set<string>();
  for (const field of fields ?? []) {
    if (typeof field?.path !== 'string') continue;
    let path = field.path.trim().replace(TRAILING_INDEX, '');
    if (path.startsWith('[].')) path = path.slice(3);
    else if (itemsPath !== undefined && path.startsWith(`${itemsPath}[].`)) path = path.slice(itemsPath.length + 3);
    if (path.length === 0 || path.includes('[')) continue;
    columns.add(path);
  }
  return columns;
}

/** The schema with every declared column masked. */
export function withDeclaredPii(schema: DatasetSchema, columns: ReadonlySet<string>): DatasetSchema {
  if (columns.size === 0) return schema;
  let changed = false;
  const fields = schema.fields.map((f) => {
    if (f.classification === 'sensitive-masked' || !columns.has(f.path)) return f;
    changed = true;
    return { ...f, classification: 'sensitive-masked' as const };
  });
  return changed ? { ...schema, fields } : schema;
}
