/**
 * Shell-normalizing command policy — gating agent-executed commands. Issue #580
 * (competitive analysis of `yc-software/qm`).
 *
 * A command policy is NOT regex-on-the-raw-string: quoting, substitution and
 * word-splitting give a hostile (or merely mistaken) command a hundred ways to
 * spell the same effect, and a naive `raw.includes('rm -rf')` misses every one
 * of `r""m -rf /`, `rm${IFS}-rf${IFS}/`, `$'\x72\x6d' -rf /` and
 * `$(printf rm) -rf /`. So this module does what qm does: it NORMALIZES first —
 * unwrap the quoting layers, decode `$'…'` (ANSI-C), collapse `${IFS}` to a
 * field split, recurse into `$(…)` / backticks — then TOKENIZES into command
 * words, and only THEN runs a rule cascade against the normalized form.
 *
 * ## This is a speed bump, not a sandbox boundary
 *
 * Borrowed verbatim from qm's own SECURITY.md, because it is the honest framing:
 * this is "a speed bump against mistakes and injection, not a sandbox boundary".
 * A determined attacker with a real execution primitive has escapes the
 * normalizer does not model (unresolved variables, `eval` of a computed string,
 * exotic here-docs — see {@link normalizeCommand}'s documented limitations). The
 * real containment is the durable sandbox; this policy raises the cost of the
 * easy mistakes and the obvious injections, and it does so in EVERY posture
 * (there is no "dangerous" mode that turns the org floor off).
 *
 * ## What ships here, and what does not
 *
 * This module is the reusable, side-effect-free PRIMITIVE: the normalizer, the
 * tokenizer, the rule/decision model, the shipped org floor and the cascade
 * evaluator. It is pure and content-addressable — the same raw command always
 * normalizes to the same bytes, so a decision is reproducible and auditable.
 *
 * It does NOT enforce anything on its own: omadia has no shell-execute tool yet
 * (the durable-sandbox issue). The honest-inert enforcement seam — a per-dispatch
 * guard that is a no-op until a policy provider is installed — lives in the
 * orchestrator (`commandPolicyGuard.ts`), mirroring the #575 audience-floor guard
 * and the #579 screener.
 *
 * ## ReDoS and untrusted rule patterns (deliberately out of this layer)
 *
 * qm compiles operator-authored rule regexes through a ReDoS guard. omadia
 * already ships that guard — `screenPatternSource` (allowlist grammar) plus the
 * worker execution bound in `middleware/src/plugins/setupFieldPattern.ts`. It is
 * NOT reused *here* and that is a layering decision, not an oversight: this is a
 * package (`@omadia/channel-sdk`) and `setupFieldPattern.ts` is app source, which
 * a package must not import. The {@link CommandMatcher} `regex` variant therefore
 * carries an ALREADY-COMPILED `RegExp`, and the shipped {@link DEFAULT_ORG_FLOOR}
 * uses only regexes authored in this file (trusted, no `g` flag; the SQL rule is
 * linear and the fork-bomb rule is bounded to at-worst quadratic on a crafted
 * `(){`-prefixed input — no exponential/catastrophic backtracking in either).
 * Operator-supplied rule patterns are untrusted and must be screened through
 * `screenPatternSource` BEFORE compilation — that happens at the operator-config
 * boundary in app source, which lands with the operator rule UI (documented
 * follow-up). This PR introduces no untrusted-regex surface at all.
 */

/** A rule's verdict on a command. `require_approval` needs a human gate the
 *  enforcement seam does not yet have — see `commandPolicyGuard.ts`. */
export type CommandDecision = 'allow' | 'deny' | 'require_approval';

/** One tokenized command word discovered in a command line — the first token is
 *  the command {@link ParsedCommand.name}, the rest its {@link ParsedCommand.args}.
 *  Quotes are stripped and `$'…'`/`${IFS}` are resolved before tokenizing. */
export interface ParsedCommand {
  readonly name: string;
  readonly args: readonly string[];
}

/**
 * The normalized view of a raw command line the cascade decides on. Pure and
 * byte-stable for a given input (no clock, no ordering surprises) so a decision
 * is reproducible and the {@link CommandDecisionResult} is auditable.
 */
