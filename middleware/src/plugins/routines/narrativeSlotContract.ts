/**
 * Phase C.3 — Narrative-Slot LLM Contract.
 *
 * Templated routines (`output_template !== NULL`) split rendering into
 * two halves:
 *
 *   - **Server-side**: `data-table` / `data-list` / `static-markdown`
 *     sections are rendered by the template renderer (C.4) from raw
 *     pre-tokenisation tool results captured in C.2 — the LLM is not
 *     involved.
 *
 *   - **LLM-side**: free-form prose fragments for headers, intros, and
 *     summaries. These live in `narrative-slot` sections (and the
 *     optional `titleSlot` on data-table / data-list sections). The
 *     LLM authors them in a single structured JSON response — never
 *     as inline markdown bleeding into the data path.
 *
 * This module is the contract surface:
 *
 *   1. `collectRequiredSlotIds(template)` — derives every slot id the
 *      LLM must emit for a given template (narrative-slot ids +
 *      titleSlot references on data sections).
 *
 *   2. `buildSlotDirective(template)` — produces the directive that
 *      gets appended to the routine's prompt. Tells the LLM the JSON
 *      shape, lists each slot id + hint, and forbids it from
 *      authoring data tables / lists (those come from the server).
 *
 *   3. `parseSlotResponse(text, template)` — parses the LLM's textual
 *      answer (with tolerance for code fences and surrounding chatter)
 *      and validates that every required slot is present and a string.
 *
 * Orchestrator wiring lives in C.5 (`runTurn` branch for templated
 * routines). This file stays pure — no I/O, no orchestrator imports,
 * deterministic output for the same input. That keeps it cheap to
 * unit-test and reusable from a "preview-template-with-last-run" UI
 * affordance later (C.7).
 */

import type { RoutineOutputTemplate } from './routineOutputTemplate.js';

/**
 * Shape the LLM is contracted to produce. A single top-level `slots`
 * map keyed by slot id, with string values. Strings may be empty (the
 * renderer decides what to do with blank narrative — typically it
 * just renders no prose for that slot), but the key MUST be present
 * for every required slot id; missing keys are a contract violation
 * and the orchestrator (C.5) will retry / placeholder the output.
 */
export interface NarrativeSlotResponse {
  readonly slots: Readonly<Record<string, string>>;
}

export type ParseSlotResponseResult =
  | { readonly ok: true; readonly value: NarrativeSlotResponse }
  | { readonly ok: false; readonly reason: string };

/**
 * Walk the template and return the de-duplicated, order-preserving
 * list of slot ids the LLM is responsible for.
 *
 * Sources:
 *   - every `narrative-slot` section's `id`
 *   - every `data-table` / `data-list` section's `titleSlot` (when set)
 *
 * Order is preserved (first occurrence wins) so the directive's
 * checklist matches the rendered output's reading order — easier for
 * the LLM to follow than an alphabetised list.
 */
export function collectRequiredSlotIds(
  template: RoutineOutputTemplate,
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined): void => {
    if (id === undefined || id.length === 0) return;
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const section of template.sections) {
    if (section.kind === 'narrative-slot') {
      add(section.id);
      continue;
    }
    if (section.kind === 'data-table' || section.kind === 'data-list') {
      add(section.titleSlot);
      continue;
    }
  }
  return ids;
}

/**
 * Lookup-table for slot-id → hint (or undefined). Built from a single
 * pass over the template; used by `buildSlotDirective` to print each
 * slot's authoring guidance and by potential future preview UIs.
 */
function collectSlotHints(
  template: RoutineOutputTemplate,
): ReadonlyMap<string, string | undefined> {
  const hints = new Map<string, string | undefined>();
  for (const section of template.sections) {
    if (section.kind === 'narrative-slot') {
      if (!hints.has(section.id)) {
        hints.set(section.id, section.hint);
      }
    }
  }
  return hints;
}

/**
 * Compose the directive string the orchestrator appends to a templated
 * routine's prompt. Gives the LLM:
 *
 *   - the JSON shape it must emit
 *   - the exact slot ids to fill (in render order)
 *   - the operator-authored hint for each slot
 *   - explicit prohibitions on authoring data sections itself
 *
 * Language is German to match the existing routine prompts in this
 * codebase. A future i18n slice can swap the strings — the shape is
 * already locale-independent (JSON keys are slot ids, not localised
 * labels).
 *
 * Returns an empty string when the template has no required slots —
 * the caller should then skip the LLM call entirely (a template can
 * legitimately consist of only data + static sections, in which case
 * the renderer alone produces the output).
 */
