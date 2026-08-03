/**
 * OM-17 — server-side validation of setup-field values against the
 * manifest-declared `pattern`.
 *
 * WHY THIS EXISTS
 * A customer installed a plugin, saw an email field with a masked field
 * directly beneath it, and typed their work email plus their actual Google
 * account password. Both were accepted silently and confirmed as "gespeichert".
 * The fields actually wanted `…@….iam.gserviceaccount.com` and a PEM block out
 * of a service-account JSON key. Masking is purely type-driven in the UI, and
 * NOTHING on the server looked at the values at all.
 *
 * Client-side validation alone is theatre — the vault write happens on the
 * server, so the check has to happen there too. This module is the single
 * implementation shared by the install-commit path (`installService`) and the
 * post-install credentials patch (`routes/runtime.ts`), so the two can never
 * drift.
 *
 * A PLUGIN MANIFEST IS UNTRUSTED INPUT — TWO INDEPENDENT DEFENCES
 * ---------------------------------------------------------------
 * An earlier revision screened patterns with a *blacklist* ("does this look
 * like `(a+)+`?"). That is unsound and was proven so: `^(a|a)+$` sails straight
 * through such a screen and burns 1.7 seconds on a 26-character subject, which
 * halts the entire middleware event loop. Alternation-based blowups contain no
 * nested quantifier at all, and `((a+))+` defeats any `[^()]`-scoped rule. A
 * blacklist cannot be made sound, so this module no longer has one. Instead:
 *
 *   (a) EXECUTION BOUND — every match runs in a `node:worker_threads` worker
 *       under a hard wall-clock budget. A regex cannot be interrupted on the
 *       thread running it, so an in-process timer is not a bound; terminating
 *       the worker is. Overrun ⇒ the value is treated as a violation and the
 *       offending pattern is logged server-side. This holds for ANY pattern,
 *       including one nobody anticipated.
 *
 *   (b) ALLOWLIST GRAMMAR — {@link screenPatternSource} parses the pattern
 *       source and accepts only shapes that cannot blow up: no backreferences,
 *       no quantifier applied to a group that contains alternation or another
 *       quantifier, no quantified lookaround, bounded group nesting, and a cap
 *       on how large a counted repetition may be. Applied at manifest LOAD
 *       time. Counted repetition (`{n}` / `{n,}` / `{n,m}`) is governed by
 *       exactly the same rules as `*` and `+` — see {@link checkCountedBounds}.
 *
 * (b) is deliberately conservative and WILL reject legitimate-looking patterns
 * (`^[a-z]+(-[a-z]+)*$` is a real catastrophic-backtracking shape even though a
 * plugin author would write it innocently). That is the right trade — but a
 * rejected pattern must never *silently* disable validation, which is why
 * rejections are recorded in {@link getPatternProblems} and surfaced on the
 * setup field as `pattern_unavailable` so the operator can see the field is
 * unchecked. See `manifestLoader.ts` / `installService.ts`.
 *
 * WHY NOT RE2? A linear-time matcher would remove the need for (a) entirely,
 * but every Node binding for it is a native addon. omadia ships an Electron
 * desktop build, where a native addon has to be rebuilt per Electron ABI and
 * per platform (and would have to survive the code-signing/notarisation path
 * that already cost this repo several releases). A worker thread is pure
 * platform API, costs nothing at rest, and bounds the damage just as hard.
 *
 * ANCHORING: the web-ui puts the same source into an HTML `pattern=` attribute,
 * which the browser implicitly anchors as `^(?:…)$`. An unanchored server-side
 * `regex.test()` is a *substring* match, so `pattern: "[0-9]{4}"` would accept
 * `"my password is 1234"` — near-zero enforcement on exactly the
 * credential-confusion case this exists for. {@link anchorPatternSource} makes
 * the server match HTML semantics.
 *
 * BACKWARD COMPATIBILITY IS MANDATORY: a field that declares no `pattern` is
 * accepted exactly as before, and a pattern that fails to compile (or trips the
 * allowlist) is DROPPED — never a 500, never a blanket reject.
 */
