/**
 * In-memory Odoo stand-in for the golden-set deterministic path (#639, v2).
 *
 * v1 (#129) wired `DeterministicChecker({})` — no reader — so every HARD claim
 * (amount / id / date / aggregate) resolved `unverified`, and the checker's
 * `verified` (→ approved) and `contradicted` (→ blocked) branches had zero
 * corpus coverage. This reader closes that gap: a golden entry declares a frozen
 * record set, and the real `DeterministicChecker` re-queries it exactly as it
 * would a live Odoo.
 *
 * It is a FIXTURE, not a call-mock. It interprets the three RPC methods the
 * checker actually issues — `read`, `search`, `search_read` — against the
 * declared rows, so the checker's own branching (field lookup, cent-tolerance
 * compare, JS re-aggregation) runs UNCHANGED. Only the database is faked. That
 * is deliberate: a mock keyed on the exact request would hide the very branch
 * the fixture is meant to exercise (cf. the v1 trigger-skip trap the corpus
 * README warns about).
 *
 * Pure: the only `@omadia/verifier` dependency is a type import (erased at
 * runtime), so this file loads in the default `npm test` glob without `dist/`.
 */

import type { OdooReader } from '@omadia/verifier';

/** One frozen Odoo row. `fields` holds every column a checker branch may read
 *  (e.g. `amount_total`, `invoice_date`, `name`, `employee_id`). */
export interface FixtureOdooRecord {
  model: string;
  id: number;
  fields: Readonly<Record<string, unknown>>;
}

/** The `odoo` block on a corpus entry: the records this turn's checker sees. */
export interface OdooFixture {
  records: readonly FixtureOdooRecord[];
}

/** Narrow the loosely-typed positional args the checker passes. */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Evaluate an Odoo search domain against a row's fields. Supports the small
 * slice the DeterministicChecker emits: an AND-list of `[field, op, value]`
 * triples with `=`, `!=`, `in`. An empty domain matches every row. Boolean
 * operator tokens (`'&'`, `'|'`) and any unknown operator make the row NOT
 * match — conservative on purpose, so a fixture never over-matches silently.
 */
function matchesDomain(
  fields: Readonly<Record<string, unknown>>,
  domain: unknown,
): boolean {
  if (!Array.isArray(domain)) return true; // no filter → all rows
  for (const clause of domain) {
    if (!Array.isArray(clause) || clause.length < 3) return false;
    const [field, op, value] = clause as [unknown, unknown, unknown];
    if (typeof field !== 'string') return false;
    const actual = fields[field];
    switch (op) {
      case '=':
        if (actual !== value) return false;
        break;
      case '!=':
        if (actual === value) return false;
        break;
      case 'in':
        if (!Array.isArray(value) || !value.includes(actual)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function pick(
  fields: Readonly<Record<string, unknown>>,
  names: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const n of asArray(names)) {
    if (typeof n === 'string' && n in fields) out[n] = fields[n];
  }
  return out;
}

export class FixtureOdooReader implements OdooReader {
  private readonly records: readonly FixtureOdooRecord[];

  constructor(fixture: OdooFixture) {
    this.records = fixture.records;
  }

  execute(req: {
    model: string;
    method: string;
    positionalArgs: unknown[];
    kwargs: Record<string, unknown>;
  }): Promise<unknown> {
    const rows = this.records.filter((r) => r.model === req.model);
    switch (req.method) {
      case 'read':
        return Promise.resolve(this.read(rows, req.positionalArgs));
      case 'search':
        return Promise.resolve(this.search(rows, req.positionalArgs));
      case 'search_read':
        return Promise.resolve(this.searchRead(rows, req.positionalArgs));
      default:
        // Unknown method → undefined. The checker treats a non-array / missing
        // result as `unverified`, which is the safe default.
        return Promise.resolve(undefined);
    }
  }

  /** `read([ids], [fields])` → one row per matching id, in id order. */
  private read(
    rows: readonly FixtureOdooRecord[],
    positionalArgs: unknown[],
  ): Array<Record<string, unknown>> {
    const ids = asArray(positionalArgs[0]);
    const fields = positionalArgs[1];
    const out: Array<Record<string, unknown>> = [];
    for (const id of ids) {
      const rec = rows.find((r) => r.id === id);
      if (rec) out.push({ id: rec.id, ...pick(rec.fields, fields) });
    }
    return out;
  }

  /** `search(domain)` → matching ids. */
  private search(
    rows: readonly FixtureOdooRecord[],
    positionalArgs: unknown[],
  ): number[] {
    const domain = positionalArgs[0];
    return rows.filter((r) => matchesDomain(r.fields, domain)).map((r) => r.id);
  }

  /** `search_read(domain, [fields])` → matching rows' selected fields. */
  private searchRead(
    rows: readonly FixtureOdooRecord[],
    positionalArgs: unknown[],
  ): Array<Record<string, unknown>> {
    const domain = positionalArgs[0];
    const fields = positionalArgs[1];
    return rows
      .filter((r) => matchesDomain(r.fields, domain))
      .map((r) => ({ id: r.id, ...pick(r.fields, fields) }));
  }
}
