/**
 * Phase C — Server-Side Templates for Routines.
 *
 * Type definitions for the `output_template` JSONB column added in
 * migration 0004. When a routine carries a non-NULL template, the
 * orchestrator routes the run through the template-rendering path:
 *
 *   1. LLM produces ONLY narrative slot strings (intro / summary /
 *      transitions). It does not author data tables or lists.
 *   2. The server renders `data-table` and `data-list` sections from
 *      the raw, pre-tokenisation tool result data captured during
 *      `processToolResult`.
 *   3. `static-markdown` sections embed verbatim operator-authored
 *      text.
 *   4. The composed output is the final user-facing payload.
 *
 * Privacy property: real PII flowing through `data-table` /
 * `data-list` sections never reaches the public LLM. Only the
 * tokenised version goes outbound; the raw data lives only inside
 * the server's turn context. The narrative slots still pass through
 * `applyEgressFilter` + Phase A.2 final-scrub for spontaneous-PII
 * protection — same safety net the legacy path enjoys.
 *
 * See docs/harness-platform/PHASE-C-DESIGN-server-side-templates.md
 * for the full architecture, schema migration, and slice plan.
 */

/**
 * Output format the renderer emits. Different channels prefer
 * different shapes — Teams renders Adaptive Cards natively, web-ui
 * consumes markdown, future HTML-only channels may use html.
 *
 * The orchestrator can request a downcast: a template authored as
 * `adaptive-card` can be rendered to markdown for a channel that
 * does not support cards. Reverse is not supported (markdown loses
 * structural fidelity).
 */
export type RoutineOutputFormat = 'markdown' | 'adaptive-card' | 'html';

/**
 * A narrative slot is a free-form text fragment the LLM produces.
 * Identified by a stable `id` so the renderer can place the LLM's
 * output back into the composed result. The `hint` is appended to
 * the routine prompt so the LLM knows what to write for this slot
 * (1-2 sentences, plain markdown, no tables / lists).
 *
 * Slots carry tokenised PII when the LLM references restored values
 * — `processInbound` + `applyEgressFilter` + Phase A.2 still apply
 * to them at orchestrator-finalise time. Data leakage protection is
 * unchanged for the narrative path.
 */
export interface RoutineNarrativeSlotSection {
  readonly kind: 'narrative-slot';
  readonly id: string;
  readonly hint?: string;
}

/**
 * Column descriptor for a data-table. `field` is the JSON path
 * inside each row of the source array (no nesting in v1 — flat row
 * objects only; nest later if real templates need it). `format`
 * applies a server-side renderer (date → locale-formatted, currency
 * → tenant-locale currency, plain → identity).
 */
export interface RoutineTemplateColumn {
  readonly label: string;
  readonly field: string;
  readonly format?: 'date' | 'currency' | 'plain';
}

/**
 * A data-table section pulls structured rows from a tool result and
 * renders them as a table (markdown table, Adaptive Card FactSet,
 * HTML <table>, …). The `sourceTool` is the tool name the routine
 * invoked; the orchestrator captured its raw output BEFORE
 * tokenisation, keyed by tool name on the turn context.
 *
 * `sourcePath` is an optional JSON path into the captured object,
 * e.g. `absences` when the tool returns
 * `{ absences: [...rows], meta: {...} }`. Omit to consume the whole
 * payload as the row array.
 *
 * `groupBy` is an optional column-field name that splits the rows
 * into per-value sub-sections (e.g. `type` produces "Paid Time Off",
 * "Sick Leave" sub-tables). Each sub-section gets its own title row.
 *
 * `emptyText` is shown when the source resolves to an empty array.
 * Defaults to the locale-neutral "—" when omitted.
 */
export interface RoutineDataTableSection {
  readonly kind: 'data-table';
  readonly sourceTool: string;
  readonly sourcePath?: string;
  readonly title?: string;
  /** When present, replaces `title` with the named narrative slot
   *  (e.g. let the LLM decide the section header from the data). */
  readonly titleSlot?: string;
  readonly groupBy?: string;
  readonly columns: readonly RoutineTemplateColumn[];
  readonly emptyText?: string;
}

/**
 * A data-list section renders rows as a bulleted list, with each row
 * passed through a Mustache-style item template. Useful when a
 * table is overkill (e.g. "3 upcoming meetings"). The `itemTemplate`
 * supports `{{field}}` interpolation; `{{#if field}}…{{/if}}` and
 * `{{#each}}` are intentionally out of scope for v1.
 */
export interface RoutineDataListSection {
  readonly kind: 'data-list';
  readonly sourceTool: string;
  readonly sourcePath?: string;
  readonly title?: string;
  readonly titleSlot?: string;
  readonly itemTemplate: string;
  readonly emptyText?: string;
}

/**
 * Verbatim markdown emitted by the renderer with no LLM or data
 * involvement. Use for operator-authored disclaimers, contact lines,
 * static instructions.
 */
export interface RoutineStaticMarkdownSection {
  readonly kind: 'static-markdown';
  readonly text: string;
}

export type RoutineTemplateSection =
  | RoutineNarrativeSlotSection
  | RoutineDataTableSection
  | RoutineDataListSection
  | RoutineStaticMarkdownSection;

/**
 * Top-level template attached to a routine row. The orchestrator
 * checks for its presence to decide which pipeline to run. Operator
 * UI / admin API persist the JSON blob.
 */