import { Worker } from 'node:worker_threads';

/** Hard cap on the manifest-declared pattern source itself. */
export const MAX_PATTERN_SOURCE_LENGTH = 512;

/**
 * Hard cap on the value we are willing to run a regex over. Real credentials
 * top out well below this (a 4096-bit PEM private key is ~3.2 KB); anything
 * larger is rejected without ever touching the regex engine.
 *
 * NOTE: this is a resource cap, NOT a ReDoS defence. Exponential blowup peaks
 * around 25-30 characters, three orders of magnitude below this number. The
 * execution bound is what makes hostile patterns survivable.
 */
export const MAX_PATTERN_INPUT_LENGTH = 8192;

/**
 * Wall-clock budget for one match, enforced by terminating the worker. Setup
 * writes are rare and admin-only, so a generous bound costs nothing; a sane
 * credential pattern completes in microseconds.
 */
export const PATTERN_MATCH_BUDGET_MS = 50;

/** Deepest group nesting the allowlist accepts (root counts as depth 0). */
const MAX_GROUP_DEPTH = 2;

/**
 * Largest explicit repetition count the allowlist accepts, applied to BOTH
 * bounds of a counted quantifier (`{n}`, `{n,}`, `{n,m}`).
 *
 * This is defence in depth, not the safety floor. Measured on node 22:
 * `^[a-z]{1,100000}[a-z]{1,100000}$` against an 8191-char non-matching subject
 * takes 71 ms, versus 39 ms for `^[a-z]+[a-z]+$` — the same polynomial class as
 * the `+` form the allowlist has always accepted, not a new one. (V8 compiles
 * counted repetition with a counter rather than unrolling it, so a huge bound
 * is not a compile-time blowup either: `^a{100000,}$` compiles AND matches a
 * 100k subject in 0.43 ms.) The load-bearing bound is the 50 ms worker budget.
 *
 * The cap is kept because it is free and it keeps an untrusted manifest from
 * naming an arbitrary number, and it is kept at 100 rather than raised because
 * 100 covers every credential shape this feature exists for: DNS label ≤ 63,
 * TLD 2-63, SHA-256 hex 64, UUID segments, PIN/OTP lengths.
 */
const MAX_COUNTED_REPETITION = 100;

/** How long to wait for a freshly spawned worker to come online before giving
 *  up on it. Only ever hit if thread creation itself is broken. */
const WORKER_BOOT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// (b) Allowlist grammar
// ---------------------------------------------------------------------------

interface QuantifierToken {
  /** Characters consumed, including a trailing lazy `?`. */
  readonly length: number;
  /** True for `{n}` / `{n,}` / `{n,m}` — the counted forms. */
  readonly counted: boolean;
  /** Lower bound for a counted form. */
  readonly min?: number;
  /** Upper bound for a counted form; `undefined` means open-ended (`{n,}`). */
  readonly max?: number;
}

/** Parse a quantifier at `i`, or null when `i` is not the start of one. */
function parseQuantifier(src: string, i: number): QuantifierToken | null {
  const c = src[i];
  if (c === '*' || c === '+' || c === '?') {
    // A following `?` makes the quantifier lazy; it is part of THIS token, not
    // a second quantifier. (`??` is legal and means "lazy optional".)
    const lazy = src[i + 1] === '?' ? 1 : 0;
    return { length: 1 + lazy, counted: false };
  }
  if (c !== '{') return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
  if (!m) return null; // a `{` that is not a quantifier is a literal brace
  let length = m[0].length;
  if (src[i + length] === '?') length += 1;
  const min = Number(m[1]);
  const hasComma = m[2] !== undefined;
  const maxRaw = m[3];
  const max = !hasComma
    ? min
    : maxRaw === undefined || maxRaw === ''
      ? undefined
      : Number(maxRaw);
  return max === undefined
    ? { length, counted: true, min }
    : { length, counted: true, min, max };
}

