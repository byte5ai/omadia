// Workflow-template slot machinery (issue #429). Pure functions, no I/O — matching the
// package's character. A TemplateManifest is a complete WorkflowGraph whose external
// references are replaced by `slot:<kind-singular>:<key>` placeholder strings, plus a
// slot declaration; instantiation substitutes an operator-supplied slot→entity mapping
// into the five ref fields and hands the result to the ordinary validate()/publish path.
//
// Substitution is a structural walk of the ref fields — NEVER a string-replace over
// serialized JSON. `step.prompt` / `human.message` use `{{ctx.path}}` run-context
// interpolation and are deliberately untouched.

import type {
  LocalizedText,
  Step,
  TemplateManifest,
  TemplateMissingSlot,
  TemplateSlot,
  TemplateSlotKind,
  TemplateSlotMapping,
  TemplateSlotRef,
  Trigger,
  ValidationError,
  ValidationResult,
  WorkflowGraph,
} from './types.js';
import { validate } from './validate.js';

const SLOT_PREFIX = 'slot:';

/** kind (plural, as declared in TemplateSlots) → placeholder token (singular). */
const SLOT_TOKEN: Record<TemplateSlotKind, string> = {
  agents: 'agent',
  actions: 'action',
  roles: 'role',
  events: 'event',
  channels: 'channel',
};

const SLOT_KINDS = Object.keys(SLOT_TOKEN) as TemplateSlotKind[];

/**
 * Resolve manifest-borne localizable text to a display string. Plain strings pass
 * through unchanged; localized records resolve `locale` first (exact key) and fall
 * back to the required `en` base -- also for blank entries. Template metadata is
 * data, so localization travels with the manifest and is resolved at render time.
 */
export function resolveLocalizedText(value: LocalizedText, locale?: string): string {
  if (typeof value === 'string') return value;
  const localized = locale ? value[locale] : undefined;
  return typeof localized === 'string' && localized.trim().length > 0 ? localized : value.en;
}

/** Why `value` is not valid LocalizedText, or null when it is: a non-empty string, or
 *  a locale record whose entries are all non-empty strings with `en` present. */
function localizedTextProblem(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().length > 0 ? null : 'is empty';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'must be a non-empty string or an { en, ... } locale record';
  }
  const record = value as Record<string, unknown>;
  if (typeof record['en'] !== 'string' || record['en'].trim().length === 0) {
    return "must carry a non-empty 'en' entry (the required fallback locale)";
  }
  for (const [locale, text] of Object.entries(record)) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return `carries a non-string or empty '${locale}' entry`;
    }
  }
  return null;
}

/** Parse `value` as a placeholder of `kind`. Returns the slot key, or null when the
 *  value is not a placeholder of that kind (including plain non-slot refs). */
function parsePlaceholder(value: string, kind: TemplateSlotKind): string | null {
  const prefix = `${SLOT_PREFIX}${SLOT_TOKEN[kind]}:`;
  if (!value.startsWith(prefix)) return null;
  const key = value.slice(prefix.length);
  return key.length > 0 ? key : null;
}

/** One placeholder-bearing ref field: where it lives, its expected kind, its value,
 *  and a setter for substitution. */
interface SlotField {
  nodeId: string;
  kind: TemplateSlotKind;
  value: string;
  set: (next: string) => void;
}

/** Enumerate the five ref fields that may carry placeholders. Structural — prompt and
 *  human.message are never visited. */
function slotFields(graph: WorkflowGraph): SlotField[] {
  const fields: SlotField[] = [];
  for (const step of graph.steps) {
    const s: Step = step;
    if (typeof s.agentId === 'string') {
      fields.push({ nodeId: s.id, kind: 'agents', value: s.agentId, set: (next) => { s.agentId = next; } });
    }
    if (typeof s.actionId === 'string') {
      fields.push({ nodeId: s.id, kind: 'actions', value: s.actionId, set: (next) => { s.actionId = next; } });
    }
    const human = s.human;
    if (human) {
      if (human.principal.kind === 'role') {
        fields.push({ nodeId: s.id, kind: 'roles', value: human.principal.ref, set: (next) => { human.principal.ref = next; } });
      }
      fields.push({ nodeId: s.id, kind: 'channels', value: human.channel, set: (next) => { human.channel = next; } });
    }
  }
  for (const trigger of graph.triggers ?? []) {
    const t: Trigger = trigger;
    if (t.kind === 'event' && typeof t.eventId === 'string') {
      fields.push({ nodeId: t.id, kind: 'events', value: t.eventId, set: (next) => { t.eventId = next; } });
    }
  }
  return fields;
}

