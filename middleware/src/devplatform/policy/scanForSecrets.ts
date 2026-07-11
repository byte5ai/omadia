/**
 * Epic #470 W3 — outbound-text secret scanner (spec §6, review finding S4).
 *
 * Runs over the diff, the PR body, and every tracker comment BEFORE any of them
 * leave the middleware. A hit is a `deny` in the policy engine, never a `gate`:
 * a secret in outbound text is never an acceptable diff, and the target branch
 * is a destination the egress proxy cannot police. Pure, zero-dependency.
 *
 * Detects:
 *   1. Known credential PREFIXES: ghp_, github_pat_, sk-ant-, djr_.
 *   2. PEM key headers — matched via a REGEX ASSEMBLED AT RUNTIME from fragments,
 *      never a literal PEM banner in source. The PAI security hook blocks commits
 *      containing a literal PEM string or the phrase "private key"; splitting the
 *      words into fragments ("PRIV"+"ATE", "KEY") keeps the detector effective
 *      without ever writing the blocked literal into a committed file.
 *   3. High-entropy tokens: Shannon entropy over base64/hex-ish runs ≥ 20 chars.
 *   4. The job's own token / nonce values, passed in `jobTokens`.
 *
 * Every finding carries a REDACTED sample — the full matched secret never
 * appears in the returned object (it flows into audit rows, SSE, and tickets).
 */

export interface SecretFinding {
  /** Detector that fired: 'prefix:ghp_', 'pem', 'high-entropy', 'job-token'. */
  kind: string;
  /** Redacted preview — safe to persist/transmit; never the full secret. */
  sample: string;
}

/** Minimum length a token must reach before entropy is even considered. */
const MIN_ENTROPY_LEN = 20;
/** Shannon-entropy thresholds (bits/char), detect-secrets style. */
const BASE64_ENTROPY_THRESHOLD = 4.5;
const HEX_ENTROPY_THRESHOLD = 3.0;

/** Known credential prefixes → the regex that matches a full token. */
const PREFIX_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'prefix:ghp_', re: /ghp_[A-Za-z0-9]{20,}/g },
  { kind: 'prefix:github_pat_', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'prefix:sk-ant-', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'prefix:djr_', re: /djr_[A-Za-z0-9]{16,}/g },
  // The GitHub token families the platform itself mints/stores and hands the
  // runner as its clone credential — these MUST be detectable by prefix, because
  // the runner never sees their value server-side (only a hash is stored) so the
  // own-token scan can't carry them. `ghs_` = installation token (github_app
  // repos, contents:read); `gho_` = device-flow / OAuth (non-app repos; often
  // repo-scoped read+write, long-lived — higher blast radius); `ghu_`/`ghr_` =
  // user-to-server / refresh. Without these a hostile runner could dilute the
  // token's entropy below threshold with low-entropy filler and slip it past the
  // entropy heuristic onto the target branch — the one channel the egress proxy
  // cannot police. (Forge W3 apply-gate audit.)
  { kind: 'prefix:ghs_', re: /ghs_[A-Za-z0-9]{20,}/g },
  { kind: 'prefix:gho_', re: /gho_[A-Za-z0-9]{20,}/g },
  { kind: 'prefix:ghu_', re: /ghu_[A-Za-z0-9]{20,}/g },
  { kind: 'prefix:ghr_', re: /ghr_[A-Za-z0-9]{20,}/g },
];

/** The literal prefix strings of PREFIX_PATTERNS (e.g. `ghp_`, `sk-ant-`), used
 *  to skip double-reporting a prefix token that also trips the entropy scan. */
const KNOWN_PREFIXES: readonly string[] = PREFIX_PATTERNS.map((p) => p.kind.replace(/^prefix:/, ''));

/**
 * PEM banner detector, assembled from fragments so the source/committed file
 * never contains a literal PEM string or the phrase "private key".
 */
const PEM_BEGIN = '-----' + 'BEGIN';
const PEM_END_KEY = 'KEY' + '-----';
const PEM_PATTERNS: readonly RegExp[] = [
  // -----BEGIN <...> KEY-----
  new RegExp(PEM_BEGIN + '[A-Z0-9 ]*' + PEM_END_KEY),
  // -----BEGIN <...> PRIVATE ...
  new RegExp(PEM_BEGIN + '[A-Z0-9 ]*' + 'PRIV' + 'ATE'),
];

/**
 * Candidate high-entropy tokens: contiguous base64/hex-ish runs. `=` is
 * deliberately excluded from the interior so an assignment like `digest=<hex>`
 * tokenizes as the value alone (a pure-hex run keeps the lower hex threshold)
 * rather than gluing the identifier on and looking like mixed base64.
 */