/**
 * Size check for a counted quantifier. SHAPE is not this function's business:
 * `{n,}` is exactly `{1,}`-style open-ended repetition, i.e. the same thing `+`
 * and `*` express, and it is screened by the same group-content rules those go
 * through (see the `)` branch of {@link screenPatternSource}). Refusing `{n,}`
 * while accepting `+` bought no safety at all — it only forced manifest authors
 * to write `[A-Za-z][A-Za-z]+` where they meant `[A-Za-z]{2,}`, which is the
 * identical language spelled worse. All that is left here is the numeric cap.
 *
 * Both bounds are capped. For `{n,}` the only number an author supplies is the
 * MINIMUM, so leaving `min` unchecked would have handed an untrusted manifest
 * an unbounded knob the moment `{n,}` became legal.
 */
function checkCountedBounds(q: QuantifierToken): string | null {
  const largest = Math.max(q.min ?? 0, q.max ?? 0);
  if (largest > MAX_COUNTED_REPETITION) {
    return `counted repetition above ${MAX_COUNTED_REPETITION} is not allowed`;
  }
  return null;
}

interface GroupFrame {
  readonly lookaround: boolean;
  /** A `|` occurred directly in this frame, or was propagated up from a child. */
  alternation: boolean;
  /** A quantifier occurred in this frame, or was propagated up from a child. */
  quantifier: boolean;
}

/**
 * Conservative allowlist screen. Returns a human-readable reason when the
 * pattern is refused, or null when it is accepted.
 *
 * The rules, and the executed proof each one closes:
 *   - backreference (`\1`, `\k<n>`)          — makes matching NP-hard outright
 *   - quantified group containing `|`        — `^(a|a)+$` → 1739 ms on 26 chars
 *   - quantified group containing a quantifier — `^(a+)+$`, `^((a+))+$` → 412 ms
 *   - lookaround containing a quantifier     — same blowup, hidden behind `(?=)`
 *   - group nesting > 2                      — bounds what the two rules above
 *                                              have to reason about
 *   - a counted repetition above 100         — see {@link MAX_COUNTED_REPETITION}
 *
 * Alternation and quantifiers are PROPAGATED to the enclosing frame on close,
 * so wrapping a hostile shape in another group cannot launder it.
 *
 * The rules deliberately do NOT distinguish quantifier SPELLINGS. `+`, `*`,
 * `{2,}` and `{2,63}` are all "a quantifier": each is refused on a group that
 * contains alternation or another quantifier, and each is accepted on a simple
 * atom or character class. An earlier revision refused `{n,}` outright while
 * accepting `+` — logically the same construct — which bought no safety and
 * made `^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$` unwritable.
 */
