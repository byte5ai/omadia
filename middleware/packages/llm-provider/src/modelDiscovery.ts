/**
 * Discovery rules engine: turn a provider's LIVE model list (what its own
 * list-models API returned) into catalog `ModelInfo` entries.
 *
 * This is the piece that lets the catalog stop naming model versions. A
 * descriptor declares FAMILY rules (`^claude-opus-`, `-nano$`), the vendor
 * says which concrete ids exist right now, and this module decides:
 *
 *  - which ids are chat models we want at all (`include` / `exclude`,
 *    retired ids, dated snapshots collapsed onto their undated twin);
 *  - the class tier per id (first matching rule; a rule may put its older
 *    generations in a different class via `restClass`);
 *  - the ONE model per rule that is "current" (`select: newest`), which
 *    carries the rule's aliases (`opus`, `sonnet`, …);
 *  - the class default per (provider, class) — rule order is the operator's
 *    preference, newest wins within a rule;
 *  - capability fields the vendor omitted, filled from the seed entry of the
 *    same id, then the rule's fallbacks, then conservative defaults.
 *
 * Pure and synchronous: no I/O, no registry mutation. The caller registers
 * the result into the catalog (which validates the registry invariants).
 */
import type {
  DiscoveredModel,
  LlmProviderDescriptor,
  ModelClass,
  ModelDiscoveryClassRule,
  ModelDiscoveryRules,
  ModelInfo,
} from '@omadia/llm-provider-api';

export type DiscoveryDropReason =
  | 'retired'
  | 'not-included'
  | 'excluded'
  | 'dated-snapshot'
  | 'unclassified';

export interface DiscoveryDrop {
  readonly modelId: string;
  readonly reason: DiscoveryDropReason;
}

export interface DiscoveryOutcome {
  readonly models: ReadonlyArray<ModelInfo>;
  readonly dropped: ReadonlyArray<DiscoveryDrop>;
}

/** Conservative caps when neither vendor, seed nor rule says otherwise. */
const DEFAULT_MAX_TOKENS = 8_192;
const DEFAULT_CONTEXT_WINDOW = 128_000;

const DATED_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

function compileAll(sources: ReadonlyArray<string> | undefined): RegExp[] {
  return (sources ?? []).map((s) => new RegExp(s, 'i'));
}

/** Numeric tokens of an id (`claude-opus-4-8` → [4, 8]; `gpt-5.6-sol` → [5, 6])
 *  for the version tiebreak. Dated suffixes are stripped first so a snapshot
 *  never outranks its base id on the calendar digits. */
export function versionTokens(modelId: string): number[] {
  const base = modelId.replace(DATED_SUFFIX, '');
  return (base.match(/\d+/g) ?? []).map((n) => Number.parseInt(n, 10));
}

