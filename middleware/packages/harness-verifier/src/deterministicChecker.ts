import type {
  Claim,
  ClaimVerdict,
  HardClaim,
  OdooRecordRef,
} from './claimTypes.js';
import { SOFT_ANCHOR_REF_FIELDS, hasOdooRecordAnchor } from './claimTypes.js';
import { matchesRecord, type RecordHandle } from './entityHandle.js';
import {
  claimNamesPeriod,
  nameClaimMatches,
  turnRecordIdsByModel,
  type TurnRecord,
} from './turnRecords.js';

/**
 * Deterministic verifier for HardClaims. Runs an INDEPENDENT read-only
 * re-query against the authoritative source (Odoo or the knowledge graph)
 * and compares the result to the claim. Never mutates.
 *
 * Independence is the whole point: we don't reuse whatever tool output the
 * orchestrator had during the first pass — a second query fresh from the
 * DB is what catches "orchestrator read the right record but then
 * reported the wrong field" class of hallucinations.
 *
 * Design choices:
 *  - The checker is domain-agnostic. HR-specific behaviour (always
 *    re-compute aggregates in JS, never trust LLM arithmetic) is encoded
 *    as a generic rule on `type === 'aggregate'`, not an `if (agent ===
 *    'hr')` branch — the `hr.*` model prefix in `odooRecord.model` is the
 *    real trigger.
 *  - On transient failure (network, timeout, rate limit) we return
 *    `unverified` with `cause: 'check_failed'`, not `contradicted`. The
 *    pipeline's aggregator decides whether that degrades the final verdict
 *    to `approved_with_disclaimer`; a failed check is never evidence.
 *  - Monetary tolerance is 0.01 € (one cent). Dates are compared as
 *    ISO strings, ids as exact matches.
 *  - #1574 — a claim that names no record id is anchored on the records the
 *    turn's own tools read (`CheckContext.turnRecords`): those are re-read
 *    from Odoo here, and the claim is confirmed when one of them carries the
 *    claimed value. Such a match only ever confirms; a miss stays
 *    `unverified`, since the claim may be about another record.
 *  - #1575 — an aggregate is only compared with the records it is about: one
 *    employee / partner (from the claim, else from the turn's records), the
 *    request states that count, and — for a claim that names a period — the
 *    records the turn read. When the check cannot tell which records a total
 *    covers, the claim is `unverified`, never `contradicted`.
 */

/** Minimal read-only slice of `OdooClient` — narrowed so tests can stub it. */
export interface OdooReader {
  execute(req: {
    model: string;
    method: string;
    positionalArgs: unknown[];
    kwargs: Record<string, unknown>;
  }): Promise<unknown>;
}

/** Minimal slice of `KnowledgeGraph` used for id/name verification. */
export interface GraphReader {
  findEntities(opts: {
    model: string;
    /** Exact source-system id (`FindEntitiesOptions.id`, plugin-api 1.21.0). */
    id?: string | number;
    nameContains?: string;
    limit?: number;
  }): Promise<
    Array<{ id: string; props?: Readonly<Record<string, unknown>> }>
  >;
}

/** What a check may use beyond the claim itself. */
export interface CheckContext {
  /** #1574 — the Odoo records the checked turn's tools read. */
  readonly turnRecords?: readonly TurnRecord[];
}

export interface DeterministicCheckerOptions {
  odoo?: OdooReader;
  graph?: GraphReader;
  /** Numeric tolerance for amount / aggregate equality (absolute). */
  amountTolerance?: number;
  log?: (msg: string) => void;
}

const DEFAULTS = {
  amountTolerance: 0.01,
};

/**
 * Heuristic map from Odoo model → canonical "amount" field. Used when the
 * claim refers to a record but the extractor did not pin down which field
 * carries the amount. Conservative on purpose: unknown models fall through
 * to `unverified` rather than guessing the wrong field.
 */
const AMOUNT_FIELD_BY_MODEL: Readonly<Record<string, string>> = {
  'account.move': 'amount_total',
  'account.move.line': 'balance',
  'sale.order': 'amount_total',
  'purchase.order': 'amount_total',
  'hr.leave': 'number_of_days',
  'hr.expense': 'total_amount',
};

