// Text-slot machinery (issue #478): `slot:text:<key>` tokens inside DESIGNATED text
// fields, substituted at instantiation from `TemplateSlotMapping.text` (or a declared
// default). Split out of template.ts to keep both files under the 500-line budget.
//
// Explicitly disjoint from `{{...}}` run-context interpolation (renderTemplate in the
// middleware's realStepEffects.ts): text slots are resolved ONCE at instantiation with
// operator-supplied install text, while `{{ctx.*}}` / `{{steps.*}}` survive into the
// instantiated graph and are rendered per run. The grammars cannot collide -- a text
// token is exactly `slot:text:` followed by a `[A-Za-z0-9_-]+` key.
//
// TEXT_SLOT_FIELDS: the only fields walked for tokens are `step.prompt` (agent steps)
// and `step.human.message` (human steps) -- the two operator-authored prose fields of
// conductorGraphSchema. Substitution is a structural walk over these fields replacing
// token occurrences with mapped values; NEVER a string-replace over serialized JSON,
// and never a walk of arbitrary strings (ids, channels, cron, ... are ref/config
// territory).

import type { TemplateManifest, TemplateSlotMapping, WorkflowGraph } from './types.js';

/** Token prefix for text slots; the full token is `slot:text:<key>`. */
export const TEXT_SLOT_PREFIX = 'slot:text:';

/** Token grammar. Keys are `[A-Za-z0-9_-]+`; anything else ends the token. */
const TEXT_SLOT_TOKEN = /slot:text:([A-Za-z0-9_-]+)/g;

/** One designated text field: where it lives, its value, and a setter. */
interface TextField {
  nodeId: string;
  value: string;
  set: (next: string) => void;
}

/** Enumerate the designated text fields (TEXT_SLOT_FIELDS): `step.prompt` and
 *  `step.human.message`. Structural -- no other string is ever visited. */
function textSlotFields(graph: WorkflowGraph): TextField[] {
  const fields: TextField[] = [];
  for (const step of graph.steps) {
    const s = step;
    if (typeof s.prompt === 'string') {
      fields.push({ nodeId: s.id, value: s.prompt, set: (next) => { s.prompt = next; } });
    }
    const human = s.human;
    if (human && typeof human.message === 'string') {
      fields.push({ nodeId: s.id, value: human.message, set: (next) => { human.message = next; } });
    }
  }
  return fields;
}

/** One text-slot token found in a template graph, with every step referencing it. */
export interface TemplateTextSlotRef {
  key: string;
  /** steps whose designated text field carries the token. */
  nodeIds: string[];
}

/**
 * Find every `slot:text:<key>` token in the designated text fields, grouped by key
 * with the ids of all referencing steps. Order follows first appearance. Ref-style
 * tokens (`slot:agent:...`) and `{{...}}` interpolation are ignored by construction.
 */
export function extractTextSlotRefs(graph: WorkflowGraph): TemplateTextSlotRef[] {
  const byKey = new Map<string, TemplateTextSlotRef>();
  for (const field of textSlotFields(graph)) {
    for (const match of field.value.matchAll(TEXT_SLOT_TOKEN)) {
      const key = match[1]!;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.nodeIds.includes(field.nodeId)) existing.nodeIds.push(field.nodeId);
      } else {
        byKey.set(key, { key, nodeIds: [field.nodeId] });
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Substitute text-slot tokens in `graph`'s designated text fields, in place (callers
 * pass the already-cloned graph -- applyTemplateSlots owns the clone). Value per key:
 * the non-empty `mapping.text[key]`, else the declared slot's `default`. Throws
 * TypeError when a token has neither -- callers gate on missingSlotMappings /
 * checkTemplateManifest first, exactly like the ref path.
 */
export function applyTextSlots(
  graph: WorkflowGraph,
  manifest: TemplateManifest,
  mapping: TemplateSlotMapping,
): void {
  const defaults = new Map<string, string>();
  for (const slot of manifest.slots.text ?? []) {
    if (typeof slot.default === 'string') defaults.set(slot.key, slot.default);
  }
  for (const field of textSlotFields(graph)) {
    if (!field.value.includes(TEXT_SLOT_PREFIX)) continue;
    field.set(
      field.value.replace(TEXT_SLOT_TOKEN, (_token, key: string) => {
        const mapped = mapping.text?.[key];
        if (typeof mapped === 'string' && mapped.trim().length > 0) return mapped;
        const fallback = defaults.get(key);
        if (fallback !== undefined) return fallback;
        throw new TypeError(
          `template '${manifest.id}': no mapping for text slot '${key}' (node '${field.nodeId}')`,
        );
      }),
    );
  }
}