export function buildSlotDirective(template: RoutineOutputTemplate): string {
  const slotIds = collectRequiredSlotIds(template);
  if (slotIds.length === 0) return '';
  const hints = collectSlotHints(template);

  const lines: string[] = [];
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    'Antworte ausschließlich mit einem einzigen JSON-Objekt in folgender Form:',
  );
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "slots": {');
  slotIds.forEach((id, idx) => {
    const comma = idx === slotIds.length - 1 ? '' : ',';
    lines.push(`    ${JSON.stringify(id)}: "..."${comma}`);
  });
  lines.push('  }');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push(
    'Befülle jeden Slot mit reinem Fließtext (1–3 Sätze pro Slot, kein Markdown, keine Listen, keine Tabellen).',
  );
  lines.push('Slots im Detail:');
  for (const id of slotIds) {
    const hint = hints.get(id);
    lines.push(
      hint !== undefined && hint.length > 0
        ? `- ${id}: ${hint}`
        : `- ${id}: (frei formulieren)`,
    );
  }
  lines.push('');
  lines.push(
    'Verbote: keine Tabellen, keine Aufzählungen mit Daten, keine Markdown-Header. Daten-Sektionen rendert der Server selbst aus den Tool-Resultaten — wenn du sie dupliziert in einen Slot schreibst, erscheinen sie doppelt im Output.',
  );
  lines.push(
    'Nichts außerhalb des JSON-Objekts ausgeben — kein erläuternder Text davor oder danach.',
  );
  return lines.join('\n');
}

/**
 * Parse the LLM's textual answer into a validated `NarrativeSlotResponse`.
 *
 * Robustness:
 *   - tolerates surrounding whitespace
 *   - tolerates ```json``` and ``` markdown code fences
 *   - tolerates leading/trailing narrative chatter (extracts the
 *     largest balanced top-level `{…}` object)
 *
 * Validation:
 *   - top-level `slots` must be an object
 *   - every required slot id must be present
 *   - every present slot value must be a string (numbers, null, nested
 *     objects, arrays all fail — keeps the renderer's job simple)
 *
 * On success returns `{ ok: true, value }` where `value.slots` contains
 * AT LEAST every required id (and may carry extras the LLM emitted for
 * its own reasons — kept verbatim so a future renderer can ignore or
 * use them; we don't reject extras to avoid retry-loops for harmless
 * over-emission).
 *
 * On failure returns `{ ok: false, reason }` with a one-line diagnostic
 * the orchestrator can log + use to decide retry vs. placeholder.
 */
export function parseSlotResponse(
  text: string,
  template: RoutineOutputTemplate,
): ParseSlotResponseResult {
  const required = collectRequiredSlotIds(template);
  if (required.length === 0) {
    return { ok: true, value: { slots: {} } };
  }
  const jsonText = extractJsonObject(text);
  if (jsonText === null) {
    return {
      ok: false,
      reason: 'response contains no JSON object',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `JSON parse failed: ${msg}` };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'top-level JSON value is not an object' };
  }
  const root = parsed as Record<string, unknown>;
  const slotsRaw = root['slots'];
  if (slotsRaw === null || typeof slotsRaw !== 'object' || Array.isArray(slotsRaw)) {
    return { ok: false, reason: '`slots` must be an object' };
  }
  const slotsObj = slotsRaw as Record<string, unknown>;
  const slots: Record<string, string> = {};
  for (const id of required) {
    if (!Object.prototype.hasOwnProperty.call(slotsObj, id)) {
      return { ok: false, reason: `missing required slot '${id}'` };
    }
    const v = slotsObj[id];
    if (typeof v !== 'string') {
      return {
        ok: false,
        reason: `slot '${id}' must be a string, got ${describeType(v)}`,
      };
    }
    slots[id] = v;
  }
  // Preserve any extra slots the LLM emitted that aren't required —
  // they may be useful to a renderer that adds optional slots later,
  // and rejecting them would force a retry over harmless noise. Skip
  // non-string extras silently (same defensive stance as required).
  for (const k of Object.keys(slotsObj)) {
    if (Object.prototype.hasOwnProperty.call(slots, k)) continue;
    const v = slotsObj[k];
    if (typeof v === 'string') slots[k] = v;
  }
  return { ok: true, value: { slots } };
}

/**
 * Strip optional code fences / chatter and return the first balanced
 * `{…}` JSON object as a string. Returns null when no `{` is found.
 *
 * Balance-tracking is brace-depth only — string-literal escapes are
 * respected so a `"}"` inside a string does not close the object.
 * That's enough for well-formed LLM JSON; malformed JSON falls
 * through to `JSON.parse` which produces the actual parse-error
 * diagnostic.
 */
function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Drop ```json … ``` or ``` … ``` fences if the whole payload sits
  // inside them. Inner fences (rare) are left to the brace scanner.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const body = fence ? fence[1]! : trimmed;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