export function screenPatternSource(source: string): string | null {
  const stack: GroupFrame[] = [
    { lookaround: false, alternation: false, quantifier: false },
  ];
  const top = (): GroupFrame => stack[stack.length - 1] as GroupFrame;
  let lastWasQuantifier = false;
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    if (c === '\\') {
      const n = source[i + 1];
      if (n === undefined) return 'trailing backslash';
      if (n >= '1' && n <= '9') return 'backreferences are not allowed';
      if (n === 'k' && source[i + 2] === '<') {
        return 'named backreferences are not allowed';
      }
      if ((n === 'p' || n === 'P') && source[i + 2] === '{') {
        // `\p{…}` — the braces belong to the escape, not to a quantifier.
        const close = source.indexOf('}', i + 3);
        if (close === -1) return 'unterminated unicode property escape';
        i = close + 1;
        lastWasQuantifier = false;
        continue;
      }
      i += 2;
      lastWasQuantifier = false;
      continue;
    }

    if (c === '[') {
      let j = i + 1;
      if (source[j] === '^') j += 1;
      if (source[j] === ']') j += 1; // a `]` in first position is a literal
      while (j < source.length && source[j] !== ']') {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      if (j >= source.length) return 'unterminated character class';
      i = j + 1;
      lastWasQuantifier = false;
      continue;
    }

    if (c === '(') {
      let lookaround = false;
      let skip = 1;
      if (source.startsWith('(?:', i)) {
        skip = 3;
      } else if (source.startsWith('(?=', i) || source.startsWith('(?!', i)) {
        lookaround = true;
        skip = 3;
      } else if (source.startsWith('(?<=', i) || source.startsWith('(?<!', i)) {
        lookaround = true;
        skip = 4;
      } else if (source.startsWith('(?<', i)) {
        const gt = source.indexOf('>', i);
        if (gt === -1) return 'malformed named group';
        skip = gt - i + 1;
      }
      stack.push({ lookaround, alternation: false, quantifier: false });
      if (stack.length - 1 > MAX_GROUP_DEPTH) {
        return `group nesting deeper than ${MAX_GROUP_DEPTH} is not allowed`;
      }
      i += skip;
      lastWasQuantifier = false;
      continue;
    }

    if (c === ')') {
      if (stack.length === 1) return 'unbalanced `)`';
      const frame = stack.pop() as GroupFrame;
      const parent = top();
      if (frame.lookaround && frame.quantifier) {
        return 'a lookaround containing a quantifier is not allowed';
      }
      const q = parseQuantifier(source, i + 1);
      if (q) {
        if (frame.alternation) {
          return 'a quantifier applied to a group containing alternation is not allowed';
        }
        if (frame.quantifier) {
          return 'a quantifier applied to a group containing a quantifier is not allowed';
        }
        if (q.counted) {
          const bad = checkCountedBounds(q);
          if (bad) return bad;
        }
        parent.quantifier = true;
        i += 1 + q.length;
        lastWasQuantifier = true;
      } else {
        i += 1;
        lastWasQuantifier = false;
      }
      // Launder-proofing: `((a+))+` must reject even though the OUTER group
      // contains no literal quantifier of its own.
      parent.alternation = parent.alternation || frame.alternation;
      parent.quantifier = parent.quantifier || frame.quantifier;
      continue;
    }

    if (c === '|') {
      top().alternation = true;
      i += 1;
      lastWasQuantifier = false;
      continue;
    }

    const q = parseQuantifier(source, i);
    if (q) {
      if (c === '?' && lastWasQuantifier) {
        // Laziness marker for the quantifier we just consumed.
        i += 1;
        lastWasQuantifier = false;
        continue;
      }
      if (q.counted) {
        const bad = checkCountedBounds(q);
        if (bad) return bad;
      }
      top().quantifier = true;
      i += q.length;
      lastWasQuantifier = true;
      continue;
    }

    i += 1;
    lastWasQuantifier = false;
  }

  if (stack.length !== 1) return 'unbalanced `(`';
  return null;
}

// ---------------------------------------------------------------------------
// Anchoring (F4 — match HTML `pattern=` semantics)
// ---------------------------------------------------------------------------

/** True when `source` ends in a `$` that is not itself escaped. */
function endsWithAnchor(source: string): boolean {
  if (!source.endsWith('$')) return false;
  let backslashes = 0;
  for (let i = source.length - 2; i >= 0 && source[i] === '\\'; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}

/**
 * Wrap a manifest pattern so a server-side `test()` means the same thing the
 * browser's `pattern=` attribute means: the WHOLE value must match.
 *
 * A pattern that already carries its own anchor is left alone. That is
 * deliberate and load-bearing: `^-----BEGIN [A-Z ]*PRIVATE KEY-----` is a
 * prefix check on a multi-line PEM block, and forcing `$` onto it would reject
 * every real private key. Authors opt into a prefix/suffix check by writing the
 * anchor themselves; authors who write neither get whole-value semantics.
 */
export function anchorPatternSource(source: string): string {
  if (source.startsWith('^') || endsWithAnchor(source)) return source;
  return `^(?:${source})$`;
}

// ---------------------------------------------------------------------------
// Compile cache + rejection registry (F2 — fail-open must be VISIBLE)
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly regex: RegExp | null;
  readonly reason?: string;
}

