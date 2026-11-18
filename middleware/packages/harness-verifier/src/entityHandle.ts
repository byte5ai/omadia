/**
 * Entity handles as the claim extractor emits them in `related_entities`:
 * `system:model:id` (canonical, e.g. `odoo:res.partner:42`), `model:id`
 * (`hr.employee:7`), a system-qualified model (`odoo:res.partner`) or a bare
 * model (`hr.department`).
 *
 * A handle that carries an id names ONE record. Whatever turns it into
 * evidence resolves exactly that record and re-checks the identity of what
 * the graph hands back ({@link matchesRecord}); it never substitutes another
 * record of the same model. Graph entity node ids use the same shape
 * (`entityNodeId` in plugin-api: `${system}:${model}:${id}`), so a cited
 * evidence node id parses with the same function.
 */

/** Source systems whose entities `findEntities` can return. Reserved by the
 *  graph (plugin entities may not use them), so a two-part handle starting
 *  with one of them is `system:model`, not `model:id`. */
const ENTITY_SYSTEMS: ReadonlySet<string> = new Set(['odoo', 'confluence']);

export interface EntityHandle {
  /** Source system, when the handle names it (`odoo`, `confluence`, …). */
  readonly system?: string;
  readonly model: string;
  /** Source-system record id, kept as a string. Absent for a model handle. */
  readonly id?: string;
}

/** A handle that names one record. */
export type RecordHandle = EntityHandle & { readonly id: string };

/** Parse a handle; `null` for an empty string. Never throws. */
export function parseEntityHandle(raw: string): EntityHandle | null {
  const parts = raw
    .split(':')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const [first, second] = parts;
  if (first === undefined) return null;
  if (second === undefined) return { model: first };
  if (parts.length === 2) {
    return ENTITY_SYSTEMS.has(first)
      ? { system: first, model: second }
      : { model: first, id: second };
  }
  // Everything after the model is the id: an id that itself contains ':'
  // stays whole and matches nothing, instead of resolving a prefix of it.
  return { system: first, model: second, id: parts.slice(2).join(':') };
}

export function isRecordHandle(handle: EntityHandle): handle is RecordHandle {
  return handle.id !== undefined;
}

/**
 * True when `raw` names one record of a known source system
 * (`odoo:res.partner:42`, `confluence:page:7`). A `[ref:…]` marker id of any
 * other shape — a turn ref (`turn:<scope>:<time>`), a bare node id
 * (`n_emp_anna`) — pins no record the evidence fetcher can look up.
 */
export function isSystemRecordHandle(raw: string): boolean {
  const handle = parseEntityHandle(raw);
  return (
    handle !== null &&
    isRecordHandle(handle) &&
    handle.system !== undefined &&
    ENTITY_SYSTEMS.has(handle.system)
  );
}

/**
 * True when `node` is exactly the record `handle` names: same model, same id
 * (string-compared) and, for a handle that names its system, same system.
 * Applied to whatever a lookup returns, because the `knowledgeGraph`
 * capability is plugin-provided and a provider built against the contract
 * before `FindEntitiesOptions.id` existed ignores the option.
 */
export function matchesRecord(
  node: { readonly props?: Readonly<Record<string, unknown>> },
  handle: RecordHandle,
): boolean {
  const props = node.props ?? {};
  if (asText(props['model']) !== handle.model) return false;
  if (asText(props['id']).trim() !== handle.id) return false;
  return handle.system === undefined || asText(props['system']) === handle.system;
}

/**
 * True when `citedNodeId` is a record of a model that `relatedEntities` pins
 * by id, but not one of the pinned records — a different entity than the
 * one the claim is about, which can neither verify nor contradict it. Node
 * ids without a `model:id` shape (`n_emp_anna`) are not judged here.
 */
export function citesOtherRecord(
  relatedEntities: readonly string[],
  citedNodeId: string | undefined,
): boolean {
  if (citedNodeId === undefined) return false;
  const cited = parseEntityHandle(citedNodeId);
  if (cited === null || !isRecordHandle(cited)) return false;
  let pinsModel = false;
  for (const raw of relatedEntities) {
    const pinned = parseEntityHandle(raw);
    if (pinned === null || !isRecordHandle(pinned)) continue;
    if (pinned.model !== cited.model) continue;
    pinsModel = true;
    const sameSystem =
      pinned.system === undefined ||
      cited.system === undefined ||
      pinned.system === cited.system;
    if (pinned.id === cited.id && sameSystem) return false;
  }
  return pinsModel;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}