export interface RoutineOutputTemplate {
  readonly format: RoutineOutputFormat;
  readonly sections: readonly RoutineTemplateSection[];
}

/**
 * Narrow type-guard the orchestrator uses to validate a JSONB blob
 * fetched from Postgres before treating it as a template. Defensive
 * against operator typos and schema drift. Returns the typed value
 * on success, or a descriptive error message string on failure.
 *
 * Validation is shallow — structural shape only, not semantic
 * correctness (e.g. we don't yet verify that `sourceTool` refers to
 * a registered tool, or that `field` paths exist on real rows). The
 * orchestrator's template-rendering call is the next layer that
 * catches semantic errors and surfaces them via the receipt.
 */
export function parseRoutineOutputTemplate(
  raw: unknown,
):
  | { readonly ok: true; readonly value: RoutineOutputTemplate }
  | { readonly ok: false; readonly reason: string } {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'template must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const formatRaw = obj['format'];
  if (
    formatRaw !== 'markdown' &&
    formatRaw !== 'adaptive-card' &&
    formatRaw !== 'html'
  ) {
    return {
      ok: false,
      reason: `format must be 'markdown' | 'adaptive-card' | 'html', got ${JSON.stringify(formatRaw)}`,
    };
  }
  const sectionsRaw = obj['sections'];
  if (!Array.isArray(sectionsRaw)) {
    return { ok: false, reason: 'sections must be an array' };
  }
  const sections: RoutineTemplateSection[] = [];
  for (let i = 0; i < sectionsRaw.length; i += 1) {
    const r = sectionsRaw[i];
    if (r === null || typeof r !== 'object') {
      return {
        ok: false,
        reason: `sections[${String(i)}] must be an object`,
      };
    }
    const s = r as Record<string, unknown>;
    const kind = s['kind'];
    if (kind === 'narrative-slot') {
      if (typeof s['id'] !== 'string' || s['id'].length === 0) {
        return {
          ok: false,
          reason: `sections[${String(i)}].id must be a non-empty string`,
        };
      }
      const hintRaw = s['hint'];
      sections.push({
        kind: 'narrative-slot',
        id: s['id'],
        ...(typeof hintRaw === 'string' ? { hint: hintRaw } : {}),
      });
      continue;
    }
    if (kind === 'static-markdown') {
      if (typeof s['text'] !== 'string') {
        return {
          ok: false,
          reason: `sections[${String(i)}].text must be a string`,
        };
      }
      sections.push({ kind: 'static-markdown', text: s['text'] });
      continue;
    }
    if (kind === 'data-table' || kind === 'data-list') {
      if (typeof s['sourceTool'] !== 'string' || s['sourceTool'].length === 0) {
        return {
          ok: false,
          reason: `sections[${String(i)}].sourceTool must be a non-empty string`,
        };
      }
      const common = {
        sourceTool: s['sourceTool'] as string,
        ...(typeof s['sourcePath'] === 'string'
          ? { sourcePath: s['sourcePath'] as string }
          : {}),
        ...(typeof s['title'] === 'string' ? { title: s['title'] as string } : {}),
        ...(typeof s['titleSlot'] === 'string'
          ? { titleSlot: s['titleSlot'] as string }
          : {}),
        ...(typeof s['emptyText'] === 'string'
          ? { emptyText: s['emptyText'] as string }
          : {}),
      };
      if (kind === 'data-table') {
        const cols = s['columns'];
        if (!Array.isArray(cols) || cols.length === 0) {
          return {
            ok: false,
            reason: `sections[${String(i)}].columns must be a non-empty array`,
          };
        }
        const columns: RoutineTemplateColumn[] = [];
        for (let j = 0; j < cols.length; j += 1) {
          const c = cols[j];
          if (c === null || typeof c !== 'object') {
            return {
              ok: false,
              reason: `sections[${String(i)}].columns[${String(j)}] must be an object`,
            };
          }
          const cc = c as Record<string, unknown>;
          if (typeof cc['label'] !== 'string' || typeof cc['field'] !== 'string') {
            return {
              ok: false,
              reason: `sections[${String(i)}].columns[${String(j)}] requires label + field strings`,
            };
          }
          const fmt = cc['format'];
          const formatVal =
            fmt === 'date' || fmt === 'currency' || fmt === 'plain' ? fmt : undefined;
          columns.push({
            label: cc['label'] as string,
            field: cc['field'] as string,
            ...(formatVal !== undefined ? { format: formatVal } : {}),
          });
        }
        sections.push({
          kind: 'data-table',
          ...common,
          ...(typeof s['groupBy'] === 'string' ? { groupBy: s['groupBy'] as string } : {}),
          columns,
        });
        continue;
      }
      // kind === 'data-list'
      if (typeof s['itemTemplate'] !== 'string') {
        return {
          ok: false,
          reason: `sections[${String(i)}].itemTemplate must be a string`,
        };
      }
      sections.push({
        kind: 'data-list',
        ...common,
        itemTemplate: s['itemTemplate'] as string,
      });
      continue;
    }
    return {
      ok: false,
      reason: `sections[${String(i)}].kind must be one of: narrative-slot | data-table | data-list | static-markdown`,
    };
  }
  return {
    ok: true,
    value: { format: formatRaw, sections },
  };
}
