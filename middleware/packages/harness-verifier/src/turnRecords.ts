import type { Claim } from './claimTypes.js';

/**
 * #1574 — the Odoo records the checked turn's tools read, as model + id. The
 * kernel collects them server-side from the turn's EntityRefBus (the same
 * refs the session log keeps); they never go to a model.
 *
 * Behind a Privacy Shield the answering model never sees a record id, so an
 * answer rarely names one, and a check that needs `odooRecord.id` had nothing
 * to re-query. These records give the deterministic checker the anchor the
 * answer text lacks: it re-reads THOSE records from Odoo itself (never the
 * tool output the turn's model saw) and compares the claim with the fresh
 * values. A turn record only ever narrows what is re-read — it is no evidence.
 */
export interface TurnRecord {
  readonly model: string;
  readonly id: number;
}

/** Most records of one model a single re-read takes. A turn that read more is
 *  matched on its first ones only — a miss stays `unverified`, never wrong. */
export const MAX_TURN_RECORDS_PER_MODEL = 50;

/** Distinct turn records grouped by model, at most
 *  {@link MAX_TURN_RECORDS_PER_MODEL} ids each. */
export function turnRecordIdsByModel(
  records: readonly TurnRecord[] | undefined,
  models?: ReadonlySet<string>,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const record of records ?? []) {
    if (!Number.isInteger(record.id) || record.id <= 0) continue;
    if (models !== undefined && !models.has(record.model)) continue;
    const ids = out.get(record.model) ?? [];
    if (ids.length >= MAX_TURN_RECORDS_PER_MODEL || ids.includes(record.id)) continue;
    out.set(record.model, [...ids, record.id]);
  }
  return out;
}

/**
 * Normalise turn records from loosely typed input (EntityRef ids arrive as
 * number or numeric string). Records of another system, or without a positive
 * integer id, are dropped.
 */
export function toTurnRecords(
  refs: ReadonlyArray<{ readonly system?: string; readonly model: string; readonly id: string | number }>,
): TurnRecord[] {
  const seen = new Set<string>();
  const out: TurnRecord[] = [];
  for (const ref of refs) {
    if (ref.system !== undefined && ref.system !== 'odoo') continue;
    const id = typeof ref.id === 'number' ? ref.id : Number(ref.id);
    if (!Number.isInteger(id) || id <= 0 || ref.model.length === 0) continue;
    const key = `${ref.model}#${String(id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ model: ref.model, id });
  }
  return out;
}

/** Words that name a period: a year, a month, a quarter or a range. */
const PERIOD_PATTERN =
  /\b(?:19|20)\d{2}\b|\b(?:januar|january|februar|february|märz|maerz|march|april|mai|may|juni|june|juli|july|august|september|oktober|october|november|dezember|december|quartal|quarter|q[1-4]|monat|month|jahr|year|woche|week|seit|since|bis|until|zwischen|between)\b|\d{1,2}\.\d{1,2}\./iu;

/**
 * #1575 — true when the claim (or the sentence it stands in) limits its total
 * to a period. The aggregate check has no period filter of its own, so for
 * such a claim only the records the turn itself read can refute it; a
 * company-wide or all-time total cannot.
 */
export function claimNamesPeriod(claim: Claim): boolean {
  return PERIOD_PATTERN.test(claim.text) || (claim.context !== undefined && PERIOD_PATTERN.test(claim.context));
}

/** Honorifics and role words a name claim may carry around the name itself. */
const NAME_FILLER: ReadonlySet<string> = new Set([
  'herr',
  'herrn',
  'frau',
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'mitarbeiter',
  'mitarbeiterin',
  'employee',
  'kunde',
  'kundin',
  'customer',
  'lieferant',
  'vendor',
  'supplier',
]);

function nameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * #1574 — true when a name claim says nothing beyond the record's name: every
 * word of the claim (honorifics and role words aside) is a word of
 * `displayName`. A claim that carries more ("Anna Müller ist in der IT") is
 * not confirmed by the name alone and stays with the judge.
 */
export function nameClaimMatches(claimText: string, displayName: string): boolean {
  const own = new Set(nameTokens(displayName));
  if (own.size === 0) return false;
  const words = nameTokens(claimText).filter((t) => !NAME_FILLER.has(t));
  return words.length > 0 && words.every((t) => own.has(t));
}
