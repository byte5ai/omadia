/**
 * OM-17 — client-side mirror of the server's setup-field pattern check.
 *
 * This is the FAST half, not the load-bearing half. The server
 * (`middleware/src/plugins/setupFieldPattern.ts`) is what actually protects the
 * vault; this exists so the operator sees the problem before hitting Save
 * instead of after a round trip.
 *
 * The two halves must agree on THREE things, and each one was a real bug:
 *   1. EMPTY VALUES ARE SKIPPED. An empty string means "not set"; whether that
 *      is allowed is `required`'s job. When only this file skipped them, an
 *      OPTIONAL patterned field could never be cleared — the client showed no
 *      error, the server tested `""` against the pattern and returned 400.
 *   2. ANCHORING. The server wraps an unanchored pattern as `^(?:…)$` to match
 *      HTML `pattern=` semantics. {@link anchorPatternSource} here is the same
 *      function, character for character.
 *   3. WHICH PATTERNS ARE USABLE AT ALL. {@link screenPatternSource} is the same
 *      allowlist grammar. A plugin manifest is untrusted input here too: a
 *      hostile pattern would run in the operator's browser on every keystroke,
 *      and the browser has no worker-thread execution bound to fall back on, so
 *      the grammar is the ONLY defence on this side. It must not be weakened.
 *
 * An earlier revision screened with a blacklist ("looks like `(a+)+`?"). That is
 * unsound — `^(a|a)+$` passes it and burns ~1.7 s on a 26-character subject —
 * and has been replaced. See the server module header for the full rationale.
 */

import { pickLocalized } from './localized';
import type { PluginSetupField } from './storeTypes';

/** Mirrors the server's `MAX_PATTERN_SOURCE_LENGTH`. */
const MAX_PATTERN_SOURCE_LENGTH = 512;

/** Mirrors the server's `MAX_PATTERN_INPUT_LENGTH`. */
const MAX_PATTERN_INPUT_LENGTH = 8192;

/** Mirrors the server's `MAX_GROUP_DEPTH`. */
const MAX_GROUP_DEPTH = 2;

/** Mirrors the server's `MAX_COUNTED_REPETITION`. */
const MAX_COUNTED_REPETITION = 100;

interface QuantifierToken {
  readonly length: number;
  readonly counted: boolean;
  readonly min?: number;
  readonly max?: number;
}