/** Date fields per model, in the order a claim is compared with them. A leave
 *  has a first and a last day: `request_date_*` are plain dates, `date_*`
 *  datetimes in UTC (whose day can be off by one), so the dates come first. */
const DATE_FIELDS_BY_MODEL: Readonly<Record<string, readonly string[]>> = {
  'account.move': ['invoice_date'],
  'sale.order': ['date_order'],
  'purchase.order': ['date_order'],
  'hr.leave': ['request_date_from', 'request_date_to', 'date_from', 'date_to'],
  'hr.expense': ['date'],
};

/**
 * #1575 — the field that ties an aggregated record to the one employee or
 * partner its total is about, and the model that field points to.
 */
const AGGREGATE_SCOPE_BY_MODEL: Readonly<Record<string, { field: string; model: string }>> = {
  'hr.leave': { field: 'employee_id', model: 'hr.employee' },
  'hr.expense': { field: 'employee_id', model: 'hr.employee' },
  'account.move': { field: 'partner_id', model: 'res.partner' },
  'sale.order': { field: 'partner_id', model: 'res.partner' },
  'purchase.order': { field: 'partner_id', model: 'res.partner' },
};

/**
 * #1575 — the request states a total may count, per model. A leave total
 * usually means approved days (`validate`), or approved plus pending ones.
 * An answer may also state a total that counts every request ("counting the
 * refused one too, it is 58.35 days") — `undefined` is that reading. Each set
 * is one candidate total; a claim is contradicted only when no reading of
 * the records supports it, so a correct total is never withheld for counting
 * requests the default reading leaves out.
 */
const AGGREGATE_STATE_SETS: Readonly<
  Record<string, ReadonlyArray<readonly string[] | undefined>>
> = {
  'hr.leave': [['validate'], ['validate', 'validate1', 'confirm'], undefined],
};

/**
 * #1579 — a total "of" a record whose model holds no amount is a total of
 * the records that belong to it: an employee's leave days are `hr.leave`
 * rows. The extractor pins the claim on the record it names (the employee),
 * not on the rows it sums.
 */
const AGGREGATE_MODEL_FOR_OWNER: Readonly<Record<string, string>> = {
  'hr.employee': 'hr.leave',
};

/** Models whose amount / date the turn-record anchor can compare. */
const AMOUNT_MODELS: ReadonlySet<string> = new Set(Object.keys(AMOUNT_FIELD_BY_MODEL));
const DATE_MODELS: ReadonlySet<string> = new Set(Object.keys(DATE_FIELDS_BY_MODEL));

export class DeterministicChecker {
  private readonly tolerance: number;
  private readonly log: (msg: string) => void;
  private readonly odoo?: OdooReader;
  private readonly graph?: GraphReader;

  constructor(opts: DeterministicCheckerOptions) {
    this.odoo = opts.odoo;
    this.graph = opts.graph;
    this.tolerance = opts.amountTolerance ?? DEFAULTS.amountTolerance;
    this.log =
      opts.log ??
      ((msg: string): void => {
        console.error(msg);
      });
  }

  /** Check one claim. Always resolves — never throws. */
  async check(claim: HardClaim, ctx: CheckContext = {}): Promise<ClaimVerdict> {
    try {
      if (claim.expectedSource === 'odoo') {
        return await this.checkOdoo(claim, ctx);
      }
      if (claim.expectedSource === 'graph') {
        return await this.checkGraph(claim);
      }
      return unverified(claim, `unknown source ${claim.expectedSource}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[verifier/deterministic] FAIL claim=${claim.id} err=${msg}`);
      return checkFailed(claim, `re-query error: ${msg}`);
    }
  }

  /** Fan out one checker run per claim, preserving order. */
  async checkAll(claims: HardClaim[], ctx: CheckContext = {}): Promise<ClaimVerdict[]> {
    return Promise.all(claims.map((c) => this.check(c, ctx)));
  }