export interface NormalizedCommand {
  /**
   * The de-quoted, flattened command line: every quoting layer removed, `$'…'`
   * decoded, `${IFS}` turned into a field split, and the command words inside
   * `$(…)` / backticks spliced in in scan order. This is what a `regex` matcher
   * sees, so `psql -c "DROP TABLE x"` screens as `psql -c DROP TABLE x`.
   */
  readonly normalized: string;
  /**
   * Every command word discovered, including those nested inside substitutions
   * and downstream of pipes. `commandFlag` matchers evaluate against this, so a
   * per-command rule (recursive `rm`, `git push --force`) is not fooled by the
   * command being buried in `$(…)`.
   */
  readonly commands: readonly ParsedCommand[];
  /**
   * True when a pipeline segment DOWNSTREAM of a `|` is a shell reading stdin
   * (`… | sh`, `curl … | bash`). The classic `curl example.com | sh` install
   * footgun; a dedicated flag because it is a structural property of the
   * pipeline, not a substring.
   */
  readonly pipedToShell: boolean;
  /**
   * True when substitution nesting hit the depth cap ({@link MAX_SUBSTITUTION_DEPTH})
   * and scanning stopped descending. An HONEST signal that the normalized view is
   * incomplete below that point — a caller enforcing a policy should treat a
   * truncated normalization as suspicious rather than clean. The orchestrator's
   * `guardToolCommands` does exactly that: it refuses a command whose
   * normalization truncated instead of clearing it on a partial view.
   */
  readonly truncated: boolean;
}

/**
 * How a rule matches a normalized command. Kept as DATA (not a predicate
 * function) so a policy is serializable and inspectable, and so the pure layer
 * never compiles an untrusted pattern (see the module header on ReDoS).
 */
export type CommandMatcher =
  /**
   * Match a command WORD by name (path-stripped: `/bin/rm` matches `rm`),
   * optionally requiring a subcommand and/or a flag. `subcommand`, when set, must
   * equal the first NON-OPTION positional argument (so `git push …` matches
   * `subcommand: 'push'` but `git log --grep push …` does not — `push` there is
   * an option value, not the subcommand). `shortFlags` is a set of single-letter
   * flags matched inside a `-xrf`-style cluster; `longFlags` are exact
   * `--force`-style tokens. With neither flag set, any invocation matches.
   *
   * LIMITATION: a global option that takes a value (`git -c k=v push`) shifts the
   * first non-option arg onto that value; such prefixes are rare in agent
   * commands and are not modelled — a speed bump, not a parser. This same blind
   * spot lets `git -c … push --force` slip the {@link DEFAULT_ORG_FLOOR}
   * force-push rule (see that rule's note).
   */
  | {
      readonly kind: 'commandFlag';
      readonly name: string;
      readonly subcommand?: string;
      readonly shortFlags?: string;
      readonly longFlags?: readonly string[];
    }
  /**
   * A PRE-COMPILED regex. Tested against the normalized line by default, or the
   * raw input when `target: 'raw'` (for shapes the normalizer flattens away,
   * e.g. the fork-bomb `(){…}` structure). MUST NOT carry the `g` flag — a
   * stateful `lastIndex` would make `test()` alternate true/false across calls;
   * {@link matcherFires} resets `lastIndex` before each test as a belt-and-braces
   * guard, but a `g` flag is still a rule-authoring error.
   */
  | { readonly kind: 'regex'; readonly regex: RegExp; readonly target?: 'normalized' | 'raw' }
  /** The structural pipe-to-shell property. */
  | { readonly kind: 'pipeToShell' };

/** A single policy rule: an id (surfaced in the decision + audit), a decision,
 *  a human-readable reason and the matcher that fires it. */
export interface CommandRule {
  readonly id: string;
  readonly decision: CommandDecision;
  readonly reason: string;
  readonly match: CommandMatcher;
}

/**
 * A resolved command policy. The cascade order is fixed and is the whole of the
 * qm precedence model:
 *
 *   1. {@link orgFloor}     — hard rules that win in EVERY posture and cannot be
 *                             overridden. The catastrophic shapes.
 *   2. {@link orgAllowlist} — org-level allows that BEAT a scope denylist (an org
 *                             may bless a command a scope would otherwise refuse).
 *   3. {@link scopeRules}   — the scope's own rules, first match wins.
 *   4. {@link defaultDecision} — the verdict when nothing matched.
 */