function parseQuantifier(src: string, i: number): QuantifierToken | null {
  const c = src[i];
  if (c === '*' || c === '+' || c === '?') {
    const lazy = src[i + 1] === '?' ? 1 : 0;
    return { length: 1 + lazy, counted: false };
  }
  if (c !== '{') return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
  if (!m) return null;
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
 * Size cap only — shape is the group-content rules' job, and they treat `{n,}`
 * exactly like the `+` it is equivalent to. Both bounds are capped because for
 * `{n,}` the minimum is the only number the manifest supplies.
 */
function checkCountedBounds(q: QuantifierToken): string | null {
  const largest = Math.max(q.min ?? 0, q.max ?? 0);
  if (largest > MAX_COUNTED_REPETITION) return 'counted repetition too large';
  return null;
}

interface GroupFrame {
  readonly lookaround: boolean;
  alternation: boolean;
  quantifier: boolean;
}

/**
 * Conservative allowlist screen — the exact rules the server applies. Returns a
 * reason string when the pattern is refused, or null when it is accepted.
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
      if (source[j] === ']') j += 1;
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
      if (stack.length - 1 > MAX_GROUP_DEPTH) return 'group nesting too deep';
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

/** True when `source` ends in a `$` that is not itself escaped. */
function endsWithAnchor(source: string): boolean {
  if (!source.endsWith('$')) return false;
  let backslashes = 0;
  for (let i = source.length - 2; i >= 0 && source[i] === '\\'; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}

function startsWithAnchor(source: string): boolean {
  return source.startsWith('^');
}

/** Byte-for-byte the server's `anchorPatternSource`. */
export function anchorPatternSource(source: string): string {
  if (startsWithAnchor(source) || endsWithAnchor(source)) return source;
  return `^(?:${source})$`;
}

const compiled = new Map<string, RegExp | null>();

function compilePattern(source: string): RegExp | null {
  const cached = compiled.get(source);
  if (cached !== undefined) return cached;

  let regex: RegExp | null = null;
  if (
    source.length <= MAX_PATTERN_SOURCE_LENGTH &&
    screenPatternSource(source) === null
  ) {
    try {
      regex = new RegExp(anchorPatternSource(source));
    } catch {
      regex = null;
    }
  }
  compiled.set(source, regex);
  return regex;
}

/** True when this pattern was refused by the safety screen — i.e. the field is
 *  going UNCHECKED and the UI must say so rather than pretend it is validated. */
export function isPatternUsable(pattern: string | undefined): boolean {
  if (!pattern) return true;
  return compilePattern(pattern) !== null;
}

/**
 * The value to put in an `<input pattern="…">`, or `undefined` when the native
 * attribute cannot express what the server enforces.
 *
 * The browser ALWAYS anchors the attribute as `^(?:…)$`. That agrees with the
 * server for a pattern with BOTH anchors or NEITHER (the server wraps the
 * latter identically). It DISAGREES for a half-anchored pattern: the server
 * honours `^-----BEGIN [A-Z ]*PRIVATE KEY-----` as a prefix check on a
 * multi-line PEM block, while the browser would demand the value end right
 * there and block the submit of every real private key. In that case emit no
 * attribute and let the server — which is the authority — decide.
 */
export function nativePatternAttribute(
  pattern: string | undefined,
): string | undefined {
  if (!pattern) return undefined;
  if (!isPatternUsable(pattern)) return undefined;
  const head = startsWithAnchor(pattern);
  const tail = endsWithAnchor(pattern);
  return head === tail ? pattern : undefined;
}

/**
 * True when `value` is unacceptable for `field`.
 *
 * Returns false — i.e. "fine" — for a field with no pattern, for an EMPTY value
 * (`required` is a separate, already-implemented concern), and for a pattern the
 * safety screen refused. The server's `checkSetupFieldPattern` makes exactly the
 * same three exemptions, in the same order.
 */
export function violatesSetupPattern(
  field: Pick<PluginSetupField, 'pattern'>,
  value: string,
): boolean {
  if (!field.pattern || value.length === 0) return false;
  if (value.length > MAX_PATTERN_INPUT_LENGTH) return true;
  const regex = compilePattern(field.pattern);
  if (!regex) return false;
  regex.lastIndex = 0;
  return !regex.test(value);
}

// ---------------------------------------------------------------------------
// Localizing the server's pattern rejection
// ---------------------------------------------------------------------------

/** The subset of a setup field the hint resolution needs. Structurally shared by
 *  `PluginSetupField` (post-install editor) and `InstallSetupField` (wizard). */
interface HintableField {
  key: string;
  pattern_hint?: Record<string, string> | undefined;
}

/**
 * Resolve the operator-facing text for a server-side pattern rejection, in the
 * ACTIVE locale.
 *
 * WHY THIS EXISTS. The middleware has no request locale — nothing there reads
 * `Accept-Language` and `NEXT_LOCALE` never leaves the Next.js layer — so its
 * `hint` is always the English entry of the manifest's `pattern_hint` map. A
 * German operator hitting the server check (install wizard, an API client, any
 * route where the client-side check is bypassed) got an English sentence.
 * "English field labels and help texts in a German UI" was itself one of the
 * named contributing factors of OM-17, so shipping the OM-17 fix that way would
 * have been an own goal.
 *
 * The fix needs no API change: we are holding the whole `{ locale: text }` map
 * already — the editor and the wizard both render it under the input — so we
 * pick from it ourselves, keyed on the `field`/`key` the server named. The
 * server's English `hint` stays the fallback for the one case where that cannot
 * work: a key matching no field this client knows about.
 *
 * @param fields      the manifest setup fields this view is rendering
 * @param fieldKey    the offending key as named by the server (may be unknown)
 * @param serverHint  the server's English hint, used only as a fallback
 * @param locale      the active UI locale
 */
export function resolveSetupFieldHint(
  fields: ReadonlyArray<HintableField>,
  fieldKey: string | undefined,
  serverHint: string | undefined,
  locale: string,
): string | undefined {
  const field = fieldKey
    ? fields.find((f) => f.key === fieldKey)
    : undefined;
  return pickLocalized(field?.pattern_hint, locale) ?? serverHint;
}
