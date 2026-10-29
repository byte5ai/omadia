import type { PrivacyPromptMaskResult, PrivacyStoredTextScope } from '@omadia/plugin-api';

import {
  buildCacheShape,
  fillShape,
  isFollowUpShaped,
  type CachedPlan,
  type CacheShape,
  type CacheSlot,
} from './answerCacheShape.js';
import { PERSON_CANARY } from './exampleMasking.js';
import type { PlanMemory } from './learnedPlanStore.js';
import { parseRefreshSource } from './refreshRecipes.js';
import { validatePlannedQuery, type PlannedQuery } from './triage.js';

/**
 * Zero-LLM answer cache — skips BOTH triage calls (router + planner) when a
 * turn repeats a question shape the fast path already answered and verified.
 *
 *   - STORE: after a fast-path hit of an LLM-planned turn WITHOUT a previous
 *     query (self-contained), the question shape + the literal-stripped plan
 *     (answerCacheShape.ts) — only when the question's remaining words, the
 *     summary and the labels carry NO personal data by the Privacy Shield's
 *     own verdict (stored-text scope, canary-checked like a learned example;
 *     failure-closed: no shield → nothing stored). Tenant-wide, persisted
 *     next to the learned plans (`fastpath/answer-cache.json`), bounded LRU.
 *   - LOOKUP: before the router/planner (and before any masking — a hit
 *     sends nothing anywhere): exact match of the normalised shape, slots
 *     filled from the new question, re-validated against THIS agent's
 *     offered ∩ allowed tools. Any doubt is a reasoned miss → the normal
 *     router/planner path.
 *   - OUTCOME: a cache-sourced plan that misses on execution is evicted.
 *
 * Never holds rows, never logs a question or a slot value.
 */

export const ANSWER_CACHE_PATH = 'fastpath/answer-cache.json';
export const ANSWER_CACHE_SCHEMA_VERSION = 1;
export const MAX_CACHE_ENTRIES = 500;
/** PII-free job name the privacy guard logs with every check. */
export const ANSWER_CACHE_PRIVACY_JOB = 'fast-path-answer-cache';

export interface AnswerCacheEntry extends CacheShape {
  tool: string;
  hits: number;
  createdAt: string;
  lastUsedAt: string;
}

export type CacheLookup =
  | { hit: true; key: string; plan: PlannedQuery; slots: number }
  | { hit: false; reason: string };

/** Where a triage plan came from — the caller settles it after executing. */
export type CacheTicket =
  | { source: 'cache'; key: string; slots: number }
  | { source: 'llm'; question: string; previous: boolean };

export interface AnswerCache {
  /** Load once (idempotent); a missing/corrupt file starts empty. */
  load(): Promise<void>;
  /** Deterministic lookup — no model, no I/O. */
  lookup(req: { question: string; tools: ReadonlySet<string>; previous: boolean }): CacheLookup;
  /** Store the shape of an LLM-planned hit (privacy-checked, async). */
  remember(req: {
    question: string;
    plan: PlannedQuery;
    previous: boolean;
    openScope?: () => PrivacyStoredTextScope | undefined;
  }): Promise<{ stored: boolean; reason?: string }>;
  /** A cache-sourced plan answered. */
  recordHit(key: string): void;
  /** A cache-sourced plan missed on execution — drop it. */
  evict(key: string, reason: string): void;
  entries(): readonly AnswerCacheEntry[];
  /** Resolves when every pending write has settled (tests, shutdown). */
  settled(): Promise<void>;
}

const SLOT_TYPES: ReadonlySet<string> = new Set(['string', 'number']);
const LETTER_CASES: ReadonlySet<string> = new Set(['keep', 'lower', 'upper']);
const PLACEHOLDER = /^\{\{(text|email|id)_\d+\}\}$/;
const AFFIX = /^[%*_]{1,4}$/;

function parseSlot(raw: unknown): CacheSlot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const { placeholder, type, letterCase, prefix, suffix } = o;
  if (typeof placeholder !== 'string' || !PLACEHOLDER.test(placeholder)) return null;
  if (typeof type !== 'string' || !SLOT_TYPES.has(type)) return null;
  if (letterCase !== undefined && (typeof letterCase !== 'string' || !LETTER_CASES.has(letterCase))) return null;
  if (prefix !== undefined && (typeof prefix !== 'string' || !AFFIX.test(prefix))) return null;
  if (suffix !== undefined && (typeof suffix !== 'string' || !AFFIX.test(suffix))) return null;
  return {
    placeholder,
    type: type as CacheSlot['type'],
    ...(letterCase !== undefined ? { letterCase: letterCase as CacheSlot['letterCase'] } : {}),
    ...(prefix !== undefined ? { prefix } : {}),
    ...(suffix !== undefined ? { suffix } : {}),
  };
}