/**
 * Compiled-pattern cache. Keyed by the raw source, so two plugins declaring the
 * same pattern share one compile and a rejected pattern is only warned about
 * once per process.
 */
const compiled = new Map<string, CacheEntry>();

/** A pattern this process refused, and why. */
export interface PatternProblem {
  /** `pluginId/fieldKey` (or `install/fieldKey`) — wherever it was declared. */
  readonly context: string;
  readonly pattern: string;
  readonly reason: string;
}

const problems: PatternProblem[] = [];

/**
 * Every pattern this process refused. Read by diagnostics / support bundles.
 * The per-field signal the OPERATOR sees is `PluginSetupField.pattern_unavailable`,
 * set by the manifest projections when {@link compileSetupPattern} returns null.
 */
export function getPatternProblems(): readonly PatternProblem[] {
  return problems;
}

/**
 * Compile a manifest pattern, or return null when it is unusable. Unusable
 * patterns are recorded (see {@link getPatternProblems}) and then treated as
 * "no pattern declared" for the WRITE — bricking a plugin because its author
 * wrote an over-clever regex would be worse than not checking that one field —
 * but the caller MUST surface the drop, and both manifest projections do.
 *
 * The returned RegExp is already anchored; callers must not re-anchor.
 *
 * @param source  the raw pattern string from the manifest (no delimiters)
 * @param context human-readable origin used in the warning, e.g. `plugin/field`
 */
export function compileSetupPattern(
  source: string,
  context = 'setup field',
): RegExp | null {
  const cached = compiled.get(source);
  if (cached) {
    // Same pattern, different field: still record the problem against THIS
    // context, otherwise only the first plugin to declare it is diagnosable.
    if (cached.regex === null && cached.reason !== undefined) {
      recordProblem(context, source, cached.reason);
    }
    return cached.regex;
  }

  const entry = compileUncached(source, context);
  compiled.set(source, entry);
  return entry.regex;
}

function recordProblem(context: string, pattern: string, reason: string): void {
  if (problems.some((p) => p.context === context && p.pattern === pattern)) {
    return;
  }
  problems.push({ context, pattern, reason });
}

function reject(context: string, source: string, reason: string): CacheEntry {
  recordProblem(context, source, reason);
  console.warn(`[setup] dropping pattern for ${context}: ${reason}.`);
  return { regex: null, reason };
}

