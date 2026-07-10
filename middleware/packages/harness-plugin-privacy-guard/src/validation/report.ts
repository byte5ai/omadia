/**
 * #361 — pure helpers for the prompt-PII detector evaluation
 * (`promptDetectorEval.ts`): fixture lint, per-locale aggregation, gate
 * evaluation, and console/markdown rendering. No IO, no detector calls —
 * everything here is a pure function so the runnable eval file stays small
 * (500-line rule) and the scoring logic is unit-testable in isolation.
 */

import { findIdentityLeaks } from '../v4/onTheWire.js';

// ---------------------------------------------------------------------------
// Fixture schema + lint
// ---------------------------------------------------------------------------

export type FixtureTier = 'critical' | 'high' | 'medium';
export type FixtureOrigin = 'hand' | 'synthetic';

export interface FixtureSpan {
  readonly value: string;
  readonly type: string;
  readonly tier: FixtureTier;
}

export interface FixtureItem {
  readonly text: string;
  readonly spans: readonly FixtureSpan[];
  /** Provenance: `hand` = hand-built out-of-distribution slice (the
   *  go/no-go signal per README); absent = `synthetic` (LLM-generated
   *  backbone). */
  readonly origin?: FixtureOrigin;
}

/** Types the C0 baseline is expected (and gated) to catch. */
export const STRUCTURED_TYPES: ReadonlySet<string> = new Set([
  'email',
  'iban',
  'phone',
  'address',
  'amount',
  'date',
]);

/** Measured informationally only — no detector tier owns these in v1
 *  (C0 has no locale-ID patterns; C1's calibrated label set is
 *  person/address). Never gated. */
export const INFORMATIONAL_TYPES: ReadonlySet<string> = new Set(['idnum']);

export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  ...STRUCTURED_TYPES,
  'person',
  ...INFORMATIONAL_TYPES,
]);

const TIERS: ReadonlySet<string> = new Set(['critical', 'high', 'medium']);
const ORIGINS: ReadonlySet<string> = new Set(['hand', 'synthetic']);

/**
 * Validate one parsed fixture file. Throws (loudly, with locale + item
 * index) on any malformed entry — a silently-skipped fixture would make a
 * PASS verdict meaningless.
 */