function parseStrings(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

/** Whitelist-parse one persisted entry; null = dropped. */
function parseEntry(raw: unknown): AnswerCacheEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const plan = o['plan'] as Record<string, unknown> | undefined;
  if (typeof o['key'] !== 'string' || o['key'].length === 0 || typeof plan !== 'object' || plan === null) return null;
  const fetch = parseRefreshSource(plan['fetch']);
  const labels = parseStrings(plan['labels']);
  if (!fetch || !labels || typeof plan['summary'] !== 'string') return null;
  if (!Array.isArray(o['slots'])) return null;
  const slots = o['slots'].map(parseSlot);
  if (slots.some((s) => s === null)) return null;
  const placeholders = new Set(o['key'].split(' ').filter((w) => PLACEHOLDER.test(w)));
  if (placeholders.size !== slots.length || slots.some((s) => !placeholders.has(s!.placeholder))) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const str = (v: unknown): string => (typeof v === 'string' ? v : new Date(0).toISOString());
  const cached: CachedPlan = {
    fetch,
    labels,
    summary: plan['summary'],
    ...(typeof plan['locale'] === 'string' ? { locale: plan['locale'] } : {}),
  };
  return {
    key: o['key'],
    tool: fetch.tool,
    plan: cached,
    slots: slots as CacheSlot[],
    hits: num(o['hits']),
    createdAt: str(o['createdAt']),
    lastUsedAt: str(o['lastUsedAt']),
  };
}

/** Why a mask result is not a clean "no personal data", else undefined.
 *  Spans that replaced ONLY slot sentinels are no personal data: the person
 *  detector reads "Posten von zzslot1zz" as a name (live), but a slot value
 *  is never stored. Spans carry no offsets, so that is proven on the masked
 *  text instead — every fixed part around the sentinels survives verbatim,
 *  in order; anything else counts as personal data (failure-closed). */
function unclean(r: PrivacyPromptMaskResult, text: string): string | undefined {
  if (r.outcome === 'blocked') return 'blocked';
  if (r.outcome !== 'masked') return r.outcome;
  if (r.degraded) return 'degraded';
  if (r.spans.length === 0) return undefined;
  // at most one span per sentinel, and the text really changed — a span
  // that left the text as it was cannot be attributed to a sentinel
  const sentinels = text.split(SENTINEL_SPLIT).length - 1;
  const onlySlots = r.spans.length <= sentinels && r.maskedText !== text && onlySentinelsMasked(text, r.maskedText);
  return onlySlots ? undefined : 'personal-data';
}

/** A stored text with its plan placeholders (`{{text_1}}`) as sentinels —
 *  the same "slot, not personal data" proof as the question's slot spans. */
function placeholdersAsSentinels(text: string): string {
  let n = 0;
  return text.replace(/\{\{[a-z]+_\d+\}\}/g, () => sentinel(++n));
}

const SENTINEL_SPLIT = /zzslot\d+zz/;

/** True when `masked` keeps every non-sentinel part of `text` verbatim and
 *  in order — i.e. the shield replaced nothing but the slot sentinels. */
export function onlySentinelsMasked(text: string, masked: string): boolean {
  const parts = text.split(SENTINEL_SPLIT);
  if (parts.length < 2) return false; // no sentinel: every span is real
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  if (!masked.startsWith(first) || !masked.endsWith(last)) return false;
  let pos = first.length;
  for (const part of parts.slice(1, -1)) {
    const at = masked.indexOf(part, pos);
    if (at < 0) return false;
    pos = at + part.length;
  }
  return masked.length - last.length >= pos;
}

const sentinel = (i: number): string => `zzslot${i}zz`;
const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LONG_NUMBER = /\b\d{5,}\b/;

/**
 * Privacy gate of a new entry: the question with its slot spans replaced by
 * neutral sentinels, the summary and the labels must contain NO personal
 * data at all (the shield finds no span; no e-mail, no long digit run) —
 * stricter than a learned example, which keeps typed placeholders: a cache
 * key must match deterministically, so anything personal is "do not cache".
 * Failure-closed exactly like exampleMasking.ts (canary for C1).
 */