export interface CommandPolicy {
  readonly orgFloor: readonly CommandRule[];
  readonly orgAllowlist: readonly CommandRule[];
  readonly scopeRules: readonly CommandRule[];
  readonly defaultDecision: CommandDecision;
}

/** Which cascade layer produced a decision — carried for audit and for tests
 *  that assert the precedence, not just the final verdict. */
export type CommandDecisionLayer = 'org_floor' | 'org_allowlist' | 'scope' | 'default';

/** The outcome of {@link decideCommand}: the verdict, which layer/rule produced
 *  it, the reason, and the {@link NormalizedCommand} it was decided on (so the
 *  decision reads back against the exact bytes the policy saw). */
export interface CommandDecisionResult {
  readonly decision: CommandDecision;
  readonly layer: CommandDecisionLayer;
  readonly ruleId?: string;
  readonly reason: string;
  readonly normalized: NormalizedCommand;
}

// ---------------------------------------------------------------------------
// Normalizer + tokenizer
// ---------------------------------------------------------------------------

/**
 * How deep {@link normalizeCommand} descends into nested `$(…)` / backtick
 * substitutions before giving up and flagging {@link NormalizedCommand.truncated}.
 * qm uses 8; matched here. A hostile command can nest substitutions to force the
 * scanner to either recurse forever or stop — stopping (with an honest flag) is
 * the safe choice.
 */
export const MAX_SUBSTITUTION_DEPTH = 8;

/** Shell interpreters that, downstream of a pipe, mean "execute stdin". */
const SHELL_NAMES: ReadonlySet<string> = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);

/** Strip a leading path from a command word: `/usr/bin/rm` → `rm`. */
function bareName(word: string): string {
  const slash = word.lastIndexOf('/');
  return slash === -1 ? word : word.slice(slash + 1);
}

function isVarStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_]/.test(ch);
}

/** Index just past a `$VAR` / `${…}` starting at `i` (which points at `$`). */
function skipVar(src: string, i: number): number {
  if (src[i + 1] === '{') {
    const end = src.indexOf('}', i + 2);
    return end === -1 ? src.length : end + 1;
  }
  let j = i + 1;
  while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
  return j;
}

/** Read the body of a `$(…)` starting just after `$(`; returns the inner text
 *  and the index past the matching `)`. Paren-counted (nested `$()` supported);
 *  a `)` inside a quote is not specially handled — a documented approximation. */
function readParenSub(src: string, i: number): { inner: string; next: number } {
  const start = i;
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
    i += 1;
  }
  return { inner: src.slice(start, i), next: i < src.length ? i + 1 : src.length };
}

/** Decode an ANSI-C `$'…'` body starting just after `$'`; returns the decoded
 *  text and the index past the closing `'`. Covers the escapes an attacker
 *  actually uses to hide a command word: `\xHH`, `\uHHHH`, octal, and the named
 *  C escapes. */
function readAnsiC(src: string, i: number): { text: string; next: number } {
  let text = '';
  while (i < src.length) {
    const c = src[i];
    if (c === "'") return { text, next: i + 1 };
    if (c === '\\') {
      const n = src[i + 1];
      switch (n) {
        case 'n': text += '\n'; i += 2; continue;
        case 't': text += '\t'; i += 2; continue;
        case 'r': text += '\r'; i += 2; continue;
        case '\\': text += '\\'; i += 2; continue;
        case "'": text += "'"; i += 2; continue;
        case '"': text += '"'; i += 2; continue;
        case 'a': text += '\x07'; i += 2; continue;
        case 'b': text += '\b'; i += 2; continue;
        case 'f': text += '\f'; i += 2; continue;
        case 'v': text += '\v'; i += 2; continue;
        case 'e': text += '\x1b'; i += 2; continue;
        case 'x': {
          const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 2));
          if (m) { text += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
          text += 'x'; i += 2; continue;
        }
        case 'u': {
          const m = /^[0-9a-fA-F]{1,4}/.exec(src.slice(i + 2));
          if (m) { text += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
          text += 'u'; i += 2; continue;
        }
        default: {
          if (n !== undefined && n >= '0' && n <= '7') {
            const m = /^[0-7]{1,3}/.exec(src.slice(i + 1)) as RegExpExecArray;
            text += String.fromCharCode(parseInt(m[0], 8)); i += 1 + m[0].length; continue;
          }
          if (n === undefined) { i += 1; continue; }
          text += n; i += 2; continue;
        }
      }
    }
    text += c;
    i += 1;
  }
  return { text, next: i };
}