function compileUncached(source: string, context: string): CacheEntry {
  if (source.length > MAX_PATTERN_SOURCE_LENGTH) {
    return reject(
      context,
      source,
      `source exceeds ${MAX_PATTERN_SOURCE_LENGTH} characters`,
    );
  }
  const refused = screenPatternSource(source);
  if (refused !== null) {
    return reject(context, source, refused);
  }
  try {
    return { regex: new RegExp(anchorPatternSource(source)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reject(
      context,
      source,
      `not a valid regular expression (${message})`,
    );
  }
}

/** Test-only: clears the compile cache and problem registry. */
export function resetSetupPatternCache(): void {
  compiled.clear();
  problems.length = 0;
}

// ---------------------------------------------------------------------------
// (a) Execution bound — a pooled worker thread with a hard wall-clock budget
// ---------------------------------------------------------------------------

/**
 * Worker body, kept as a string and started with `eval: true` on purpose: the
 * middleware runs from `src/` under tsx in tests and from `dist/` in
 * production, and a separate worker FILE would need a different specifier in
 * each. A string has no resolution story at all.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (msg) => {
  let matched = false;
  let error = null;
  try {
    matched = new RegExp(msg.source, msg.flags).test(msg.value);
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }
  parentPort.postMessage({ id: msg.id, matched, error });
});
`;

interface WorkerReply {
  readonly id: number;
  readonly matched: boolean;
  readonly error: string | null;
}

let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let requestId = 0;
/** Serialises matches: one worker, one regex at a time, so a terminated worker
 *  can never strand an unrelated in-flight request. */
let queue: Promise<unknown> = Promise.resolve();

function ensureWorker(): { w: Worker; ready: Promise<void> } {
  if (worker !== null && workerReady !== null) {
    return { w: worker, ready: workerReady };
  }
  const w = new Worker(WORKER_SOURCE, { eval: true });
  // Starts REF'd so thread boot cannot be starved by an otherwise-idle event
  // loop, then unrefs itself: an idle pattern worker must never be the reason
  // the process (or a test run) refuses to exit.
  const ready = new Promise<void>((resolve) => {
    const boot = setTimeout(resolve, WORKER_BOOT_TIMEOUT_MS);
    boot.unref();
    w.once('online', () => {
      clearTimeout(boot);
      w.unref();
      resolve();
    });
  });
  const drop = (): void => {
    if (worker === w) {
      worker = null;
      workerReady = null;
    }
  };
  w.on('error', drop);
  w.on('exit', drop);
  worker = w;
  workerReady = ready;
  return { w, ready };
}

export type MatchOutcome = 'match' | 'no-match' | 'overrun';

/**
 * Run `regex` against `value` in a worker under {@link PATTERN_MATCH_BUDGET_MS}.
 *
 * Returns `'overrun'` when the budget expired (the worker is terminated and
 * discarded — a wedged regex cannot be interrupted any other way), when the
 * worker died, or when the pattern failed to compile inside the worker.
 */
export async function matchWithBudget(
  regex: RegExp,
  value: string,
): Promise<MatchOutcome> {
  const run = async (): Promise<MatchOutcome> => {
    const { w, ready } = ensureWorker();
    await ready;
    const id = (requestId += 1);
    return await new Promise<MatchOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: MatchOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onFailure);
        w.off('exit', onFailure);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        finish('overrun');
        if (worker === w) {
          worker = null;
          workerReady = null;
        }
        void w.terminate();
      }, PATTERN_MATCH_BUDGET_MS);
      const onMessage = (raw: unknown): void => {
        const reply = raw as WorkerReply | null;
        if (!reply || reply.id !== id) return;
        if (reply.error !== null) {
          finish('overrun');
          return;
        }
        finish(reply.matched ? 'match' : 'no-match');
      };
      const onFailure = (): void => {
        finish('overrun');
      };
      w.on('message', onMessage);
      w.on('error', onFailure);
      w.on('exit', onFailure);
      w.postMessage({ id, source: regex.source, flags: regex.flags, value });
    });
  };

  const result = queue.then(run, run);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return await result;
}

/** Test/shutdown seam: terminate the pooled worker. */
export async function shutdownPatternWorker(): Promise<void> {
  const w = worker;
  worker = null;
  workerReady = null;
  if (w) await w.terminate();
}

// ---------------------------------------------------------------------------
// Field-level API
// ---------------------------------------------------------------------------

/** The subset of a setup field this module needs. */
export interface PatternCheckableField {
  key: string;
  label?: string;
  pattern?: string;
  pattern_hint?: Record<string, string> | undefined;
}