async function privacyClean(
  texts: readonly string[],
  openScope: (() => PrivacyStoredTextScope | undefined) | undefined,
): Promise<string | undefined> {
  if (texts.some((t) => EMAIL_IN_TEXT.test(t) || LONG_NUMBER.test(t))) return 'personal-data';
  let scope: PrivacyStoredTextScope | undefined;
  try {
    scope = openScope?.();
  } catch {
    scope = undefined;
  }
  if (!scope) return 'privacy-unavailable';
  try {
    const canary = await scope.maskStoredText(PERSON_CANARY);
    if (canary.outcome !== 'masked' || canary.degraded || !canary.spans.some((s) => s.type === 'person')) {
      return 'person-check-unavailable';
    }
    for (const text of texts) {
      if (text.trim().length === 0) continue;
      const refused = unclean(await scope.maskStoredText(text), text);
      if (refused !== undefined) return refused;
    }
    return undefined;
  } catch {
    return 'mask-error';
  }
}

/** The RAW question (the user's own casing — a person detector needs it)
 *  with every slot span replaced by a neutral sentinel: what the privacy
 *  gate checks besides the slots themselves, which are never stored. */
function questionWithoutSlots(question: string, shape: CacheShape): string | undefined {
  const filled = fillShape(shape, question);
  if (!filled.ok) return undefined;
  let out = question;
  // right to left, so earlier offsets stay valid
  [...filled.slotSpans]
    .sort((a, b) => b[0] - a[0])
    .forEach(([start, end], i) => {
      out = `${out.slice(0, start)}${sentinel(i + 1)}${out.slice(end)}`;
    });
  return out;
}