interface Accum {
  commands: ParsedCommand[];
  normalized: string[];
  pipedToShell: boolean;
  truncated: boolean;
}

/** Read a double-quoted run starting just after the opening `"`; returns the
 *  literal text for the current word and the index past the closing `"`.
 *  Command substitutions inside the quotes recurse into `acc` (they expand in
 *  double quotes); word-splitting does not happen inside quotes. */
function readDoubleQuote(
  src: string,
  i: number,
  recurse: (inner: string) => void,
): { text: string; next: number } {
  let text = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return { text, next: i + 1 };
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '"' || n === '\\' || n === '$' || n === '`') { text += n; i += 2; continue; }
      text += c; i += 1; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const { inner, next } = readParenSub(src, i + 2);
      recurse(inner);
      i = next; continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      recurse(end === -1 ? src.slice(i + 1) : src.slice(i + 1, end));
      i = end === -1 ? src.length : end + 1; continue;
    }
    if (c === '$' && (src[i + 1] === '{' || isVarStart(src[i + 1]))) {
      i = skipVar(src, i); continue; // unresolved variable → empty expansion
    }
    text += c; i += 1;
  }
  return { text, next: i };
}

/** True when `$IFS` at `i` is the bare IFS variable (not `$IFSX`). */
function isBareIfs(src: string, i: number): boolean {
  if (src.startsWith('${IFS}', i)) return true;
  if (!src.startsWith('$IFS', i)) return false;
  const after = src[i + 4];
  return after === undefined || !/[A-Za-z0-9_]/.test(after);
}

/**
 * Scan a command LIST (segments split on `|`, `||`, `&&`, `;`, `&`, newline),
 * tokenizing each segment and recursing into substitutions. Accumulates every
 * command word, the flattened normalized tokens, and the pipe-to-shell flag into
 * `acc`. Not exported — {@link normalizeCommand} is the entry point.
 */
