import type { PrivacyDatasetProvenance, PrivacyResolvedDataset } from '@omadia/plugin-api';
import { catalogColumnLabel } from '@omadia/fast-path';

/**
 * Human headers for AGENT-filled tables (datasetId publishes).
 *
 * A dataset publish keys the table's columns BY path (patchComposition.ts),
 * and the agent's own labels are matched to them only positionally — with a
 * different column count none is claimed, and the header used to be the raw
 * path (`job_title`, `work_email`). Each dataset column now carries a
 * `defaultLabel` for that case: the fast path's catalog label of the
 * dataset's Odoo model (provenance input `model`) in the canvas language,
 * else the humanised path (fieldLabels.ts — the same fallback the fast path
 * uses). An explicit label (the agent's, a fast-path plan's) still wins.
 */

export type LabelLang = 'de' | 'en';

/** The canvas client's language when the turn names none — a canvas turn
 *  carries no locale; the client sends `de-DE` where it does (row details). */
export const DEFAULT_LABEL_LANG: LabelLang = 'de';

/** A resolved dataset whose columns may carry the fallback header. */
export interface CanvasResolvedDataset extends PrivacyResolvedDataset {
  readonly columns: ReadonlyArray<PrivacyResolvedDataset['columns'][number] & { readonly defaultLabel?: string }>;
}

/** The Odoo model a dataset was read from, when its provenance names one. */
function provenanceModel(provenance: PrivacyDatasetProvenance | undefined): string | undefined {
  const input = provenance?.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const model = (input as { model?: unknown }).model;
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

/** `resolved` with a `defaultLabel` on every column. Returns a copy. */
export function withDefaultColumnLabels(
  resolved: PrivacyResolvedDataset,
  provenance: PrivacyDatasetProvenance | undefined,
  lang: LabelLang = DEFAULT_LABEL_LANG,
): CanvasResolvedDataset {
  const model = provenanceModel(provenance);
  return {
    ...resolved,
    columns: resolved.columns.map((c) => ({
      ...c,
      defaultLabel: catalogColumnLabel({ fieldKey: c.path, attr: c.path, model, lang }),
    })),
  };
}