export function createAnswerCache(opts: {
  memory?: PlanMemory;
  log: (message: string) => void;
  now?: () => Date;
  maxEntries?: number;
}): AnswerCache {
  const entries = new Map<string, AnswerCacheEntry>();
  const now = (): string => (opts.now?.() ?? new Date()).toISOString();
  const maxEntries = opts.maxEntries ?? MAX_CACHE_ENTRIES;
  let loading: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();
  let pending: Promise<unknown> = Promise.resolve();

  async function readFromMemory(): Promise<void> {
    const memory = opts.memory;
    if (!memory) return;
    try {
      if (!(await memory.exists(ANSWER_CACHE_PATH))) return;
      const doc = JSON.parse(await memory.readFile(ANSWER_CACHE_PATH)) as { schemaVersion?: unknown; entries?: unknown };
      if (doc?.schemaVersion !== ANSWER_CACHE_SCHEMA_VERSION || !Array.isArray(doc.entries)) {
        opts.log(`[fast-path] answer cache: unsupported file (schemaVersion=${String(doc?.schemaVersion)}) — starting empty`);
        return;
      }
      const parsed = doc.entries.map(parseEntry).filter((e): e is AnswerCacheEntry => e !== null);
      // Map order doubles as recency: oldest first
      parsed.sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt));
      for (const e of parsed.slice(-maxEntries)) entries.set(e.key, e);
      opts.log(`[fast-path] answer cache loaded: ${entries.size}`);
    } catch (err) {
      opts.log(`[fast-path] answer cache: unreadable file — starting empty: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Writes serialise behind each other; a failed write is logged, never thrown. */
  function persist(): Promise<void> {
    const memory = opts.memory;
    if (!memory) return Promise.resolve();
    const content = JSON.stringify({ schemaVersion: ANSWER_CACHE_SCHEMA_VERSION, entries: [...entries.values()] });
    writes = writes
      .then(() => memory.writeFile(ANSWER_CACHE_PATH, content))
      .catch((err: unknown) => {
        opts.log(`[fast-path] answer cache: write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return writes;
  }

  function touch(entry: AnswerCacheEntry): void {
    entries.delete(entry.key);
    entries.set(entry.key, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  function lookup(req: { question: string; tools: ReadonlySet<string>; previous: boolean }): CacheLookup {
    if (entries.size === 0) return { hit: false, reason: 'empty' };
    if (req.previous && isFollowUpShaped(req.question)) return { hit: false, reason: 'follow-up' };
    const matched: Array<{ entry: AnswerCacheEntry; plan: PlannedQuery }> = [];
    let lastReason = 'no-match';
    for (const entry of entries.values()) {
      const filled = fillShape(entry, req.question);
      if (!filled.ok) {
        if (filled.reason !== 'shape-mismatch') lastReason = filled.reason;
        continue;
      }
      if (!req.tools.has(entry.tool)) {
        lastReason = 'tool-not-offered';
        continue;
      }
      const validated = validatePlannedQuery(
        {
          fetch: filled.filled.fetch,
          labels: filled.filled.labels,
          summary: filled.filled.summary,
          ...(entry.plan.locale !== undefined ? { locale: entry.plan.locale } : {}),
        },
        req.tools,
        { question: req.question },
      );
      if (!validated.ok) {
        lastReason = `invalid:${validated.reason}`;
        continue;
      }
      matched.push({ entry, plan: validated.plan });
    }
    if (matched.length === 0) return { hit: false, reason: lastReason };
    // a slot-free exact match beats slotted ones; two equally good → doubt
    const best = Math.min(...matched.map((m) => m.entry.slots.length));
    const top = matched.filter((m) => m.entry.slots.length === best);
    if (top.length > 1) return { hit: false, reason: 'ambiguous' };
    const { entry, plan } = top[0]!;
    return { hit: true, key: entry.key, plan, slots: entry.slots.length };
  }

  async function remember(req: Parameters<AnswerCache['remember']>[0]): Promise<{ stored: boolean; reason?: string }> {
    const skip = (reason: string): { stored: false; reason: string } => {
      opts.log(`[fast-path] cache skip reason=${reason}`);
      return { stored: false, reason };
    };
    if (req.previous) return skip('previous-query');
    if (isFollowUpShaped(req.question)) return skip('follow-up');
    const built = buildCacheShape(req.question, req.plan);
    if (!built.ok) return skip(built.reason);
    const shape = built.shape;
    const checked = questionWithoutSlots(req.question, shape);
    if (checked === undefined) return skip('round-trip');
    const refused = await privacyClean(
      [checked, shape.plan.summary, ...Object.values(shape.plan.labels)].map(placeholdersAsSentinels),
      req.openScope,
    );
    if (refused !== undefined) return skip(`privacy:${refused}`);
    await (loading ??= readFromMemory());
    const t = now();
    const prev = entries.get(shape.key);
    touch({
      ...shape,
      tool: shape.plan.fetch.tool,
      hits: prev?.hits ?? 0,
      createdAt: prev?.createdAt ?? t,
      lastUsedAt: t,
    });
    opts.log(`[fast-path] cache stored tool=${shape.plan.fetch.tool} slots=${shape.slots.length} entries=${entries.size}`);
    await persist();
    return { stored: true };
  }

  return {
    load() {
      loading ??= readFromMemory();
      return loading;
    },
    lookup,
    remember(req) {
      const run = remember(req).catch((err: unknown) => {
        opts.log(`[fast-path] cache store failed: ${err instanceof Error ? err.message : 'error'}`);
        return { stored: false, reason: 'error' };
      });
      pending = pending.then(() => run);
      return run;
    },
    recordHit(key) {
      const e = entries.get(key);
      if (!e) return;
      touch({ ...e, hits: e.hits + 1, lastUsedAt: now() });
      void persist();
    },
    evict(key, reason) {
      const e = entries.get(key);
      if (!e) return;
      entries.delete(key);
      opts.log(`[fast-path] cache evicted tool=${e.tool} reason=${reason}`);
      void persist();
    },
    entries: () => [...entries.values()],
    async settled() {
      await pending;
      await writes;
    },
  };
}

/** A slot-filled cached plan that returned no rows: the slot may have
 *  captured the wrong words — never answered from the cache, re-planned. */
export const CACHE_DOUBT_REASON = 'cache-empty-result';

/** True when `outcome` is a slot-filled cache plan whose fetch returned no
 *  rows (see {@link CACHE_DOUBT_REASON}). */
export function isCacheDoubt(outcome: { kind: string; cache?: CacheTicket }, rows: number): boolean {
  return outcome.cache?.source === 'cache' && outcome.cache.slots > 0 && rows === 0;
}

/**
 * Book one executed triage plan: a cache-sourced plan that answered is kept
 * (hits, recency); one that missed is evicted — except a doubt, which says
 * nothing about the entry. An LLM-planned hit of a self-contained turn is
 * stored (async, privacy-checked; never awaited by the turn).
 */
export function settleAnswerCache(
  cache: AnswerCache,
  ticket: CacheTicket,
  plan: PlannedQuery,
  result: { ok: true } | { ok: false; reason: string },
  openScope: (() => PrivacyStoredTextScope | undefined) | undefined,
): void {
  if (ticket.source === 'cache') {
    if (result.ok) cache.recordHit(ticket.key);
    else if (result.reason !== CACHE_DOUBT_REASON) cache.evict(ticket.key, result.reason);
    return;
  }
  if (!result.ok || ticket.previous) return;
  void cache.remember({
    question: ticket.question,
    plan,
    previous: ticket.previous,
    ...(openScope ? { openScope } : {}),
  });
}

/** The `fast_path_answer_cache` setup value: on unless explicitly off. */
export function answerCacheEnabled(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  return ![false, 'false', 'off', '0', 'no'].includes(typeof raw === 'string' ? raw.trim().toLowerCase() : (raw as boolean));
}