function scanCommandList(src: string, depth: number, acc: Accum): void {
  if (depth > MAX_SUBSTITUTION_DEPTH) {
    acc.truncated = true;
    return;
  }

  let i = 0;
  let buf = '';
  let tokenOpen = false;
  let segTokens: string[] = [];
  let pipedFromPrev = false;
  // Command words found inside substitutions during the CURRENT segment. Held
  // aside so the segment's own command lists BEFORE the ones nested in it —
  // `echo $(rm …)` reads back as `[echo, rm]`, the textual order.
  let nested: ParsedCommand[] = [];

  // Every substitution — top-level or inside a double quote — routes through
  // here: the inner scan runs on its own accumulator, its normalized tokens are
  // spliced in in scan order, and its command words are buffered as nested.
  const recurse = (inner: string): void => {
    const sub: Accum = { commands: [], normalized: [], pipedToShell: false, truncated: false };
    scanCommandList(inner, depth + 1, sub);
    for (const t of sub.normalized) acc.normalized.push(t);
    for (const cmd of sub.commands) nested.push(cmd);
    if (sub.pipedToShell) acc.pipedToShell = true;
    if (sub.truncated) acc.truncated = true;
  };

  const endToken = (): void => {
    if (tokenOpen) {
      segTokens.push(buf);
      acc.normalized.push(buf);
      buf = '';
      tokenOpen = false;
    }
  };
  const endSegment = (nextPiped: boolean): void => {
    endToken();
    if (segTokens.length > 0) {
      const [name, ...args] = segTokens as [string, ...string[]];
      acc.commands.push({ name, args });
      if (pipedFromPrev && SHELL_NAMES.has(bareName(name))) acc.pipedToShell = true;
    }
    for (const cmd of nested) acc.commands.push(cmd);
    nested = [];
    segTokens = [];
    pipedFromPrev = nextPiped;
  };

  while (i < src.length) {
    const c = src[i] as string;

    // Segment separators.
    if (c === '|') {
      if (src[i + 1] === '|') { endSegment(false); i += 2; continue; }
      endSegment(true); i += 1; continue;
    }
    if (c === '&') {
      if (src[i + 1] === '&') { endSegment(false); i += 2; continue; }
      endSegment(false); i += 1; continue;
    }
    if (c === ';' || c === '\n' || c === '\r') { endSegment(false); i += 1; continue; }

    // Unquoted whitespace ends a token.
    if (c === ' ' || c === '\t') { endToken(); i += 1; continue; }

    // Redirections: end the current token and swallow the operator run. A bare
    // file-descriptor number immediately before the operator (`2>`, `1>>`) is
    // part of the redirect, not a command word — drop it rather than leak it as a
    // stray token/arg. The target that FOLLOWS is still scanned as an ordinary
    // token (it reaches the normalized line for a regex rule); its precise role
    // is not modelled, a documented approximation.
    if (c === '>' || c === '<') {
      if (tokenOpen && /^\d+$/.test(buf)) {
        buf = '';
        tokenOpen = false;
      }
      endToken();
      i += 1;
      while (src[i] === '>' || src[i] === '<') i += 1;
      continue;
    }

    // Single quotes: fully literal, no escapes.
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      buf += end === -1 ? src.slice(i + 1) : src.slice(i + 1, end);
      tokenOpen = true;
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    // ANSI-C quoting `$'…'` — decode so a hex/octal-hidden word is revealed.
    if (c === '$' && src[i + 1] === "'") {
      const { text, next } = readAnsiC(src, i + 2);
      buf += text; tokenOpen = true; i = next; continue;
    }

    // `${IFS}` / `$IFS` → field separator (the classic space-free bypass).
    if (c === '$' && isBareIfs(src, i)) {
      endToken();
      i += src.startsWith('${IFS}', i) ? 6 : 4;
      continue;
    }

    // Command substitution `$(…)` — recurse; the textual result is unknown so it
    // contributes no chars to the surrounding word, but its command words and
    // pipe-to-shell property are captured.
    if (c === '$' && src[i + 1] === '(') {
      const { inner, next } = readParenSub(src, i + 2);
      recurse(inner);
      i = next; continue;
    }

    // Backtick substitution — same treatment as `$(…)`.
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      recurse(end === -1 ? src.slice(i + 1) : src.slice(i + 1, end));
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    // Double quotes.
    if (c === '"') {
      const { text, next } = readDoubleQuote(src, i + 1, recurse);
      buf += text; tokenOpen = true; i = next; continue;
    }

    // Any other `$VAR` / `${VAR}` — unresolved, drops to empty. A documented
    // limitation: the normalizer cannot see through a variable payload, so a
    // policy must not rely on it to catch `$X` where `X=rm`.
    if (c === '$' && (src[i + 1] === '{' || isVarStart(src[i + 1]))) {
      const next = skipVar(src, i);
      if (buf.length > 0) tokenOpen = true;
      i = next; continue;
    }

    // Unquoted backslash escape (and line continuation).
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) { i += 1; continue; }
      if (n === '\n') { i += 2; continue; }
      buf += n; tokenOpen = true; i += 2; continue;
    }

    buf += c; tokenOpen = true; i += 1;
  }
  endSegment(false);
}

/**
 * Normalize a raw command line: unwrap quoting, decode `$'…'`, split on
 * `${IFS}`, recurse into `$(…)` / backticks (to {@link MAX_SUBSTITUTION_DEPTH}),
 * and tokenize into command words. Pure and byte-stable.
 *
 * DOCUMENTED LIMITATIONS (this is a speed bump, not a sandbox): unresolved
 * variables expand to empty (a `$X`-hidden word is invisible), `eval`/`exec` of
 * a computed string is not followed, here-document BODIES are not parsed, and a
 * quote inside a `$(…)` body can throw off the paren match. Flag-based rules see
 * only flags, so a semantically-equivalent argument form (a `+` git refspec that
 * force-pushes, a config-prefixed subcommand) is not modelled — see
 * {@link DEFAULT_ORG_FLOOR}'s force-push rule. A `truncated` result means
 * scanning stopped at the depth cap and the view below it is incomplete.
 */
