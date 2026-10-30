/**
 * Field classification (#1556 follow-up) — what an Odoo field points to.
 *
 * Reads the SCHEMA only: one `fields_get` per source model, asking for the
 * `type`, `relation`, `string` and `help` attributes. No other Odoo method is
 * ever called through this module (a test pins that) — in particular no
 * `read`/`search_read`, so no record value crosses it.
 *
 * The Odoo integration plugin publishes its JSON-RPC client as the service
 * `odoo.client` and, since 0.5.0, its schema as `odoo.schema` (the read
 * whitelist + `fields_get` through the plugin's own guard: response cache,
 * HR red-line fields left out). Both are typed structurally here so the
 * kernel does not depend on that sibling package. A model the schema service
 * lists is read through it; any other model through `odoo.client`. An absent
 * service, an unknown model or a failed call all mean "relation unknown" —
 * never an error for the caller.
 *
 * One resolver per recompute: its cache lives exactly as long as that pass,
 * so a schema change in Odoo is picked up on the next one.
 */

/** The service name the Odoo integration plugin publishes its client under. */
export const ODOO_CLIENT_SERVICE_NAME = 'odoo.client';

/** The plugin that must own `odoo.client` / `odoo.schema` for the kernel to
 *  use them: service names are first-come, so any plugin could register one. */
export const ODOO_PLUGIN_ID = '@omadia/integration-odoo';

/** Bounds on what the schema service may make the kernel seed or send on. */
export const MAX_SCHEMA_MODELS = 200;
export const MAX_SCHEMA_FIELDS_PER_MODEL = 1_000;
export const MAX_SCHEMA_TOOLS_PER_MODEL = 4;
const MAX_HELP_LENGTH = 500;

/** The service name of the plugin's schema surface (`odoo.schema@1`). */
export const ODOO_SCHEMA_SERVICE_NAME = 'odoo.schema';

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

/** Structural view of the plugin's `OdooSchemaService` (`odoo.schema@1`). */
export interface OdooSchemaSource {
  listModels(): readonly { readonly model: string; readonly tools: readonly string[] }[];
  describeModel(model: string): Promise<
    readonly {
      readonly name: string;
      readonly type?: string;
      readonly relation?: string;
      readonly label?: string;
      readonly help?: string;
    }[]
  >;
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
  /** The field's own label (`string`), from the first model that has one. */
  readonly fieldLabel?: string;
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

/** Schema text from a provider: one bounded line, no control characters. */
function schemaText(value: unknown, max: number): string | undefined {
  const text = asString(value);
  // eslint-disable-next-line no-control-regex
  if (text === undefined || /[\u0000-\u001f\u007f]/u.test(text)) return undefined;
  return text.slice(0, max);
}

function parseSchemaFields(raw: unknown): ReadonlyMap<string, OdooFieldMeta> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = new Map<string, OdooFieldMeta>();
  for (const f of (raw as unknown[]).slice(0, MAX_SCHEMA_FIELDS_PER_MODEL)) {
    if (typeof f !== 'object' || f === null) continue;
    const a = f as Record<string, unknown>;
    const name = asString(a['name']);
    if (name === undefined) continue;
    const type = asString(a['type']);
    // A relation is a model name or nothing: never free text towards the
    // schema model or the page.
    const rawRelation = asString(a['relation']);
    const relation = rawRelation !== undefined && MODEL_NAME.test(rawRelation) ? rawRelation : undefined;
    const label = schemaText(a['label'], MAX_HELP_LENGTH);
    const help = schemaText(a['help'], MAX_HELP_LENGTH);
    out.set(name, {
      ...(type !== undefined ? { type } : {}),
      ...(relation !== undefined ? { relation } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(help !== undefined ? { help } : {}),
    });
  }
  return out;
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

/** A provider's error as one quoted, bounded log fragment. */
function errorLine(err: unknown): string {
  return JSON.stringify(err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** The models the schema service lists; empty when it is absent or broken. */
export function schemaModelsOf(
  schema: OdooSchemaSource | undefined,
  log?: (msg: string) => void,
): readonly { readonly model: string; readonly tools: readonly string[] }[] {
  if (schema === undefined) return [];
  try {
    const models: unknown = schema.listModels();
    if (!Array.isArray(models)) return [];
    const out: { model: string; tools: string[] }[] = [];
    for (const m of models as unknown[]) {
      if (out.length >= MAX_SCHEMA_MODELS) break;
      if (typeof m !== 'object' || m === null) continue;
      const { model, tools } = m as { model?: unknown; tools?: unknown };
      if (typeof model !== 'string' || !MODEL_NAME.test(model) || !Array.isArray(tools)) continue;
      out.push({
        model,
        tools: (tools as unknown[])
          .filter((t): t is string => typeof t === 'string')
          .slice(0, MAX_SCHEMA_TOOLS_PER_MODEL),
      });
    }
    return out;
  } catch (err) {
    log?.(`[privacy-fields] odoo.schema listModels failed: ${errorLine(err)}`);
    return [];
  }
}

export function createOdooRelationResolver(
  client: OdooExecuteClient | undefined,
  opts: { readonly log?: (msg: string) => void; readonly schema?: OdooSchemaSource } = {},
): OdooRelationResolver {
  const cache = new Map<string, Promise<ReadonlyMap<string, OdooFieldMeta> | undefined>>();
  const schemaModels = new Set(schemaModelsOf(opts.schema, opts.log).map((m) => m.model));

  async function loadFromSchema(
    schema: OdooSchemaSource,
    model: string,
  ): Promise<ReadonlyMap<string, OdooFieldMeta> | undefined> {
    try {
      return parseSchemaFields(await schema.describeModel(model));
    } catch (err) {
      opts.log?.(
        `[privacy-fields] odoo.schema describeModel failed for ${JSON.stringify(model)}: ${errorLine(err)}`,
      );
      return undefined;
    }
  }

  async function load(model: string): Promise<ReadonlyMap<string, OdooFieldMeta> | undefined> {
    if (!MODEL_NAME.test(model)) return undefined;
    if (opts.schema !== undefined && schemaModels.has(model)) return loadFromSchema(opts.schema, model);
    if (client === undefined) return undefined;
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
    let fieldLabel: string | undefined;
    for (const model of sourceModels) {
      const fields = await fieldsOf(model);
      // One unreadable source model makes the whole field unknown: a partial
      // answer could miss the one source whose field points to a person.
      if (fields === undefined) return UNKNOWN_RELATION;
      const meta = fields.get(fieldPath);
      fieldLabel ??= meta?.label;
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
    return {
      known: true,
      relationModels: [...relations].sort(),
      ...(fieldLabel !== undefined ? { fieldLabel } : {}),
      fieldDocs,
    };
  }

  return { fieldsOf, resolve };
}