  /**
   * #1574 — a name claim with no record of its own, confirmed against the
   * records the turn read: their `display_name` is re-read from Odoo, and the
   * claim is `verified` when it says nothing beyond one of those names
   * ({@link nameClaimMatches}). Anything else — no turn records, no match, a
   * claim that carries more than the name — is `unverified`, and the caller
   * hands the claim to the judge as before. Always resolves.
   */
  async checkNameAgainstTurnRecords(claim: Claim, ctx: CheckContext): Promise<ClaimVerdict> {
    if (!this.odoo) return unverified(claim, 'no odoo reader configured');
    const pinned = claim.odooRecord?.model;
    const byModel = turnRecordIdsByModel(
      ctx.turnRecords,
      pinned !== undefined ? new Set([pinned]) : undefined,
    );
    if (byModel.size === 0) return unverified(claim, 'no turn record to match the name');
    // The claim's TEXT decides: a name claim carries its assertion in the
    // text ("Anna Müller wechselte in die IT"), its `value` only the name.
    const needle = claim.text;
    try {
      for (const [model, ids] of byModel) {
        const rows = await this.readRows(model, ids, ['display_name']);
        if (rows.some((row) => typeof row['display_name'] === 'string' && nameClaimMatches(needle, row['display_name']))) {
          return verified(claim, 'odoo');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[verifier/deterministic] FAIL name claim=${claim.id} err=${msg}`);
      return unverified(claim, 'turn-record name lookup failed');
    }
    return unverified(claim, 'no turn record carries this name');
  }

  /**
   * #129 — existence check for a qualitative claim anchored on an Odoo
   * record (`hasOdooRecordAnchor`). The extractor is an LLM and types
   * "INV/2026/0099 ist verbucht" as `id` in some samples and `qualitative`
   * in others; the record either exists or it doesn't either way.
   *
   * Narrower than the `id` path on purpose: a numeric id is `read` on any
   * model, but a textual `ref` is only searched on models whose reference
   * fields are known ({@link SOFT_ANCHOR_REF_FIELDS}) — `name` first, then
   * the model's secondary reference field (vendor bill `ref`, sale order
   * `client_order_ref`, …). Unknown model ⇒ `unverified`, the judge decides.
   * Always resolves — never throws.
   */
  async checkRecordExists(claim: Claim): Promise<ClaimVerdict> {
    if (!hasOdooRecordAnchor(claim)) {
      return unverified(claim, 'claim has no odoo record anchor');
    }
    if (!this.odoo) return unverified(claim, 'no odoo reader configured');
    const ref = claim.odooRecord!;
    try {
      if (typeof ref.id === 'number') {
        return await this.checkOdooId(claim, ref);
      }
      const fields = SOFT_ANCHOR_REF_FIELDS[ref.model];
      if (!fields) {
        return unverified(claim, `no known reference field for ${ref.model}`);
      }
      for (const field of fields) {
        const ids = (await this.odoo.execute({
          model: ref.model,
          method: 'search',
          positionalArgs: [[[field, '=', ref.ref]]],
          kwargs: { limit: 1 },
        })) as number[] | undefined;
        if (Array.isArray(ids) && ids.length > 0) return verified(claim, 'odoo');
      }
      return contradicted(
        claim,
        null,
        `no ${ref.model} with ${fields.join('|')}="${String(ref.ref)}"`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[verifier/deterministic] FAIL exists claim=${claim.id} err=${msg}`);
      return checkFailed(claim, `re-query error: ${msg}`);
    }
  }

  // --- Odoo ---------------------------------------------------------------

  private async checkOdoo(claim: HardClaim, ctx: CheckContext): Promise<ClaimVerdict> {
    if (!this.odoo) return unverified(claim, 'no odoo reader configured');
    const ref = claim.odooRecord;

    switch (claim.type) {
      case 'amount':
        return this.checkOdooAmount(claim, ref, ctx);
      case 'aggregate':
        return this.checkOdooAggregate(claim, ref, ctx);
      case 'date':
        return this.checkOdooDate(claim, ref, ctx);
      case 'id':
        return this.checkOdooId(claim, ref);
    }
  }

  private async checkOdooAmount(
    claim: HardClaim,
    ref: OdooRecordRef | undefined,
    ctx: CheckContext,
  ): Promise<ClaimVerdict> {
    const claimed = coerceNumber(claim.value);
    if (claimed === undefined) {
      return unverified(claim, 'claim has no parseable numeric value');
    }
    if (!ref || typeof ref.id !== 'number') {
      // #1574 — no record named: one the turn read may carry the amount.
      return this.matchTurnRecords(claim, ref?.model, AMOUNT_MODELS, ctx, (model, row) => {
        const truth = coerceNumber(row[AMOUNT_FIELD_BY_MODEL[model]!]);
        return truth !== undefined && Math.abs(truth - claimed) <= this.tolerance;
      }, 'amount claim without odoo id');
    }
    const field = AMOUNT_FIELD_BY_MODEL[ref.model];
    if (!field) return unverified(claim, `no amount field for ${ref.model}`);

    const rows = await this.readRows(ref.model, [ref.id], [field]);
    const row = rows[0];
    if (!row) return contradicted(claim, null, `record ${ref.model}:${String(ref.id)} not found`);

    const truth = coerceNumber(row[field]);
    if (truth === undefined) {
      return unverified(claim, `field ${field} not numeric`);
    }
    if (Math.abs(truth - claimed) > this.tolerance) {
      return contradicted(claim, truth, `Δ=${String(truth - claimed)}`);
    }
    return verified(claim, 'odoo');
  }

  /**
   * HR-Spezial: Aggregate claims MUST be re-computed in JS from the raw
   * rows. We never trust an LLM to have summed hr.leave.number_of_days
   * correctly.
   *
   * #1575 / #1579 — a total is compared only with the records it is about:
   *  - the summed model: the claim's, or for a claim pinned on the owning
   *    record (an employee) the model of that owner's rows (`hr.leave`);
   *  - one scope (employee / partner): the pinned owner, a
   *    `<model>:<id>` related entity, else the one owner of the turn's
   *    records. No scope ⇒ `unverified` — a company-wide sum is no truth;
   *  - each candidate total: per request-state set (approved; approved +
   *    pending; every request), over all of the owner's records and over
   *    the ones the turn itself read (which carries the turn's period). The
   *    claim is verified when one matches;
   *  - contradicted only when none matches and the candidates cover what the
   *    claim is about: the turn read the summed records, or the claim names
   *    no period (there is no period filter of our own).
   */
  private async checkOdooAggregate(
    claim: HardClaim,
    ref: OdooRecordRef | undefined,
    ctx: CheckContext,
  ): Promise<ClaimVerdict> {
    const claimed = coerceNumber(claim.value);
    if (claimed === undefined) {
      return unverified(claim, 'aggregate claim has no parseable numeric value');
    }
    if (!ref) return unverified(claim, 'aggregate claim without odoo model');
    const target = AGGREGATE_MODEL_FOR_OWNER[ref.model] ?? ref.model;
    const field = AMOUNT_FIELD_BY_MODEL[target];
    if (!field) return unverified(claim, `no aggregate field for ${ref.model}`);
    const scopeDef = AGGREGATE_SCOPE_BY_MODEL[target];
    if (!scopeDef) return unverified(claim, `no aggregate scope for ${target}`);

    const turnIds = turnRecordIdsByModel(ctx.turnRecords, new Set([target])).get(target) ?? [];
    const scopeId = await this.aggregateScopeId(claim, ref, target, scopeDef, turnIds, ctx);
    if (scopeId === undefined) {
      return unverified(claim, `aggregate scope unknown (no single ${scopeDef.model})`);
    }

    const stateSets = AGGREGATE_STATE_SETS[target];
    const rows = await this.searchRows(
      target,
      [[scopeDef.field, '=', scopeId]],
      stateSets ? [field, 'state'] : [field],
    );
    const kind = claim.aggregation ?? 'sum';
    const inState = (states: readonly string[]) => (row: Record<string, unknown>): boolean =>
      typeof row['state'] !== 'string' || states.includes(row['state']);
    const turnSet = new Set(turnIds);
    const turnRows = rows.filter((row) => typeof row['id'] === 'number' && turnSet.has(row['id']));
    // Every candidate set — all of the owner's records, and the ones the turn
    // read — is counted per request-state set.
    const totalsOver = (base: Array<Record<string, unknown>>): number[] =>
      (stateSets ?? [undefined])
        .map((states) => aggregate(states ? base.filter(inState(states)) : base, field, kind))
        .filter((n): n is number => n !== undefined);
    const allTotals = totalsOver(rows);
    const turnTotals = turnRows.length > 0 ? totalsOver(turnRows) : [];
    const candidates = [...allTotals, ...turnTotals];
    if (candidates.length === 0) {
      return unverified(claim, 'aggregation produced no numeric result');
    }
    if (candidates.some((truth) => Math.abs(truth - claimed) <= this.tolerance)) {
      return verified(claim, 'odoo');
    }
    if (turnTotals.length === 0 && claimNamesPeriod(claim)) {
      return unverified(claim, 'aggregate names a period the check cannot filter');
    }
    const truth = turnTotals[0] ?? allTotals[0]!;
    return contradicted(claim, truth, `aggregate ${kind} Δ=${String(truth - claimed)}`);
  }

  /**
   * #1575 — the one employee / partner an aggregate claim is about: the
   * pinned owner record, a related entity of the scope model, the one such
   * record the turn read, else the one owner of the summed records the turn
   * read (re-read from Odoo). Undefined when none of these names exactly one.
   */
  private async aggregateScopeId(
    claim: HardClaim,
    ref: OdooRecordRef,
    target: string,
    scope: { field: string; model: string },
    turnIds: readonly number[],
    ctx: CheckContext,
  ): Promise<number | undefined> {
    if (ref.model === scope.model && typeof ref.id === 'number') return ref.id;
    const related = extractRelatedId(claim.relatedEntities, scope.model);
    if (related !== undefined) return related;
    const owners = turnRecordIdsByModel(ctx.turnRecords, new Set([scope.model])).get(scope.model) ?? [];
    if (owners.length === 1) return owners[0];
    if (owners.length > 1 || turnIds.length === 0) return undefined;
    const rows = await this.readRows(target, turnIds, [scope.field]);
    const found = new Set(rows.map((row) => many2oneId(row[scope.field])).filter((n) => n !== undefined));
    return found.size === 1 ? [...found][0] : undefined;
  }

  private async checkOdooDate(
    claim: HardClaim,
    ref: OdooRecordRef | undefined,
    ctx: CheckContext,
  ): Promise<ClaimVerdict> {
    const claimed = coerceDate(claim.value ?? claim.text);
    if (!claimed) return unverified(claim, 'claim has no ISO-parseable date');
    if (!ref || typeof ref.id !== 'number') {
      // #1574 — no record named: one the turn read may carry the date.
      return this.matchTurnRecords(claim, ref?.model, DATE_MODELS, ctx, (model, row) =>
        DATE_FIELDS_BY_MODEL[model]!.some((f) => dateOf(row[f]) === claimed),
      'date claim without odoo id');
    }
    const fields = DATE_FIELDS_BY_MODEL[ref.model];
    if (!fields) return unverified(claim, `no date field for ${ref.model}`);

    const rows = await this.readRows(ref.model, [ref.id], [...fields]);
    const row = rows[0];
    if (!row) return contradicted(claim, null, `record ${ref.model}:${String(ref.id)} not found`);

    const truths = fields.map((f) => dateOf(row[f])).filter((d): d is string => d !== undefined);
    if (truths.length === 0) return unverified(claim, `field ${fields.join('|')} not a date string`);
    if (!truths.includes(claimed)) return contradicted(claim, truths[0]);
    return verified(claim, 'odoo');
  }

  /**
   * #1574 — a claim that pins no record, matched against the records the
   * turn read: per model (the claim's, else every model `models` covers),
   * one `read` of those ids, and `verified` when one row `matches`. No turn
   * record or no match ⇒ `unverified` with `fallback` as the reason — the
   * claim may be about a record the turn did not read.
   */
  private async matchTurnRecords(
    claim: HardClaim,
    pinnedModel: string | undefined,
    models: ReadonlySet<string>,
    ctx: CheckContext,
    matches: (model: string, row: Record<string, unknown>) => boolean,
    fallback: string,
  ): Promise<ClaimVerdict> {
    const allowed =
      pinnedModel !== undefined
        ? new Set(models.has(pinnedModel) ? [pinnedModel] : [])
        : models;
    const byModel = turnRecordIdsByModel(ctx.turnRecords, allowed);
    if (byModel.size === 0) return unverified(claim, fallback);
    try {
      for (const [model, ids] of byModel) {
        const fields =
          claim.type === 'date' ? DATE_FIELDS_BY_MODEL[model]! : [AMOUNT_FIELD_BY_MODEL[model]!];
        const rows = await this.readRows(model, ids, fields);
        if (rows.some((row) => matches(model, row))) return verified(claim, 'odoo');
      }
    } catch (err) {
      // An extra lookup that failed is no failed check: without the turn's
      // records the claim was `unverified` before, and it stays so.
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[verifier/deterministic] turn-record lookup failed claim=${claim.id} err=${msg}`);
      return unverified(claim, `${fallback}; turn-record lookup failed`);
    }
    return unverified(claim, `${fallback}; no record the turn read matches`);
  }

  /** `read` of `ids` on `model`; a non-array reply reads as no rows. */
  private async readRows(
    model: string,
    ids: readonly number[],
    fields: readonly string[],
  ): Promise<Array<Record<string, unknown>>> {
    const rows = (await this.odoo!.execute({
      model,
      method: 'read',
      positionalArgs: [[...ids], [...fields]],
      kwargs: {},
    })) as Array<Record<string, unknown>> | undefined;
    return Array.isArray(rows) ? rows : [];
  }

  /** `search_read` on `model`; throws on a non-array reply (no evidence). */
  private async searchRows(
    model: string,
    domain: unknown[],
    fields: readonly string[],
  ): Promise<Array<Record<string, unknown>>> {
    const rows = (await this.odoo!.execute({
      model,
      method: 'search_read',
      positionalArgs: [domain, [...fields]],
      kwargs: { limit: 1000 },
    })) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(rows)) throw new Error('search_read returned non-array');
    return rows;
  }

  /** Record-existence check — shared by the `id` path and
   *  {@link checkRecordExists}, hence typed on `Claim` not `HardClaim`. */
  private async checkOdooId(
    claim: Claim,
    ref: OdooRecordRef | undefined,
  ): Promise<ClaimVerdict> {
    if (!ref) return unverified(claim, 'id claim without odoo model');

    if (typeof ref.id === 'number') {
      const rows = (await this.odoo!.execute({
        model: ref.model,
        method: 'read',
        positionalArgs: [[ref.id], ['id']],
        kwargs: {},
      })) as Array<Record<string, unknown>> | undefined;
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) return contradicted(claim, null, `record ${ref.model}:${String(ref.id)} not found`);
      return verified(claim, 'odoo');
    }

    if (ref.ref) {
      // A miss refutes the reference only where the model's reference fields
      // are known (invoice / order numbers, `SOFT_ANCHOR_REF_FIELDS`). On any
      // other model `name` is free text — a leave's description, a person's
      // name in whatever spelling — and the extractor also types periods
      // ("15.09.2025–26.09.2025") as references there: seen live on
      // `hr.leave`, where every period of a correct answer was "not found"
      // and `enforce` withheld it. There a hit confirms, a miss stays
      // `unverified`.
      const known = SOFT_ANCHOR_REF_FIELDS[ref.model];
      for (const field of known ?? ['name']) {
        const ids = (await this.odoo!.execute({
          model: ref.model,
          method: 'search',
          positionalArgs: [[[field, '=', ref.ref]]],
          kwargs: { limit: 1 },
        })) as number[] | undefined;
        if (Array.isArray(ids) && ids.length > 0) return verified(claim, 'odoo');
      }
      return known
        ? contradicted(claim, null, `no ${ref.model} with ${known.join('|')}="${ref.ref}"`)
        : unverified(claim, `no ${ref.model} named "${ref.ref}"; ${ref.model} has no known reference field`);
    }

    return unverified(claim, 'id claim has neither id nor ref');
  }

  // --- Graph --------------------------------------------------------------

  private async checkGraph(claim: HardClaim): Promise<ClaimVerdict> {
    if (!this.graph) return unverified(claim, 'no graph reader configured');

    // The graph resolves a record by its exact source id and otherwise
    // searches a reference/name substring; amounts/aggregates require a
    // richer query language that we don't expose from this checker yet.
    if (claim.type !== 'id') {
      return unverified(claim, `graph check for type=${claim.type} not implemented`);
    }
    const ref = claim.odooRecord;
    if (!ref) return unverified(claim, 'graph id claim without model');

    if (typeof ref.id === 'number' && Number.isInteger(ref.id) && ref.id > 0) {
      return this.checkGraphRecord(claim, ref.model, ref.id);
    }

    // No record id: a document ref or name is searched as a substring.
    const needle = ref.ref ?? asString(claim.value) ?? claim.text;
    const hits = await this.graph.findEntities({
      model: ref.model,
      nameContains: needle,
      limit: 5,
    });
    if (hits.length === 0) {
      return contradicted(claim, null, `no ${ref.model} matching "${needle}" in graph`);
    }
    return verified(claim, 'graph');
  }

  /**
   * An `odooRecord.id` names ONE record: it is looked up by exact id (a
   * substring match on "42" would also accept 142, 420 or "Halle 42"), and
   * the hit's identity is re-checked, because a graph provider built before
   * `FindEntitiesOptions.id` ignores the option and returns any record of
   * the model. A miss leaves the claim `unverified`: no other record stands
   * in for the named one, and the graph is a periodically synced partial
   * mirror, so a record missing from it is not thereby shown to be false —
   * a `contradicted` verdict would feed the retry a "record not found" that
   * may be wrong.
   */
  private async checkGraphRecord(
    claim: HardClaim,
    model: string,
    id: number,
  ): Promise<ClaimVerdict> {
    const hits = await this.graph!.findEntities({ model, id, limit: 1 });
    const record: RecordHandle = { model, id: String(id) };
    if (!hits.some((hit) => matchesRecord(hit, record))) {
      return unverified(claim, `no ${model} with id ${String(id)} in graph`);
    }
    return verified(claim, 'graph');
  }
}

// --- helpers --------------------------------------------------------------

function verified(claim: Claim, source: 'odoo' | 'graph'): ClaimVerdict {
  return { status: 'verified', claim, source };
}

function contradicted(claim: Claim, truth: unknown, detail?: string): ClaimVerdict {
  const out: ClaimVerdict = {
    status: 'contradicted',
    claim,
    truth,
    source: claim.expectedSource,
  };
  if (detail !== undefined) out.detail = detail;
  return out;
}

function unverified(claim: Claim, reason: string): ClaimVerdict {
  return { status: 'unverified', claim, reason };
}

/** The re-query itself failed: the claim is unconfirmed, and the failure is
 *  marked so an answer whose every check failed reads as an outage. */
function checkFailed(claim: Claim, reason: string): ClaimVerdict {
  return { status: 'unverified', claim, reason, cause: 'check_failed' };
}

/**
 * Accept a number, a numeric string (German "1.234,56" or ISO "1234.56"),
 * or false/0. Returns undefined for anything we can't parse confidently.
 */
function coerceNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    // Strip currency + whitespace.
    const cleaned = trimmed.replace(/[\s€$]/g, '').replace(/EUR$/i, '');
    // German thousands "." + comma decimal → normalise to JS form.
    // Heuristic: if comma is present, treat commas as decimal and drop dots.
    let normalised: string;
    if (cleaned.includes(',')) {
      normalised = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalised = cleaned;
    }
    const n = Number.parseFloat(normalised);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function coerceDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(trimmed);
  if (iso) return iso[0];
  const german = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(trimmed);
  if (german) return `${german[3]!}-${german[2]!}-${german[1]!}`;
  return undefined;
}

/** The calendar day of an Odoo date / datetime string (`YYYY-MM-DD…`). */
function dateOf(v: unknown): string | undefined {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;
}

/** The id of a many2one value — `[id, "name"]` from Odoo, or a bare id. */
function many2oneId(v: unknown): number | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function extractRelatedId(
  related: readonly string[],
  prefix: string,
): number | undefined {
  for (const entry of related) {
    // Accept "hr.employee:7" or "odoo:hr.employee:7".
    const parts = entry.split(':');
    const modelIdx = parts.findIndex((p) => p === prefix);
    if (modelIdx === -1) continue;
    const idStr = parts[modelIdx + 1];
    if (!idStr) continue;
    const n = Number.parseInt(idStr, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function aggregate(
  rows: Array<Record<string, unknown>>,
  field: string,
  kind: 'sum' | 'count' | 'avg' | 'max' | 'min',
): number | undefined {
  if (kind === 'count') return rows.length;
  // No record in scope sums to zero; an average or extreme of nothing has none.
  if (rows.length === 0) return kind === 'sum' ? 0 : undefined;
  const values: number[] = [];
  for (const row of rows) {
    const n = coerceNumber(row[field]);
    if (n !== undefined) values.push(n);
  }
  if (values.length === 0) return undefined;
  switch (kind) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
  }
}
