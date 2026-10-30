/**
 * Field classification (#1556 follow-up) — what an Odoo field points to.
 *
 * Reads the SCHEMA only: one `fields_get` per source model, asking for the
 * `type`, `relation`, `string` and `help` attributes. No other Odoo method is
 * ever called through this module (a test pins that) — in particular no
 * `read`/`search_read`, so no record value crosses it.
 *
 * The Odoo integration plugin publishes its JSON-RPC client as the service
 * `odoo.client`; it is typed structurally here so the kernel does not depend
 * on that sibling package. An absent client, an unknown model or a failed
 * call all mean "relation unknown" — never an error for the caller.
 *
 * One resolver per recompute: its cache lives exactly as long as that pass,
 * so a schema change in Odoo is picked up on the next one.
 */

/** The service name the Odoo integration plugin publishes its client under. */
export const ODOO_CLIENT_SERVICE_NAME = 'odoo.client';

/** The one method this module calls. */
export const FIELDS_GET_METHOD = 'fields_get';

const FIELDS_GET_ATTRIBUTES = ['type', 'relation', 'string', 'help'] as const;

/** Structural view of the Odoo plugin's `OdooClient.execute`. */
export interface OdooExecuteClient {
  execute(req: {
    model: string;
    method: string;
    positionalArgs: unknown[];
    kwargs: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface OdooFieldMeta {
  readonly type?: string;
  readonly relation?: string;
  readonly label?: string;
  readonly help?: string;
}

/** What one field resolves to across all its source models. */
export interface FieldRelationInfo {
  /** True only when EVERY source model's schema was read. */
  readonly known: boolean;
  /** Distinct relation targets, sorted. Empty for a non-relational field. */
  readonly relationModels: readonly string[];
  /** Label/help per relation target, for the schema-only model verdict. */
  readonly fieldDocs: readonly {
    readonly relation: string;
    readonly label?: string;
    readonly help?: string;
  }[];
}

export interface OdooRelationResolver {
  fieldsOf(model: string): Promise<ReadonlyMap<string, OdooFieldMeta> | undefined>;
  resolve(sourceModels: readonly string[], fieldPath: string): Promise<FieldRelationInfo>;
}

const UNKNOWN_RELATION: FieldRelationInfo = { known: false, relationModels: [], fieldDocs: [] };

const RELATIONAL_TYPES: ReadonlySet<string> = new Set(['many2one', 'one2many', 'many2many']);

/** Odoo model names: dotted lowercase identifiers. Anything else is not sent. */
export const MODEL_NAME = /^[a-z_][a-z0-9_]*(\.[a-z0-9_]+)*$/u;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseFieldsGet(raw: unknown): ReadonlyMap<string, OdooFieldMeta> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out = new Map<string, OdooFieldMeta>();
  for (const [name, attrs] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof attrs !== 'object' || attrs === null) continue;
    const a = attrs as Record<string, unknown>;
    const type = asString(a['type']);
    const relation = asString(a['relation']);
    const label = asString(a['string']);
    const help = asString(a['help']);
    out.set(name, {
      ...(type !== undefined ? { type } : {}),
      ...(relation !== undefined ? { relation } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(help !== undefined ? { help } : {}),
    });
  }
  return out;
}

export function createOdooRelationResolver(
  client: OdooExecuteClient | undefined,
  opts: { readonly log?: (msg: string) => void } = {},
): OdooRelationResolver {
  const cache = new Map<string, Promise<ReadonlyMap<string, OdooFieldMeta> | undefined>>();

  async function load(model: string): Promise<ReadonlyMap<string, OdooFieldMeta> | undefined> {
    if (client === undefined || !MODEL_NAME.test(model)) return undefined;
    try {
      const raw = await client.execute({
        model,
        method: FIELDS_GET_METHOD,
        positionalArgs: [],
        kwargs: { attributes: [...FIELDS_GET_ATTRIBUTES] },
      });
      return parseFieldsGet(raw);
    } catch (err) {
      opts.log?.(
        `[privacy-fields] fields_get failed for ${JSON.stringify(model)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  function fieldsOf(model: string): Promise<ReadonlyMap<string, OdooFieldMeta> | undefined> {
    let pending = cache.get(model);
    if (pending === undefined) {
      pending = load(model);
      cache.set(model, pending);
    }
    return pending;
  }

  async function resolve(
    sourceModels: readonly string[],
    fieldPath: string,
  ): Promise<FieldRelationInfo> {
    const relations = new Set<string>();
    const fieldDocs: { relation: string; label?: string; help?: string }[] = [];
    for (const model of sourceModels) {
      const fields = await fieldsOf(model);
      // One unreadable source model makes the whole field unknown: a partial
      // answer could miss the one source whose field points to a person.
      if (fields === undefined) return UNKNOWN_RELATION;
      const meta = fields.get(fieldPath);
      if (meta?.relation === undefined) continue;
      if (meta.type !== undefined && !RELATIONAL_TYPES.has(meta.type)) continue;
      relations.add(meta.relation);
      fieldDocs.push({
        relation: meta.relation,
        ...(meta.label !== undefined ? { label: meta.label } : {}),
        ...(meta.help !== undefined ? { help: meta.help } : {}),
      });
    }
    if (sourceModels.length === 0) return UNKNOWN_RELATION;
    return { known: true, relationModels: [...relations].sort(), fieldDocs };
  }

  return { fieldsOf, resolve };
}
