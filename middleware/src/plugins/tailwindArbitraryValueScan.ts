/**
 * Ingest gate for Tailwind arbitrary values in a plugin's compiled UI bundle
 * (epic #470 C8 / plan.md §4.3a).
 *
 * WHY. Plugins ship no stylesheet — `.css` is absent from the ZIP extension
 * allowlist and stays absent, because that absence is what forces every
 * plugin onto the one stylesheet core serves. That sheet is generated from a
 * finite, documented vocabulary (`plugin-ui-vocabulary.md`, in the epic
 * #470 spec directory). An *exact* arbitrary value can be
 * pre-generated — `@source inline("w-[137px]")` emits it — but the universe
 * of them cannot, so a class core never saw silently renders unstyled. Silent
 * is the worst failure mode available: the package installs, the page loads,
 * and the layout is subtly wrong on the operator's screen only.
 *
 * So the check runs at ingest, where it can say no with a filename and a line.
 *
 * WHAT IT SEES. Not JSX. By the time a package reaches us the UI is compiled
 * Vite/Rollup output, so the class list survives as string literals and
 * template chunks inside `.js`. That is why this scans text rather than
 * parsing attributes: `className={cn('p-4', wide && 'w-[137px]')}` has become
 * `"p-4"` and `"w-[137px]"` in the bundle, and both are plain substrings.
 *
 * THE TWO PATTERNS
 *
 *   1. `utility-[value]`   — `w-[137px]`, `bg-[#abc]`, `grid-cols-[1fr_2fr]`,
 *      including variant prefixes: `md:hover:w-[137px]`.
 *   2. `[&…]` variants     — `[&>tr]:border`, `[&_p]:mt-2`. These are
 *      arbitrary *variants* rather than values; same problem, different
 *      syntax, so they get their own pattern.
 *
 * KNOWN LIMITS — stated rather than papered over, because a scanner whose
 * blind spots are undocumented gets trusted past its competence:
 *
 *   - FALSE POSITIVES are possible. The patterns match text, and text in a
 *     bundle is not only class names. `pick-[a]` inside a regex literal, a
 *     CSS-in-JS string, or a user-facing message would be reported. The
 *     mitigation is the report, not the regex: the offender list carries the
 *     file, the 1-based line and the matched token, so an author can see in
 *     one glance that the hit is not a class. Two narrowings keep the rate
 *     low in practice: the utility head must be lower-case-and-dashes (so
 *     `getFoo[0]` and `arr[i]` never match), and the bracket body may not
 *     contain whitespace, quotes or backticks (so most prose and most
 *     expressions drop out).
 *   - FALSE NEGATIVES are possible too, and they are the safer direction. A
 *     bundle that assembles a class at runtime (`'w-[' + n + 'px]'`) defeats
 *     any static check, and so do unicode/hex-escaped brackets
 *     (`"w-\u005b10px\u005d"`). Nothing here claims otherwise: the vocabulary
 *     is the contract, this is the cheap enforcement of it, and a plugin
 *     determined to route around it merely ends up with an unstyled element.
 *   - Only files the caller passes are examined. The caller scans
 *     `ui/**\/*.js`; a plugin that puts its bundle elsewhere is not covered
 *     by this gate (nor is it served by `pluginUiStatic.ts`).
 */

/**
 * `w-[137px]`, `md:hover:bg-[#abc]`, `group-hover:w-[137px]`,
 * `data-[state=open]:!w-[137px]`, `lg:-mt-[3px]`.
 *
 *   (?<![\w$])            not in the middle of an identifier
 *   (?:...:)*             optional variant prefixes, including dashed forms
 *                         (`group-hover:`), digit-led forms (`2xl:`), and
 *                         Tailwind's arbitrary-prefix shape
 *                         (`data-[state=open]:`, `min-[320px]:`)
 *   !? -?                 optional important modifier and negative utility
 *   [a-z][a-z0-9]*        utility head
 *   (?:-[a-z0-9]+)*       dashed continuation (`grid-cols`, `max-w`)
 *   -\[ [^\]\s"'`]+ \]    the arbitrary value, still no whitespace or quotes
 */
const ARBITRARY_VALUE =
  /(?<![\w$])((?:(?:[a-z0-9][a-z0-9-]*(?:-\[[^\]\s"'`]+\])?):)*!?-?[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\[[^\]\s"'`]+\])/g;

/** `[&>tr]:border`, `[&_p]:mt-2` — arbitrary variants. */
const ARBITRARY_VARIANT = /(\[&[^\]\s"'`]*\](?::[a-z0-9[\]&_>-]+)?)/g;

export interface ArbitraryValueOffender {
  /** Package-relative path, as handed in by the caller. */
  readonly file: string;
  /** 1-based line number inside that file. */
  readonly line: number;
  /** The matched token, truncated to keep the API response bounded. */
  readonly token: string;
  readonly kind: 'arbitrary-value' | 'arbitrary-variant';
}

export interface ScanInputFile {
  readonly path: string;
  readonly content: string;
}

/** Hard cap so a hostile bundle cannot make the error payload the attack. */
const MAX_OFFENDERS = 25;
const MAX_TOKEN_LENGTH = 60;

/**
 * Scans compiled bundle text for arbitrary Tailwind values. Returns at most
 * {@link MAX_OFFENDERS} offenders, deduplicated on file+line+token.
 */
export function scanForArbitraryTailwindValues(
  files: readonly ScanInputFile[],
): ArbitraryValueOffender[] {
  const offenders: ArbitraryValueOffender[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i] ?? '';
      collect(text, ARBITRARY_VALUE, 'arbitrary-value', file.path, i + 1, offenders, seen);
      collect(text, ARBITRARY_VARIANT, 'arbitrary-variant', file.path, i + 1, offenders, seen);
      if (offenders.length >= MAX_OFFENDERS) return offenders;
    }
  }
  return offenders;
}

function collect(
  text: string,
  pattern: RegExp,
  kind: ArbitraryValueOffender['kind'],
  file: string,
  line: number,
  out: ArbitraryValueOffender[],
  seen: Set<string>,
): void {
  // Fresh lastIndex per line — the module-level regexes are /g and stateful.
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (out.length >= MAX_OFFENDERS) return;
    const token = (match[1] ?? match[0]).slice(0, MAX_TOKEN_LENGTH);
    const key = `${file}:${String(line)}:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, line, token, kind });
  }
}

/** One-line-per-offender rendering for the ingest error message. */
export function formatArbitraryValueOffenders(
  offenders: readonly ArbitraryValueOffender[],
): string {
  return offenders
    .map((o) => `  ${o.file}:${String(o.line)} — ${o.token} (${o.kind})`)
    .join('\n');
}