/**
 * Find every `slot:<kind>:<key>` placeholder in the graph's ref fields, grouped by
 * (kind, key) with the ids of all referencing steps/triggers. Order follows first
 * appearance. Placeholder-looking substrings inside `prompt` / `human.message` are
 * ignored by construction.
 */
export function extractSlotRefs(graph: WorkflowGraph): TemplateSlotRef[] {
  const byId = new Map<string, TemplateSlotRef>();
  for (const field of slotFields(graph)) {
    const key = parsePlaceholder(field.value, field.kind);
    if (key === null) continue;
    const mapKey = `${field.kind} ${key}`;
    const existing = byId.get(mapKey);
    if (existing) {
      if (!existing.nodeIds.includes(field.nodeId)) existing.nodeIds.push(field.nodeId);
    } else {
      byId.set(mapKey, { kind: field.kind, key, nodeIds: [field.nodeId] });
    }
  }
  return [...byId.values()];
}

function mappedValue(mapping: TemplateSlotMapping, kind: TemplateSlotKind, key: string): string | null {
  const value = mapping[kind]?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Every declared slot without a non-empty mapping value. An empty / whitespace-only
 * mapping value counts as missing. Callers gate instantiation on this returning [].
 */
export function missingSlotMappings(manifest: TemplateManifest, mapping: TemplateSlotMapping): TemplateMissingSlot[] {
  const missing: TemplateMissingSlot[] = [];
  for (const kind of SLOT_KINDS) {
    for (const slot of manifest.slots[kind] ?? []) {
      if (mappedValue(mapping, kind, slot.key) === null) {
        // Wire envelopes stay flat English strings; clients localize via kind+key.
        missing.push({ kind, key: slot.key, label: resolveLocalizedText(slot.label) });
      }
    }
  }
  return missing;
}

/**
 * Substitute the mapping into a deep clone of `manifest.graph` (the manifest is never
 * mutated) and return the resulting ordinary graph. Field-targeted: only the five ref
 * fields are touched. Throws TypeError when a placeholder has no (non-empty) mapping
 * value or is malformed for its field — callers must gate on missingSlotMappings /
 * checkTemplateManifest first.
 */
export function applyTemplateSlots(manifest: TemplateManifest, mapping: TemplateSlotMapping): WorkflowGraph {
  const graph = structuredClone(manifest.graph);
  for (const field of slotFields(graph)) {
    if (!field.value.startsWith(SLOT_PREFIX)) continue;
    const key = parsePlaceholder(field.value, field.kind);
    if (key === null) {
      throw new TypeError(
        `template '${manifest.id}': node '${field.nodeId}' carries malformed ${field.kind} placeholder '${field.value}' (expected 'slot:${SLOT_TOKEN[field.kind]}:<key>')`,
      );
    }
    const value = mappedValue(mapping, field.kind, key);
    if (value === null) {
      throw new TypeError(`template '${manifest.id}': no mapping for ${field.kind} slot '${key}' (node '${field.nodeId}')`);
    }
    field.set(value);
  }
  return graph;
}

/**
 * Manifest integrity gate (the CI test over the bundled catalog runs this):
 * 1. metadata non-empty -- `id`/`defaultSlug` plain strings, `name`/`description`/
 *    `useCase` localizable (plain string or `{ en, de?, ... }` with `en` required);
 * 2. `graph` passes the structural validate() (shape gate included; placeholders are
 *    plain strings, so a well-formed template passes without KnownRefs);
 * 3. no duplicate slot keys within a kind;
 * 4. bidirectional slot coverage — every placeholder has a declared slot AND every
 *    declared slot is used by at least one placeholder;
 * 5. no malformed `slot:`-prefixed value in a ref field (wrong kind token / empty key).
 */
export function checkTemplateManifest(manifest: TemplateManifest): ValidationResult {
  const errors: ValidationError[] = [];

  // id / defaultSlug are machine identifiers -- always plain strings. name /
  // description / useCase are operator-facing and may be localized records.
  const emptyMeta: string[] = (['id', 'defaultSlug'] as const).filter(
    (field) => typeof manifest[field] !== 'string' || manifest[field].trim().length === 0,
  );
  for (const field of ['name', 'description'] as const) {
    const value: unknown = manifest[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
      emptyMeta.push(field);
      continue;
    }
    const problem = localizedTextProblem(value);
    if (problem !== null) {
      errors.push({
        code: 'template_invalid_localized_text',
        message: `template manifest field '${field}' ${problem}`,
        nodeIds: [],
      });
    }
  }
  // useCase was never hard-required here; only its localized shape is checked when present.
  if (manifest.useCase !== undefined) {
    const problem = localizedTextProblem(manifest.useCase);
    if (problem !== null) {
      errors.push({
        code: 'template_invalid_localized_text',
        message: `template manifest field 'useCase' ${problem}`,
        nodeIds: [],
      });
    }
  }
  if (emptyMeta.length) {
    errors.push({
      code: 'template_missing_metadata',
      message: `template manifest field(s) missing or empty: ${emptyMeta.join(', ')}`,
      nodeIds: [],
    });
  }

  const graphResult = validate(manifest.graph);
  errors.push(...graphResult.errors);
  // On a shape failure the graph cannot be walked structurally — slot checks would be noise.
  const shapeOk = !graphResult.errors.some((e) => e.code === 'shape');

  const declared = new Map<string, TemplateSlot & { kind: TemplateSlotKind }>();
  for (const kind of SLOT_KINDS) {
    const seen = new Set<string>();
    for (const slot of manifest.slots[kind] ?? []) {
      if (seen.has(slot.key)) {
        errors.push({
          code: 'template_duplicate_slot_key',
          message: `duplicate ${kind} slot key '${slot.key}'`,
          nodeIds: [`slot:${SLOT_TOKEN[kind]}:${slot.key}`],
        });
      }
      seen.add(slot.key);
      const labelProblem = localizedTextProblem(slot.label);
      if (labelProblem !== null) {
        errors.push({
          code: 'template_invalid_localized_text',
          message: `${kind} slot '${slot.key}' label ${labelProblem}`,
          nodeIds: [`slot:${SLOT_TOKEN[kind]}:${slot.key}`],
        });
      }
      if (slot.description !== undefined) {
        const descriptionProblem = localizedTextProblem(slot.description);
        if (descriptionProblem !== null) {
          errors.push({
            code: 'template_invalid_localized_text',
            message: `${kind} slot '${slot.key}' description ${descriptionProblem}`,
            nodeIds: [`slot:${SLOT_TOKEN[kind]}:${slot.key}`],
          });
        }
      }
      declared.set(`${kind} ${slot.key}`, { ...slot, kind });
    }
  }

  if (shapeOk) {
    const refs = extractSlotRefs(manifest.graph);
    const used = new Set(refs.map((r) => `${r.kind} ${r.key}`));
    for (const ref of refs) {
      if (!declared.has(`${ref.kind} ${ref.key}`)) {
        errors.push({
          code: 'template_undeclared_slot',
          message: `graph references undeclared ${ref.kind} slot '${ref.key}'`,
          nodeIds: ref.nodeIds,
        });
      }
    }
    for (const [mapKey, slot] of declared) {
      if (!used.has(mapKey)) {
        errors.push({
          code: 'template_unused_slot',
          message: `declared ${slot.kind} slot '${slot.key}' is not referenced by any placeholder in the graph`,
          nodeIds: [`slot:${SLOT_TOKEN[slot.kind]}:${slot.key}`],
        });
      }
    }
    for (const field of slotFields(manifest.graph)) {
      if (field.value.startsWith(SLOT_PREFIX) && parsePlaceholder(field.value, field.kind) === null) {
        errors.push({
          code: 'template_malformed_slot_ref',
          message: `node '${field.nodeId}' carries '${field.value}' in a ${field.kind} ref field (expected 'slot:${SLOT_TOKEN[field.kind]}:<key>' or a plain ref)`,
          nodeIds: [field.nodeId],
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