export function lintFixtures(locale: string, raw: unknown): FixtureItem[] {
  const fail = (msg: string): never => {
    throw new Error(`[fixtures/${locale}.json] ${msg}`);
  };
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail('must be a non-empty JSON array');
  }
  const seen = new Set<string>();
  const items: FixtureItem[] = [];
  raw.forEach((entry, index) => {
    const at = `item ${String(index)}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return fail(`${at}: not an object`);
    }
    const { text, spans, origin } = entry as Record<string, unknown>;
    if (typeof text !== 'string' || text.length === 0) {
      return fail(`${at}: "text" must be a non-empty string`);
    }
    if (seen.has(text)) return fail(`${at}: duplicate item text`);
    seen.add(text);
    if (origin !== undefined && (typeof origin !== 'string' || !ORIGINS.has(origin))) {
      return fail(`${at}: "origin" must be "hand" | "synthetic"`);
    }
    if (!Array.isArray(spans)) return fail(`${at}: "spans" must be an array`);
    const checked: FixtureSpan[] = spans.map((span, spanIndex) => {
      const sAt = `${at} span ${String(spanIndex)}`;
      if (typeof span !== 'object' || span === null) return fail(`${sAt}: not an object`);
      const { value, type, tier } = span as Record<string, unknown>;
      if (typeof value !== 'string' || value.length === 0) {
        return fail(`${sAt}: "value" must be a non-empty string`);
      }
      if (!text.includes(value)) {
        return fail(`${sAt}: value does not occur verbatim in text`);
      }
      if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) {
        return fail(`${sAt}: unknown type "${String(type)}"`);
      }
      if (typeof tier !== 'string' || !TIERS.has(tier)) {
        return fail(`${sAt}: unknown tier "${String(tier)}"`);
      }
      return { value, type, tier: tier as FixtureTier };
    });
    items.push(
      origin === undefined
        ? { text, spans: checked }
        : { text, spans: checked, origin: origin as FixtureOrigin },
    );
  });
  return items;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** What the eval loop observed for one fixture item. */
export interface ItemOutcome {
  readonly maskedText: string;
  /** Number of spans the detector set flagged (over-masking signal on
   *  negatives). */
  readonly flaggedSpans: number;
  readonly latencyMs: number;
}

export interface TypeRecall {
  readonly type: string;
  readonly total: number;
  readonly masked: number;
  readonly handTotal: number;
  readonly handMasked: number;
}

export interface LocaleReport {
  readonly locale: string;
  readonly byType: readonly TypeRecall[];
  readonly structuredRecall: number;
  readonly personRecall: number;
  readonly personHandRecall: number;
  readonly negatives: number;
  readonly cleanNegatives: number;
  readonly precisionProxy: number;
  readonly latencyP95: number;
}

export function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

const recallOf = (masked: number, total: number): number =>
  total === 0 ? 1 : masked / total;

/**
 * Score one locale for one detector set. Exact-match leak criterion (as
 * shipped): a span counts as masked only when its full verbatim value is
 * absent from the masked output (`findIdentityLeaks`). Note the honest
 * caveat: a long value that is only PARTIALLY masked already counts as
 * masked under this criterion — surviving fragments are a C1-tier
 * measurement, visible in the c0 vs c0+c1 delta.
 */
export function aggregateLocale(
  locale: string,
  items: readonly FixtureItem[],
  outcomes: readonly ItemOutcome[],
): LocaleReport {
  if (items.length !== outcomes.length) {
    throw new Error(`[${locale}] items/outcomes length mismatch`);
  }
  const buckets = new Map<
    string,
    { total: number; masked: number; handTotal: number; handMasked: number }
  >();
  let negatives = 0;
  let cleanNegatives = 0;
  const latencies: number[] = [];

  items.forEach((item, index) => {
    const outcome = outcomes[index]!;
    latencies.push(outcome.latencyMs);
    if (item.spans.length === 0) {
      negatives += 1;
      if (outcome.flaggedSpans === 0) cleanNegatives += 1;
      return;
    }
    const isHand = item.origin === 'hand';
    for (const span of item.spans) {
      const bucket =
        buckets.get(span.type) ??
        { total: 0, masked: 0, handTotal: 0, handMasked: 0 };
      bucket.total += 1;
      if (isHand) bucket.handTotal += 1;
      if (findIdentityLeaks(outcome.maskedText, [span.value]).length === 0) {
        bucket.masked += 1;
        if (isHand) bucket.handMasked += 1;
      }
      buckets.set(span.type, bucket);
    }
  });

  let structuredTotal = 0;
  let structuredMasked = 0;
  for (const [type, bucket] of buckets) {
    if (STRUCTURED_TYPES.has(type)) {
      structuredTotal += bucket.total;
      structuredMasked += bucket.masked;
    }
  }
  const person = buckets.get('person') ?? {
    total: 0,
    masked: 0,
    handTotal: 0,
    handMasked: 0,
  };

  return {
    locale,
    byType: [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, b]) => ({ type, ...b })),
    structuredRecall: recallOf(structuredMasked, structuredTotal),
    personRecall: recallOf(person.masked, person.total),
    personHandRecall: recallOf(person.handMasked, person.handTotal),
    negatives,
    cleanNegatives,
    precisionProxy: recallOf(cleanNegatives, negatives),
    latencyP95: p95(latencies),
  };
}

// ---------------------------------------------------------------------------
// Gates (pre-committed in README.md — do not tune after a run)
// ---------------------------------------------------------------------------

export interface GateRow {
  readonly name: string;
  readonly value: string;
  readonly threshold: string;
  /** Whether this gate counts toward the verdict for the given set. */
  readonly enforced: boolean;
  readonly pass: boolean;
}

export interface SetVerdict {
  /** false = ablation set, reported but never gated (c1-solo). */
  readonly gated: boolean;
  readonly pass: boolean;
  readonly rows: readonly GateRow[];
  readonly note: string;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * Gate policy per detector set:
 *   - `c0`      — structured-identifier gates only (person is C1 territory).
 *   - `c0+c1`   — structured AND person recall AND precision AND latency.
 *   - `c1-solo` — ablation for marginal-contribution analysis: never gated.
 * Unknown set names fall back to the c0 policy (conservative: never gate
 * person recall on a set that was not declared to include C1).
 */
export function evaluateGates(setName: string, r: LocaleReport): SetVerdict {
  const gated = setName !== 'c1-solo';
  const personEnforced = setName === 'c0+c1';
  const rows: GateRow[] = [
    {
      name: 'structured recall',
      value: pct(r.structuredRecall),
      threshold: '≥ 97%',
      enforced: gated,
      pass: r.structuredRecall >= 0.97,
    },
    {
      name: 'person recall',
      value: pct(r.personRecall),
      threshold: '≥ 90%',
      enforced: personEnforced,
      pass: r.personRecall >= 0.9,
    },
    {
      name: 'precision proxy (negatives clean)',
      value: `${String(r.cleanNegatives)}/${String(r.negatives)} (${pct(r.precisionProxy)})`,
      threshold: '≥ 85%',
      enforced: gated,
      pass: r.precisionProxy >= 0.85,
    },
    {
      name: 'p95 added latency',
      value: `${r.latencyP95.toFixed(1)} ms`,
      threshold: '≤ 400 ms',
      enforced: gated,
      pass: r.latencyP95 <= 400,
    },
  ];
  const note =
    setName === 'c1-solo'
      ? 'ablation — reported, never gated'
      : setName === 'c0+c1'
        ? 'all gates incl. person recall'
        : 'structured-identifier gates only';
  return {
    gated,
    pass: rows.filter((row) => row.enforced).every((row) => row.pass),
    rows,
    note,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const typeScope = (type: string): string =>
  STRUCTURED_TYPES.has(type)
    ? 'structured'
    : INFORMATIONAL_TYPES.has(type)
      ? 'informational — ungated in v1'
      : 'c1-scope';

/** Default console output for one locale × set (matches the shipped
 *  format, extended by person/hand-slice lines). */
export function renderConsoleLocale(r: LocaleReport, verdict: SetVerdict): string {
  const lines: string[] = [`\n=== ${r.locale} ===`];
  for (const t of r.byType) {
    lines.push(
      `  recall ${t.type.padEnd(8)} ${String(t.masked)}/${String(t.total)}  ` +
        `${pct(recallOf(t.masked, t.total))}  (${typeScope(t.type)})`,
    );
  }
  lines.push(
    `  person recall         overall ${pct(r.personRecall)}, ` +
      `hand-slice ${pct(r.personHandRecall)} (go/no-go signal)`,
  );
  for (const row of verdict.rows) {
    const gate = row.enforced ? `gate ${row.threshold}` : `${row.threshold}, not gated for this set`;
    lines.push(`  ${row.name.padEnd(34)} ${row.value}  (${gate})`);
  }
  lines.push(
    `  verdict (${verdict.note}): ${verdict.gated ? (verdict.pass ? 'PASS' : 'FAIL') : 'n/a'}`,
  );
  return lines.join('\n');
}

export interface LocaleResult {
  readonly report: LocaleReport;
  readonly verdict: SetVerdict;
}

export interface SetResults {
  readonly set: string;
  readonly locales: readonly LocaleResult[];
}

/** GitHub-flavored markdown for posting a full run to issue #361:
 *  one section per locale, one block per detector set. */
export function renderMarkdown(results: readonly SetResults[]): string {
  const locales = results[0]?.locales.map((l) => l.report.locale) ?? [];
  const out: string[] = ['# Prompt-PII detector validation run (#361)', ''];
  out.push(`Detector sets: ${results.map((r) => `\`${r.set}\``).join(', ')}.`, '');
  for (const locale of locales) {
    out.push(`## ${locale}`, '');
    for (const { set, locales: perLocale } of results) {
      const entry = perLocale.find((l) => l.report.locale === locale);
      if (!entry) continue;
      const { report, verdict } = entry;
      out.push(`### Set \`${set}\``, '');
      out.push('| Type | Masked/Total | Recall | Hand slice | Scope |');
      out.push('|---|---|---|---|---|');
      for (const t of report.byType) {
        const hand =
          t.handTotal === 0
            ? '—'
            : `${String(t.handMasked)}/${String(t.handTotal)} (${pct(recallOf(t.handMasked, t.handTotal))})`;
        out.push(
          `| ${t.type} | ${String(t.masked)}/${String(t.total)} | ` +
            `${pct(recallOf(t.masked, t.total))} | ${hand} | ${typeScope(t.type)} |`,
        );
      }
      out.push('');
      out.push('| Gate | Value | Threshold | Status |');
      out.push('|---|---|---|---|');
      for (const row of verdict.rows) {
        const status = row.enforced ? (row.pass ? 'PASS' : 'FAIL') : 'not gated';
        out.push(`| ${row.name} | ${row.value} | ${row.threshold} | ${status} |`);
      }
      out.push('');
      out.push(
        `**Verdict** (${verdict.note}): ` +
          `${verdict.gated ? (verdict.pass ? '**PASS**' : '**FAIL**') : 'n/a'}`,
      );
      out.push('');
    }
  }
  return out.join('\n');
}
