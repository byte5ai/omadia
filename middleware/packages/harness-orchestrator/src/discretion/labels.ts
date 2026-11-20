/**
 * Discretion labels (spec 2042 §5.11, ADR-0019).
 *
 * Every piece of information an agent reads carries a label saying where it
 * came from and who may know it. A turn collects the union of everything it
 * read (the turn label set); every output of the turn carries the whole set,
 * because model output cannot be traced token by token. The strictest label
 * wins.
 *
 * This module is pure: no I/O, no turn context. It defines the label shapes,
 * the canonical label set and its (de)serialisation for persistence.
 */

/** Who may know a piece of information. */
export type Readers =
  /** Everyone in the tenant: no restriction from the context. */
  | { readonly kind: 'everyone' }
  /** Exactly these canonical omadia user ids. */
  | { readonly kind: 'set'; readonly ids: readonly string[] }
  /** Not known (incomplete roster, unresolved member): fails closed. */
  | { readonly kind: 'unknown' };

export const EVERYONE: Readers = { kind: 'everyone' };
export const UNKNOWN_READERS: Readers = { kind: 'unknown' };

export function readersOf(ids: readonly string[]): Readers {
  return { kind: 'set', ids: [...new Set(ids)].sort() };
}

/**
 * A label. Three kinds:
 * - `context`: the conversation or memory context the information entered
 *   from, with the people who may know it;
 * - `source`: the system a capability result came from. `restricted` marks a
 *   system the operator declared restricted: its data reaches no integration
 *   whose readership does not accept it;
 * - `classification`: classified data the model saw unmasked (today: personal
 *   fields a privacy-shield bypass let through).
 */
export type DiscretionLabel =
  | { readonly kind: 'context'; readonly key: string; readonly readers: Readers }
  | { readonly kind: 'source'; readonly system: string; readonly restricted: boolean }
  | { readonly kind: 'classification'; readonly class: string };

/** Identity of a label in a set: two labels with the same id merge. */
export function labelId(label: DiscretionLabel): string {
  switch (label.kind) {
    case 'context':
      return `context:${label.key}`;
    case 'source':
      return `source:${label.system}`;
    case 'classification':
      return `classification:${label.class}`;
  }
}

/** Readers allowed by both: the intersection. `unknown` absorbs everything. */
export function intersectReaders(a: Readers, b: Readers): Readers {
  if (a.kind === 'unknown' || b.kind === 'unknown') return UNKNOWN_READERS;
  if (a.kind === 'everyone') return b;
  if (b.kind === 'everyone') return a;
  const other = new Set(b.ids);
  return readersOf(a.ids.filter((id) => other.has(id)));
}

/**
 * True when every reader of `target` is among `allowed`. An `unknown` target
 * is only covered by `everyone`; an `unknown` allowance covers nothing.
 */
export function readersWithin(target: Readers, allowed: Readers): boolean {
  if (allowed.kind === 'everyone') return true;
  if (allowed.kind === 'unknown') return false;
  if (target.kind !== 'set') return false;
  const permitted = new Set(allowed.ids);
  return target.ids.every((id) => permitted.has(id));
}

function mergeLabel(a: DiscretionLabel, b: DiscretionLabel): DiscretionLabel {
  if (a.kind === 'context' && b.kind === 'context') {
    return { kind: 'context', key: a.key, readers: intersectReaders(a.readers, b.readers) };
  }
  if (a.kind === 'source' && b.kind === 'source') {
    return { kind: 'source', system: a.system, restricted: a.restricted || b.restricted };
  }
  return a;
}

/** An immutable, canonical set of labels (sorted by id, merged per id). */
export interface LabelSet {
  readonly labels: readonly DiscretionLabel[];
}

export const EMPTY_LABEL_SET: LabelSet = { labels: [] };

/** The union of `sets`, merged per label id (strictest wins). */
export function unionLabels(...sets: ReadonlyArray<LabelSet | readonly DiscretionLabel[]>): LabelSet {
  const byId = new Map<string, DiscretionLabel>();
  for (const set of sets) {
    const labels = Array.isArray(set) ? (set as readonly DiscretionLabel[]) : (set as LabelSet).labels;
    for (const label of labels) {
      const id = labelId(label);
      const existing = byId.get(id);
      byId.set(id, existing ? mergeLabel(existing, label) : label);
    }
  }
  const ids = [...byId.keys()].sort();
  return { labels: ids.map((id) => byId.get(id) as DiscretionLabel) };
}

export function isEmptyLabelSet(set: LabelSet): boolean {
  return set.labels.length === 0;
}

/** The label ids only: what an audit row records (never content). */
export function labelSummary(set: LabelSet): string[] {
  return set.labels.map(labelId);
}

// ── persistence ────────────────────────────────────────────────────────────

const MAX_PERSISTED_LABELS = 256;
const MAX_TEXT = 512;
const MAX_READERS = 1024;

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
}

function parseReaders(value: unknown): Readers | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { kind?: unknown; ids?: unknown };
  if (v.kind === 'everyone') return EVERYONE;
  if (v.kind === 'unknown') return UNKNOWN_READERS;
  if (v.kind === 'set' && Array.isArray(v.ids) && v.ids.length <= MAX_READERS && v.ids.every(isText)) {
    return readersOf(v.ids as string[]);
  }
  return undefined;
}

/** Parse persisted readers. Fails closed: anything invalid is unknown. */
export function parseStoredReaders(value: unknown): Readers {
  return parseReaders(value) ?? UNKNOWN_READERS;
}

function parseLabel(value: unknown): DiscretionLabel | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v['kind'] === 'context' && isText(v['key'])) {
    const readers = parseReaders(v['readers']);
    return readers ? { kind: 'context', key: v['key'], readers } : undefined;
  }
  if (v['kind'] === 'source' && isText(v['system']) && typeof v['restricted'] === 'boolean') {
    return { kind: 'source', system: v['system'], restricted: v['restricted'] };
  }
  if (v['kind'] === 'classification' && isText(v['class'])) {
    return { kind: 'classification', class: v['class'] };
  }
  return undefined;
}

/**
 * Parse a persisted label set. Fails closed: anything that is not a valid
 * label set becomes a single context label nobody is known to be allowed to
 * read, so a damaged row can never widen a flow.
 */
export function parseLabelSet(value: unknown): LabelSet {
  if (!Array.isArray(value) || value.length > MAX_PERSISTED_LABELS) return unreadableLabelSet();
  const labels: DiscretionLabel[] = [];
  for (const item of value) {
    const label = parseLabel(item);
    if (!label) return unreadableLabelSet();
    labels.push(label);
  }
  return unionLabels(labels);
}

function unreadableLabelSet(): LabelSet {
  return { labels: [{ kind: 'context', key: 'unreadable', readers: UNKNOWN_READERS }] };
}

/** The JSON form `parseLabelSet` reads back. */
export function serializeLabelSet(set: LabelSet): unknown[] {
  return set.labels.map((label) => ({ ...label }));
}