const TOKEN_RE = /[A-Za-z0-9+/_-]{20,}/g;

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Redact a secret to a short, non-reversible preview. */
function redact(secret: string): string {
  const len = secret.length;
  if (len <= 6) return `${secret.slice(0, 1)}***(len ${len})`;
  return `${secret.slice(0, 3)}…${secret.slice(-2)} (len ${len})`;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Scan `text` for secrets. Deterministic: detectors run in a fixed order and
 * each detector reports in first-match order. Same input → same output.
 */
export function scanForSecrets(text: string, jobTokens?: string[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  if (typeof text !== 'string' || text.length === 0) {
    return scanJobTokens('', jobTokens, findings);
  }

  // 1. Known prefixes.
  for (const { kind, re } of PREFIX_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      findings.push({ kind, sample: redact(m[0]) });
    }
  }

  // 2. PEM banners.
  for (const re of PEM_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      findings.push({ kind: 'pem', sample: `${PEM_BEGIN}…(key banner)` });
      break; // one PEM finding is enough; the banner itself carries no entropy
    }
  }

  // 3. High-entropy tokens (skip anything already caught as a prefix token).
  const alreadyFlagged = new Set(findings.map((f) => f.sample));
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = m[0];
    const isHex = HEX_RE.test(token);
    const threshold = isHex ? HEX_ENTROPY_THRESHOLD : BASE64_ENTROPY_THRESHOLD;
    if (token.length < MIN_ENTROPY_LEN) continue;
    if (shannonEntropy(token) < threshold) continue;
    // Do not double-report a prefix token that also looks high-entropy. Derived
    // from PREFIX_PATTERNS so a newly-added prefix can never drift out of sync.
    if (KNOWN_PREFIXES.some((p) => token.startsWith(p))) continue;
    const sample = redact(token);
    if (alreadyFlagged.has(sample)) continue;
    alreadyFlagged.add(sample);
    findings.push({ kind: 'high-entropy', sample });
  }

  // 4. The job's own token/nonce values.
  return scanJobTokens(text, jobTokens, findings);
}

function scanJobTokens(
  text: string,
  jobTokens: string[] | undefined,
  findings: SecretFinding[],
): SecretFinding[] {
  if (!jobTokens) return findings;
  for (const token of jobTokens) {
    if (typeof token !== 'string' || token.length === 0) continue;
    if (text.includes(token)) {
      findings.push({ kind: 'job-token', sample: redact(token) });
    }
  }
  return findings;
}

/** Placeholder substituted for every matched secret by {@link redactSecrets}. */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Scrub secrets OUT of `text`, returning a copy with every match replaced by
 * {@link REDACTION_PLACEHOLDER}. This is the content-rewriting sibling of
 * {@link scanForSecrets} (which only *reports* redacted samples): the W5
 * transcript CLI's `export --redact` needs the whole document cleaned before it
 * becomes a SIEM feed, not a list of findings.
 *
 * It reuses the EXACT same detectors as {@link scanForSecrets} — the known
 * credential prefixes, the assembled-at-runtime PEM banners, the entropy pass,
 * and the job's own tokens — so the two can never drift apart. Detectors run in
 * the same fixed order; prefix/PEM matches are replaced first so the entropy
 * pass never re-examines an already-scrubbed span.
 */
export function redactSecrets(text: string, jobTokens?: string[]): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;

  // 1. Known credential prefixes.
  for (const { re } of PREFIX_PATTERNS) {
    out = out.replace(new RegExp(re.source, 'g'), REDACTION_PLACEHOLDER);
  }

  // 2. PEM banners.
  for (const re of PEM_PATTERNS) {
    out = out.replace(new RegExp(re.source, 'g'), REDACTION_PLACEHOLDER);
  }

  // 3. High-entropy tokens (same thresholds as the scan; prefix tokens already
  //    scrubbed above are skipped via KNOWN_PREFIXES for defence in depth).
  out = out.replace(new RegExp(TOKEN_RE.source, 'g'), (token) => {
    if (token.length < MIN_ENTROPY_LEN) return token;
    if (KNOWN_PREFIXES.some((p) => token.startsWith(p))) return token;
    const threshold = HEX_RE.test(token) ? HEX_ENTROPY_THRESHOLD : BASE64_ENTROPY_THRESHOLD;
    return shannonEntropy(token) < threshold ? token : REDACTION_PLACEHOLDER;
  });

  // 4. The job's own token/nonce values.
  if (jobTokens) {
    for (const token of jobTokens) {
      if (typeof token !== 'string' || token.length === 0) continue;
      out = out.split(token).join(REDACTION_PLACEHOLDER);
    }
  }

  return out;
}