export function normalizeCommand(raw: string): NormalizedCommand {
  const acc: Accum = { commands: [], normalized: [], pipedToShell: false, truncated: false };
  scanCommandList(raw, 0, acc);
  return {
    normalized: acc.normalized.join(' ').replace(/\s+/g, ' ').trim(),
    commands: acc.commands,
    pipedToShell: acc.pipedToShell,
    truncated: acc.truncated,
  };
}

// ---------------------------------------------------------------------------
// Matcher evaluation + cascade
// ---------------------------------------------------------------------------

/** First argument that is not an option (does not start with `-`) — a command's
 *  subcommand, e.g. `push` in `git push --force`. */
function firstPositional(args: readonly string[]): string | undefined {
  for (const a of args) if (!a.startsWith('-')) return a;
  return undefined;
}

function flagPresent(
  args: readonly string[],
  shortFlags: string | undefined,
  longFlags: readonly string[] | undefined,
): boolean {
  if (!shortFlags && !longFlags) return true;
  for (const a of args) {
    if (longFlags && longFlags.includes(a)) return true;
    if (shortFlags && /^-[A-Za-z]+$/.test(a)) {
      for (const ch of shortFlags) if (a.includes(ch)) return true;
    }
  }
  return false;
}

/** Whether a matcher fires on a normalized command (given the raw input for
 *  `raw`-targeted regexes). Pure — no compilation, no side effects. */
function matcherFires(m: CommandMatcher, nc: NormalizedCommand, raw: string): boolean {
  switch (m.kind) {
    case 'commandFlag':
      for (const cmd of nc.commands) {
        if (bareName(cmd.name) !== m.name) continue;
        if (m.subcommand !== undefined && firstPositional(cmd.args) !== m.subcommand) continue;
        if (flagPresent(cmd.args, m.shortFlags, m.longFlags)) return true;
      }
      return false;
    case 'regex':
      // Defensive: a `regex` matcher MUST NOT carry the `g` flag (a stateful
      // `lastIndex` would make `test()` alternate true/false across calls). Reset
      // `lastIndex` before each test so even a stray global regex evaluates
      // correctly rather than silently flapping.
      m.regex.lastIndex = 0;
      return m.regex.test(m.target === 'raw' ? raw : nc.normalized);
    case 'pipeToShell':
      return nc.pipedToShell;
  }
}

function firstMatch(
  rules: readonly CommandRule[],
  nc: NormalizedCommand,
  raw: string,
): CommandRule | undefined {
  for (const rule of rules) if (matcherFires(rule.match, nc, raw)) return rule;
  return undefined;
}

/**
 * Decide a raw command against a policy. Normalizes once, then walks the fixed
 * cascade (org floor → org allowlist → scope rules → default) and returns the
 * first verdict with the layer, rule id, reason and the normalized view it was
 * decided on.
 *
 * The org floor applies in EVERY posture — there is no caller flag that disables
 * it, by design (#580): a "dangerous" posture still cannot force-push or pipe a
 * download into a shell.
 */
export function decideCommand(policy: CommandPolicy, raw: string): CommandDecisionResult {
  const nc = normalizeCommand(raw);

  const floor = firstMatch(policy.orgFloor, nc, raw);
  if (floor) {
    return { decision: floor.decision, layer: 'org_floor', ruleId: floor.id, reason: floor.reason, normalized: nc };
  }
  const allow = firstMatch(policy.orgAllowlist, nc, raw);
  if (allow) {
    return { decision: allow.decision, layer: 'org_allowlist', ruleId: allow.id, reason: allow.reason, normalized: nc };
  }
  const scope = firstMatch(policy.scopeRules, nc, raw);
  if (scope) {
    return { decision: scope.decision, layer: 'scope', ruleId: scope.id, reason: scope.reason, normalized: nc };
  }
  return {
    decision: policy.defaultDecision,
    layer: 'default',
    reason: 'no rule matched; org default applied',
    normalized: nc,
  };
}

// ---------------------------------------------------------------------------
// Shipped org floor
// ---------------------------------------------------------------------------

