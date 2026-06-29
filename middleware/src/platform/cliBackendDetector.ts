/**
 * CLI subscription-backend detection (#309, Phase B).
 *
 * Detects whether a vendor LLM CLI (Claude / Codex / Gemini) is installed on
 * the host AND logged in, so omadia can offer subscription-backed agents and
 * surface a clear "backend available?" status in the Web UI. This is the
 * "auth = host capability, not a vault secret" model from the #309 plan: the
 * relevant CLI must be installed and authenticated on the host, never an API
 * key in the vault.
 *
 * Hard rules baked in here:
 *  - **Zero-side-effect probes.** We only run `--version` and a read-only auth
 *    status command. We NEVER trigger a login, never consume quota, never write.
 *  - **No shell.** Every probe is `execFile` with a fixed argv (no string
 *    interpolation), short timeout, output capped — so a stuck or chatty CLI
 *    can't hang or flood the kernel.
 *  - **Honest states.** `loggedIn` is a tri-state (`yes`/`no`/`unknown`):
 *    install + not-logged-in are reliable; wrong-account / expired / lapsed
 *    need a real server round-trip, so we report `unknown` rather than guess.
 *
 * Billing reality (surfaced to the UI, decided in #309 §2): only the Anthropic
 * CLI is confirmed in-scope for v1 (subscription billing). Codex signs in via
 * ChatGPT but auto-generates an API key (likely meters the API), and Gemini's
 * free OAuth is preview-limited — both are detected + shown but flagged
 * "needs verification" and not yet recommended.
 */
import { execFile } from 'node:child_process';
import { CLI_ENV_SCRUB_KEYS } from '@omadia/orchestrator';

/** Tri-state: we are honest about what a read-only probe can actually prove. */
export type CliLoginState = 'yes' | 'no' | 'unknown';

/** Per-vendor billing posture for the UI (decided in #309 §2). */
export type CliBillingPosture = 'subscription' | 'needs-verification';

export interface CliBackendStatus {
  readonly id: string;
  readonly label: string;
  /** The binary we probe for, e.g. `claude`. */
  readonly bin: string;
  readonly installed: boolean;
  /** Trimmed `--version` output when installed. */
  readonly version?: string;
  readonly loggedIn: CliLoginState;
  /** Logged-in account identity when the probe surfaces it (for self-check). */
  readonly account?: string;
  /** Whether this vendor is confirmed to bill the subscription (v1 = Claude). */
  readonly billing: CliBillingPosture;
  /** Short human note explaining the current state / next step. */
  readonly detail: string;
}

interface CliBackendSpec {
  readonly id: string;
  readonly label: string;
  readonly bin: string;
  /** Args that print a version (read-only). */
  readonly versionArgs: readonly string[];
  /** Read-only auth probe; omitted vendors report `unknown`. */
  readonly authArgs?: readonly string[];
  /** Map a successful auth-probe result → login state + optional account. */
  readonly parseAuth?: (out: string) => { state: CliLoginState; account?: string };
  readonly billing: CliBillingPosture;
}

/**
 * Supported CLIs. Claude first (the only v1-recommended path). Codex/Gemini are
 * detected so the UI can show them, but their billing is `needs-verification`.
 */
const CLI_BACKENDS: ReadonlyArray<CliBackendSpec> = [
  {
    id: 'claude',
    label: 'Claude (Anthropic)',
    bin: 'claude',
    versionArgs: ['--version'],
    // `claude auth status` is a read-only, no-quota probe. The current CLI
    // prints JSON, e.g. {"loggedIn":false,"authMethod":"none","apiProvider":
    // "firstParty"} (exit 1 when logged out). We parse JSON first, then fall
    // back to a loose text heuristic for other/older CLI versions, and only
    // report `unknown` when neither is conclusive (#309: honest tri-state).
    authArgs: ['auth', 'status', '--json'],
    parseAuth: (out) => {
      const json = tryParseJsonObject(out);
      if (json && typeof json['loggedIn'] === 'boolean') {
        if (!json['loggedIn']) return { state: 'no' };
        const account = pickString(json, ['email', 'account', 'organizationName', 'organization']);
        return account ? { state: 'yes', account } : { state: 'yes' };
      }
      const lower = out.toLowerCase();
      if (/not logged in|logged out|please run|no credentials/.test(lower)) {
        return { state: 'no' };
      }
      if (/logged in|authenticated|subscription/.test(lower)) {
        const email = out.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
        return email ? { state: 'yes', account: email } : { state: 'yes' };
      }
      return { state: 'unknown' };
    },
    billing: 'subscription',
  },
  {
    id: 'codex',
    label: 'Codex (OpenAI)',
    bin: 'codex',
    versionArgs: ['--version'],
    billing: 'needs-verification',
  },
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    bin: 'gemini',
    versionArgs: ['--version'],
    billing: 'needs-verification',
  },
];