function compareVersionTokens(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Newest-first ordering: latest `createdAt`, then highest version tokens,
 * then vendor order (stable). A model without `createdAt` sorts below any
 * model with one only when the other comparators tie — the version tokens
 * are what usually decide.
 */
export function compareNewest(
  a: { readonly model: DiscoveredModel; readonly index: number },
  b: { readonly model: DiscoveredModel; readonly index: number },
): number {
  const ta = a.model.createdAt !== undefined ? Date.parse(a.model.createdAt) : Number.NaN;
  const tb = b.model.createdAt !== undefined ? Date.parse(b.model.createdAt) : Number.NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
  const byVersion = compareVersionTokens(
    versionTokens(b.model.modelId),
    versionTokens(a.model.modelId),
  );
  if (byVersion !== 0) return byVersion;
  if (!Number.isNaN(ta) && Number.isNaN(tb)) return -1;
  if (Number.isNaN(ta) && !Number.isNaN(tb)) return 1;
  return a.index - b.index;
}

/** Drop `X-20251001` / `X-2026-04-23` when `X` is also listed. */
export function collapseDatedSnapshots(
  models: ReadonlyArray<DiscoveredModel>,
): { kept: DiscoveredModel[]; dropped: DiscoveryDrop[] } {
  const ids = new Set(models.map((m) => m.modelId));
  const kept: DiscoveredModel[] = [];
  const dropped: DiscoveryDrop[] = [];
  for (const m of models) {
    const base = m.modelId.replace(DATED_SUFFIX, '');
    if (base !== m.modelId && ids.has(base)) {
      dropped.push({ modelId: m.modelId, reason: 'dated-snapshot' });
    } else {
      kept.push(m);
    }
  }
  return { kept, dropped };
}

interface Classified {
  readonly model: DiscoveredModel;
  readonly index: number;
  readonly ruleIndex: number;
  readonly rule: ModelDiscoveryClassRule;
}

function isRetired(model: DiscoveredModel, now: number): boolean {
  if (model.shutdownAt === undefined) return false;
  const t = Date.parse(model.shutdownAt);
  return !Number.isNaN(t) && t <= now;
}

function renderLabel(rule: ModelDiscoveryClassRule, model: DiscoveredModel): string {
  if (model.label !== undefined && model.label.trim().length > 0) return model.label.trim();
  if (rule.label !== undefined) return rule.label.replaceAll('{id}', model.modelId);
  return model.modelId;
}

function pickEffort(
  model: DiscoveredModel,
  rule: ModelDiscoveryClassRule,
  seed: ModelInfo | undefined,
): Pick<ModelInfo, 'effortLevels' | 'effortDefault'> {
  const levels =
    model.effortLevels !== undefined && model.effortLevels.length > 0
      ? model.effortLevels
      : (seed?.effortLevels ?? rule.effortLevels);
  if (levels === undefined || levels.length === 0) return {};
  const wanted = rule.effortDefault ?? seed?.effortDefault;
  const effortDefault = wanted !== undefined && levels.includes(wanted) ? wanted : undefined;
  return {
    effortLevels: [...levels],
    ...(effortDefault !== undefined ? { effortDefault } : {}),
  };
}

/**
 * Apply `descriptor.discovery` to a live model list. Throws only when the
 * descriptor declares no discovery rules — everything else degrades to a
 * smaller (possibly empty) result plus the `dropped` audit trail.
 */
export function applyDiscoveryRules(
  descriptor: LlmProviderDescriptor,
  discovered: ReadonlyArray<DiscoveredModel>,
  opts: { readonly now?: Date } = {},
): DiscoveryOutcome {
  const rules: ModelDiscoveryRules | undefined = descriptor.discovery;
  if (rules === undefined) {
    throw new Error(
      `provider '${descriptor.id}' declares no discovery rules — nothing to apply`,
    );
  }
  const now = (opts.now ?? new Date()).getTime();
  const include = compileAll(rules.include);
  const exclude = compileAll(rules.exclude);
  const compiled = rules.classify.map((rule) => ({ rule, re: new RegExp(rule.match, 'i') }));
  const seedById = new Map(descriptor.models.map((m) => [m.modelId, m]));
  const dropped: DiscoveryDrop[] = [];

  // 1. Retired / include / exclude.
  const filtered: DiscoveredModel[] = [];
  for (const m of discovered) {
    if (isRetired(m, now)) {
      dropped.push({ modelId: m.modelId, reason: 'retired' });
    } else if (include.length > 0 && !include.some((re) => re.test(m.modelId))) {
      dropped.push({ modelId: m.modelId, reason: 'not-included' });
    } else if (exclude.some((re) => re.test(m.modelId))) {
      dropped.push({ modelId: m.modelId, reason: 'excluded' });
    } else {
      filtered.push(m);
    }
  }

  // 2. Dated snapshots collapse onto their undated twin.
  const collapsed =
    rules.collapseDatedSnapshots === false
      ? { kept: filtered, dropped: [] as DiscoveryDrop[] }
      : collapseDatedSnapshots(filtered);
  dropped.push(...collapsed.dropped);

  // 3. Classify: first matching rule wins.
  const classified: Classified[] = [];
  collapsed.kept.forEach((model, index) => {
    const hit = compiled.findIndex((c) => c.re.test(model.modelId));
    if (hit === -1) {
      dropped.push({ modelId: model.modelId, reason: 'unclassified' });
      return;
    }
    classified.push({ model, index, ruleIndex: hit, rule: compiled[hit]!.rule });
  });

  // 4. Per rule: the selected ("current") model carries aliases + `class`;
  //    the rest get `restClass` (or `class`).
  const byRule = new Map<number, Classified[]>();
  for (const c of classified) {
    const list = byRule.get(c.ruleIndex) ?? [];
    list.push(c);
    byRule.set(c.ruleIndex, list);
  }
  const selectedOfRule = new Map<number, Classified>();
  for (const [ruleIndex, list] of byRule) {
    const ordered =
      rules.select === 'first' ? [...list].sort((a, b) => a.index - b.index) : [...list].sort(compareNewest);
    selectedOfRule.set(ruleIndex, ordered[0]!);
  }

  // 5. Class defaults: rule order is the preference; within a rule the
  //    selected model first, then the select policy (newest / vendor order).
  const assigned = classified.map((c) => {
    const selected = selectedOfRule.get(c.ruleIndex) === c;
    const cls: ModelClass = selected ? c.rule.class : (c.rule.restClass ?? c.rule.class);
    return { ...c, selected, cls };
  });
  type Assigned = (typeof assigned)[number];
  const byPreference = (a: Assigned, b: Assigned): number =>
    a.ruleIndex - b.ruleIndex ||
    Number(b.selected) - Number(a.selected) ||
    (rules.select === 'first' ? a.index - b.index : compareNewest(a, b));
  const classDefault = new Map<ModelClass, Assigned>();
  for (const cls of ['fast', 'balanced', 'frontier'] as const) {
    const candidates = assigned.filter((a) => a.cls === cls).sort(byPreference);
    if (candidates.length > 0) classDefault.set(cls, candidates[0]!);
  }

  // 6. Materialise ModelInfo in preference order.
  const ordered = [...assigned].sort(byPreference);
  const models: ModelInfo[] = ordered.map((a) => {
    const seed = seedById.get(a.model.modelId);
    const aliases = a.selected ? a.rule.aliases : undefined;
    const isDefault = classDefault.get(a.cls) === a;
    const classCount = assigned.filter((x) => x.cls === a.cls).length;
    return {
      id: `${descriptor.id}:${a.model.modelId}`,
      provider: descriptor.id,
      modelId: a.model.modelId,
      label: renderLabel(a.rule, a.model),
      class: a.cls,
      maxTokens: a.model.maxTokens ?? seed?.maxTokens ?? a.rule.maxTokens ?? DEFAULT_MAX_TOKENS,
      contextWindow:
        a.model.contextWindow ?? seed?.contextWindow ?? a.rule.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      vision: a.model.vision ?? seed?.vision ?? a.rule.vision ?? false,
      ...(aliases !== undefined && aliases.length > 0 ? { aliases: [...aliases] } : {}),
      // The registry demands exactly one classDefault only when a class has
      // >1 model; setting it on a lone model is harmless and keeps intent clear.
      ...(isDefault && classCount > 1 ? { classDefault: true } : {}),
      ...pickEffort(a.model, a.rule, seed),
    };
  });

  return { models, dropped };
}
