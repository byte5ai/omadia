import type {
  Claim,
  ClaimVerdict,
  HardClaim,
  OdooRecordRef,
} from './claimTypes.js';

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
 *    `unverified`, not `contradicted`. The pipeline's aggregator decides
 *    whether that degrades the final verdict to `approved_with_disclaimer`.
 *  - Monetary tolerance is 0.01 € (one cent). Dates are compared as
 *    ISO strings, ids as exact matches.
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
    nameContains?: string;
    limit?: number;
  }): Promise<
    Array<{ id: string; props?: Readonly<Record<string, unknown>> }>
  >;
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

const DATE_FIELD_BY_MODEL: Readonly<Record<string, string>> = {
  'account.move': 'invoice_date',
  'sale.order': 'date_order',
  'purchase.order': 'date_order',
  'hr.leave': 'date_from',
  'hr.expense': 'date',
};

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
  async check(claim: HardClaim): Promise<ClaimVerdict> {
    try {
      if (claim.expectedSource === 'odoo') {
        return await this.checkOdoo(claim);
      }
      if (claim.expectedSource === 'graph') {
        return await this.checkGraph(claim);
      }
      return unverified(claim, `unknown source ${claim.expectedSource}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[verifier/deterministic] FAIL claim=${claim.id} err=${msg}`);
      return unverified(claim, `re-query error: ${msg}`);
    }
  }

  /** Fan out one checker run per claim, preserving order. */
  async checkAll(claims: HardClaim[]): Promise<ClaimVerdict[]> {
    return Promise.all(claims.map((c) => this.check(c)));
  }

  // --- Odoo ---------------------------------------------------------------

  private async checkOdoo(claim: HardClaim): Promise<ClaimVerdict> {
    if (!this.odoo) return unverified(claim, 'no odoo reader configured');
    const ref = claim.odooRecord;

    switch (claim.type) {
      case 'amount':
        return this.checkOdooAmount(claim, ref);
      case 'aggregate':
        return this.checkOdooAggregate(claim, ref);
      case 'date':
        return this.checkOdooDate(claim, ref);
      case 'id':
        return this.checkOdooId(claim, ref);
    }
  }

  private async checkOdooAmount(
    claim: HardClaim,
    ref: OdooRecordRef | undefined,
  ): Promise<ClaimVerdict> {
    const claimed = coerceNumber(claim.value);
    if (claimed === undefined) {
      return unverified(claim, 'claim has no parseable numeric value');
    }
    if (!ref || typeof ref.id !== 'number') {
      return unverified(claim, 'amount claim without odoo id');
    }
    const field = AMOUNT_FIELD_BY_MODEL[ref.model];
    if (!field) return unverified(claim, `no amount field for ${ref.model}`);

    const rows = (await this.odoo!.execute({
      model: ref.model,
      method: 'read',
      positionalArgs: [[ref.id], [field]],
      kwargs: {},
    })) as Array<Record<string, unknown>> | undefined;

    const row = Array.isArray(rows) ? rows[0] : undefined;
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
   * correctly. When the claim carries enough metadata, we build the
   * search_read call ourselves; otherwise we have to unverify.
   */
  private async checkOdooAggregate(
    claim: HardClaim,
    ref: OdooRecordRef | undefined,
  ): Promise<ClaimVerdict> {
    const claimed = coerceNumber(claim.value);
    if (claimed === undefined) {
      return unverified(claim, 'aggregate claim has no parseable numeric value');
    }
    if (!ref) return unverified(claim, 'aggregate claim without odoo model');
    const field = AMOUNT_FIELD_BY_MODEL[ref.model];
    if (!field) return unverified(claim, `no aggregate field for ${ref.model}`);

    // Domain must be supplied by a future claim enrichment; today we only
    // aggregate per-record totals, which is the common case ("Urlaubstage
    // dieses Mitarbeiters"). The related entity `hr.employee:<id>` gives us
    // the filter.
    const employeeId = extractRelatedId(claim.relatedEntities, 'hr.employee');
    const domain: unknown[] = employeeId ? [['employee_id', '=', employeeId]] : [];

    const rows = (await this.odoo!.execute({
      model: ref.model,
      method: 'search_read',
      positionalArgs: [domain, [field]],
      kwargs: { limit: 1000 },
    })) as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(rows)) {
      return unverified(claim, 'search_read returned non-array');
    }

    const truth = aggregate(rows, field, claim.aggregation ?? 'sum');
    if (truth === undefined) {
      return unverified(claim, 'aggregation produced no numeric result');
    }
    if (Math.abs(truth - claimed) > this.tolerance) {
      return contradicted(claim, truth, `aggregate ${claim.aggregation ?? 'sum'} Δ=${String(truth - claimed)}`);
    }
    return verified(claim, 'odoo');
  }

  private async checkOdooDate(
    claim: HardClaim,
    ref: OdooRecordRef | undefined,
  ): Promise<ClaimVerdict> {
    const claimed = coerceDate(claim.value ?? claim.text);
    if (!claimed) return unverified(claim, 'claim has no ISO-parseable date');
    if (!ref || typeof ref.id !== 'number') {
      return unverified(claim, 'date claim without odoo id');
    }
    const field = DATE_FIELD_BY_MODEL[ref.model];
    if (!field) return unverified(claim, `no date field for ${ref.model}`);

    const rows = (await this.odoo!.execute({
      model: ref.model,
      method: 'read',
      positionalArgs: [[ref.id], [field]],
      kwargs: {},
    })) as Array<Record<string, unknown>> | undefined;

    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return contradicted(claim, null, `record ${ref.model}:${String(ref.id)} not found`);

    const truthRaw = row[field];
    const truth = typeof truthRaw === 'string' ? truthRaw.slice(0, 10) : null;
    if (!truth) return unverified(claim, `field ${field} not a date string`);
    if (truth !== claimed) return contradicted(claim, truth);
    return verified(claim, 'odoo');
  }

  private async checkOdooId(
    claim: HardClaim,
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
      const ids = (await this.odoo!.execute({
        model: ref.model,
        method: 'search',
        positionalArgs: [[['name', '=', ref.ref]]],
        kwargs: { limit: 1 },
      })) as number[] | undefined;
      if (Array.isArray(ids) && ids.length > 0) return verified(claim, 'odoo');
      return contradicted(claim, null, `no ${ref.model} with name="${ref.ref}"`);
    }

    return unverified(claim, 'id claim has neither id nor ref');
  }

  // --- Graph --------------------------------------------------------------

  private async checkGraph(claim: HardClaim): Promise<ClaimVerdict> {
    if (!this.graph) return unverified(claim, 'no graph reader configured');

    // The graph supports ID-and-name lookups; amounts/aggregates require a
    // richer query language that we don't expose from this checker yet.
    if (claim.type !== 'id') {
      return unverified(claim, `graph check for type=${claim.type} not implemented`);
    }
    const ref = claim.odooRecord;
    if (!ref) return unverified(claim, 'graph id claim without model');

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