const PROBE_TIMEOUT_MS = 4000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Run a binary with a fixed argv, no shell, bounded time + output. */
function runProbe(
  bin: string,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        // Never inherit a shell; never pass user input. Scrub credential env
        // vars so a probe can't be tricked into an API-key path (#309 §2).
        env: scrubbedEnv(),
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ ok: false, stdout: '', stderr: 'not found' });
          return;
        }
        // A non-zero exit (e.g. "not logged in") is still a usable signal.
        resolve({
          ok: !err,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

/**
 * Copy of the process env with vendor credential vars removed. Keeps a probe
 * (and later, the real CLI spawn) on the subscription path — see #309 §2
 * "billing-precedence footgun".
 */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of CLI_ENV_SCRUB_KEYS) {
    delete env[key];
  }
  return env;
}

/** Parse the first top-level JSON object found in CLI output, or undefined. */
function tryParseJsonObject(out: string): Record<string, unknown> | undefined {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(out.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** First non-empty string value among the given keys. */
function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

async function detectOne(spec: CliBackendSpec): Promise<CliBackendStatus> {
  const ver = await runProbe(spec.bin, spec.versionArgs);
  if (!ver.ok && ver.stderr === 'not found') {
    return {
      id: spec.id,
      label: spec.label,
      bin: spec.bin,
      installed: false,
      loggedIn: 'no',
      billing: spec.billing,
      detail: `${spec.bin} is not installed in this environment.`,
    };
  }

  const version = (ver.stdout || ver.stderr).trim().split('\n')[0]?.trim() || undefined;

  let loggedIn: CliLoginState = 'unknown';
  let account: string | undefined;
  if (spec.authArgs && spec.parseAuth) {
    const auth = await runProbe(spec.bin, spec.authArgs);
    const parsed = spec.parseAuth(`${auth.stdout}\n${auth.stderr}`);
    loggedIn = parsed.state;
    account = parsed.account;
  }

  const detail =
    loggedIn === 'yes'
      ? account
        ? `Logged in as ${account}.`
        : 'Logged in.'
      : loggedIn === 'no'
        ? `Installed but not logged in. Run the in-app login to connect a subscription.`
        : `Installed. Login status could not be confirmed — open the login panel to check.`;

  return {
    id: spec.id,
    label: spec.label,
    bin: spec.bin,
    installed: true,
    ...(version ? { version } : {}),
    loggedIn,
    ...(account ? { account } : {}),
    billing: spec.billing,
    detail,
  };
}

export interface CliBackendsSnapshot {
  readonly backends: ReadonlyArray<CliBackendStatus>;
  /** Epoch ms when this snapshot was produced. */
  readonly generatedAt: number;
}

let cache: CliBackendsSnapshot | undefined;
const CACHE_TTL_MS = 30_000;

/**
 * Detect all supported CLI backends. Cached for {@link CACHE_TTL_MS} (logins
 * change out of band); pass `{ force: true }` for the UI's "re-check" action.
 */
export async function detectCliBackends(
  opts: { force?: boolean } = {},
): Promise<CliBackendsSnapshot> {
  const now = Date.now();
  if (!opts.force && cache && now - cache.generatedAt < CACHE_TTL_MS) {
    return cache;
  }
  const backends = await Promise.all(CLI_BACKENDS.map((s) => detectOne(s)));
  cache = { backends, generatedAt: now };
  return cache;
}

/** Test seam: clear the module-level cache. */
export function __resetCliBackendCache(): void {
  cache = undefined;
}