export interface PatternViolation {
  /** The setup-field key that failed. */
  field: string;
  /**
   * The manifest's own explanation of the expected shape, when it declared one,
   * resolved to ENGLISH.
   *
   * DELIBERATELY OPTIONAL and never server-generated: the web-ui owns all
   * user-facing copy (`messages/{en,de}.json`) and renders its own localized
   * fallback when this is absent. A generated English or German sentence here
   * would be an untranslatable string smuggled in through the API.
   *
   * WHY ENGLISH, ALWAYS — and why that is not a localization bug. The middleware
   * has no notion of a request locale: nothing reads `Accept-Language`, no
   * locale cookie reaches it, and the web-ui's `NEXT_LOCALE` never leaves the
   * Next.js layer. Manufacturing one just for this field would be the same
   * "untranslatable string smuggled in through the API" mistake in a different
   * costume — the server would be picking a language for a client it cannot see.
   *
   * So this stays the documented fallback for API clients that have no manifest
   * of their own (curl, the install CLI, third-party integrations). Anything
   * that HOLDS the manifest — i.e. the web-ui, which renders
   * `field.pattern_hint` next to the input already — must resolve the localized
   * map itself, keyed on {@link PatternViolation.field}, and use this only when
   * the key matches no field it knows about. See
   * `web-ui/app/_lib/setupFieldPattern.ts` → `resolveSetupFieldHint`.
   */
  hint?: string;
}

/**
 * Pick the best hint string out of a `{ locale: text }` map. Mirrors the
 * web-ui's `pickLocalized`: preferred locale, then `en`, then `de`, then
 * anything. Kept local so this module stays dependency-free.
 *
 * `locale` exists for callers that genuinely have one. The middleware does not
 * (see {@link PatternViolation.hint}), so every production call resolves to
 * English by default and the CLIENT does the localized pick.
 */
export function pickPatternHint(
  map: Record<string, string> | undefined,
  locale = 'en',
): string | undefined {
  if (!map) return undefined;
  const direct = map[locale];
  if (direct && direct.trim().length > 0) return direct;
  for (const fallback of ['en', 'de']) {
    const v = map[fallback];
    if (v && v.trim().length > 0) return v;
  }
  for (const v of Object.values(map)) {
    if (v && v.trim().length > 0) return v;
  }
  return undefined;
}

/**
 * Validate one value against one field's declared pattern.
 *
 * Returns null when the value is acceptable — which includes every field that
 * declares no pattern, every EMPTY value, and every pattern the allowlist
 * refused.
 *
 * EMPTY VALUES ARE SKIPPED, and the client (`web-ui/app/_lib/setupFieldPattern.ts`)
 * does the same. An empty string means "not set"; whether that is allowed is
 * `required`'s job, and `required` is enforced separately. Without this an
 * OPTIONAL patterned field could never be cleared: the client showed no error,
 * the server tested `""` against e.g. `^sk-[A-Za-z0-9]+$`, and returned 400.
 */
export async function checkSetupFieldPattern(
  field: PatternCheckableField,
  value: string,
  context = field.key,
): Promise<PatternViolation | null> {
  if (!field.pattern) return null;
  if (value.length === 0) return null;

  // English on purpose, and no `locale` parameter to imply otherwise: there is
  // no request locale on this side of the wire. See `PatternViolation.hint`.
  const hint = pickPatternHint(field.pattern_hint);
  const violation: PatternViolation = hint
    ? { field: field.key, hint }
    : { field: field.key };

  // Resource cap, checked before the engine ever sees the subject.
  if (value.length > MAX_PATTERN_INPUT_LENGTH) return violation;

  const regex = compileSetupPattern(field.pattern, context);
  if (!regex) return null; // refused pattern → surfaced via `pattern_unavailable`

  const outcome = await matchWithBudget(regex, value);
  if (outcome === 'overrun') {
    // The pattern (not the value) is the problem, but we cannot prove the value
    // is acceptable, so fail CLOSED for this write and make the pattern
    // diagnosable. The operator sees the field's generic "wrong format" copy.
    console.error(
      `[setup] pattern match exceeded ${PATTERN_MATCH_BUDGET_MS}ms for ${context}; ` +
        `treating the value as a violation. pattern=${JSON.stringify(field.pattern)}`,
    );
    recordProblem(
      context,
      field.pattern,
      `match exceeded the ${PATTERN_MATCH_BUDGET_MS}ms execution budget`,
    );
    return violation;
  }
  return outcome === 'match' ? null : violation;
}