/**
 * Deep-freeze a rule list. `Object.freeze` on the array alone is SHALLOW: it
 * stops `rules[0] = …` but NOT `rules[0].decision = 'allow'`, which would
 * silently disarm the shipped org floor process-wide for every policy built on
 * the shared value — the one layer #580 requires to hold in every posture. So
 * the rule objects and the `longFlags` array a matcher may carry are frozen too.
 * The `RegExp` itself is deliberately NOT frozen: {@link matcherFires} resets its
 * `lastIndex` before each test, and that write must not throw.
 */
function freezeRules(rules: readonly CommandRule[]): readonly CommandRule[] {
  for (const rule of rules) {
    Object.freeze(rule);
    Object.freeze(rule.match);
    if (rule.match.kind === 'commandFlag' && rule.match.longFlags) {
      Object.freeze(rule.match.longFlags);
    }
  }
  return Object.freeze(rules);
}

/**
 * The org floor omadia ships: the catastrophic shapes qm hard-denies, expressed
 * against the normalized command so quoting cannot launder them. DEEP-frozen so
 * no caller can mutate the shared value (see {@link freezeRules}).
 *
 * All regexes here are authored in this file — trusted, no `g` flag, no
 * exponential backtracking (the SQL rule is linear; the fork-bomb rule is bounded
 * to at-worst quadratic on crafted input). NO untrusted pattern in this array
 * (see the module header).
 */
export const DEFAULT_ORG_FLOOR: readonly CommandRule[] = freezeRules([
  {
    id: 'floor.rm-recursive',
    decision: 'deny',
    reason: 'recursive delete (rm -r / --recursive) is denied by the org floor',
    match: { kind: 'commandFlag', name: 'rm', shortFlags: 'rR', longFlags: ['--recursive'] },
  },
  {
    id: 'floor.git-force-push',
    decision: 'deny',
    reason: 'force-pushing (git push --force) is denied by the org floor',
    // LIMITATION: catches the `-f`/`--force`/`--force-with-lease` FLAGS only. A
    // force via a `+` refspec (`git push origin +main`, `+HEAD:refs/…`) carries
    // no flag and is NOT floored; likewise `git -c k=v push --force` shifts the
    // subcommand off `push` (see the commandFlag matcher's LIMITATION). Both are
    // speed-bump gaps, not a git parser — the durable sandbox is the real bound.
    match: {
      kind: 'commandFlag',
      name: 'git',
      subcommand: 'push',
      shortFlags: 'f',
      longFlags: ['--force', '--force-with-lease'],
    },
  },
  {
    id: 'floor.sql-drop-truncate',
    decision: 'deny',
    reason: 'destructive SQL (DROP / TRUNCATE of a table/database/schema) is denied by the org floor',
    match: { kind: 'regex', regex: /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i },
  },
  {
    id: 'floor.fork-bomb',
    decision: 'deny',
    reason: 'fork bomb pattern is denied by the org floor',
    // Matched on the RAW input: the `(){…}` function-defines-and-recurses shape
    // is exactly what the tokenizer flattens away. Bounded — worst case is
    // quadratic on a crafted `(){`-prefixed run of `|` with no `&` (each `[^}]*`
    // is capped by the required delimiters), never exponential/catastrophic, and
    // the short command length caps it in practice.
    match: { kind: 'regex', target: 'raw', regex: /[^\s(){}]*\(\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;/ },
  },
  {
    id: 'floor.pipe-to-shell',
    decision: 'deny',
    reason: 'piping content into a shell (… | sh) is denied by the org floor',
    match: { kind: 'pipeToShell' },
  },
]);

/**
 * Assemble a command policy from the shipped org floor plus optional overrides.
 * The delivered default is: the org floor, no org allowlist, no scope rules, and
 * a permissive `allow` default — the policy is a speed bump that catches the
 * catastrophic shapes, not an allowlist gate (that is the sandbox's job).
 */
export function defaultCommandPolicy(overrides?: Partial<CommandPolicy>): CommandPolicy {
  return {
    orgFloor: overrides?.orgFloor ?? DEFAULT_ORG_FLOOR,
    orgAllowlist: overrides?.orgAllowlist ?? [],
    scopeRules: overrides?.scopeRules ?? [],
    defaultDecision: overrides?.defaultDecision ?? 'allow',
  };
}
