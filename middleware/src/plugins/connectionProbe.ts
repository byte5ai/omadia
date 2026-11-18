/**
 * Issue #1453 — kernel-run connection probe for installed plugins.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until this module, nothing in omadia ever asked an integration's target
 * system whether its credentials work. `activate()` builds a client and
 * publishes services without a single request, so a wrong, revoked or expired
 * API key activated cleanly and the store rendered "Active · configured
 * <time>" — a timestamp of the activation, not of a check. The operator found
 * out from a failed chat turn.
 *
 * The signal path was already complete and empty: `ctx.status` is wired to the
 * store badge, the detail banner AND the orchestrator's tool gate
 * (`PluginStatusRegistry.isReady`), but no plugin wrote to it. This module
 * supplies the missing writer — the kernel asking the plugin's own
 * `verifyConnection` export for a verdict at every activation, and translating
 * that verdict into the channel.
 *
 * DESIGN RULES (all load-bearing, all paid for elsewhere already)
 *  - **Only an explicit rejection means "broken".** A timeout, a 5xx, a DNS
 *    failure or an air-gapped install must leave the operator's status alone,
 *    never accuse them of holding a bad credential. This is the rule
 *    `providerCredentialVerifier.ts` carries for LLM keys, and it matters more
 *    here: a `rejected` verdict also withholds the plugin's tools from the
 *    orchestrator (#474's gate), so a misread outage silently strips tools
 *    from the model.
 *  - **A probe can never fail an activation.** It runs after `activate()` has
 *    already succeeded, it is bounded, and every failure mode — throw, hang,
 *    malformed return value — degrades to `inconclusive`. Same contract
 *    `readiness.ts` holds: a diagnostic must not break the thing it diagnoses.
 *  - **The kernel ships no operator-facing copy.** `title`/`detail` are the
 *    plugin's own localized strings or nothing; an untranslated English
 *    sentence from core would reach the UI unmediated (the web-ui owns all
 *    copy in `messages/{en,de}.json`).
 *  - **A rejection must name its cause.** `rejected` is the one verdict that
 *    turns a plugin red and withholds its tools, and core cannot see the
 *    exchange that produced it. So it does the next best thing: it accepts
 *    `rejected` only with a recognised `ConnectionRejectionCause` and demotes
 *    anything else to `inconclusive`. A bare `catch { return {status:
 *    'rejected'} }` therefore cannot paint an outage as a dead key.
 *  - **Verdicts are cached per credential, with a TTL.** Same shape as
 *    `providerCredentialVerifier`: a module-level map, a TTL, a `force`
 *    bypass for the operator-triggered re-check, and a test seam. The cache
 *    KEY carries a fingerprint of the whole credential surface the verdict was
 *    produced for — the vault entries AND the non-secret setup values a
 *    connection depends on just as hard (`url`, `db`, `login`) — so neither a
 *    replaced key nor a repaired host can be served the old answer. It earns its
 *    keep inside one process: a provider write reactivates every dependent
 *    plugin (`reactivateAfterProviderWrite`), which would otherwise probe
 *    every target system again for credentials that did not change. Only
 *    DECIDED verdicts are cached — an outage must not pin "we don't know"
 *    for the whole TTL.
 *  - **One writer.** The verdict goes through `ctx.status.report()`, the same
 *    accessor the plugin itself uses, so normalization and the kernel-stamped
 *    `checked_at` happen in exactly one place and a probe verdict cannot claim
 *    a time it was not produced at.
 */

import { createHash } from 'node:crypto';

import type {
  ConnectionRejectionCause,
  PluginActionStatus,
  PluginConnectionVerdict,
} from '@omadia/plugin-api';

/** Default budget for one plugin's probe. Deliberately well under the 10s
 *  `activate()` cap: the probe is a diagnostic running after a plugin is
 *  already serving, and a slow target must not keep a boot-time promise alive
 *  for longer than the activation it follows. */
export const CONNECTION_PROBE_TIMEOUT_MS = 5_000;

/** Why a probe produced no usable verdict. Diagnosable in logs; never rendered
 *  (see the "no operator-facing copy" rule above). */
export type ConnectionProbeReason =
  /** The plugin's `verifyConnection` threw. */
  | 'threw'
  /** It did not answer within the budget. */
  | 'timed_out'
  /** It answered with something that is not a `PluginConnectionVerdict`. */
  | 'malformed'
  /** It claimed `rejected` without naming a recognised cause, so the kernel
   *  refused to treat it as a credential verdict. */
  | 'unexplained_rejection'
  /** The plugin exports no `verifyConnection` at all, so nothing was asked.
   *  Produced by the verify ENDPOINT rather than by a probe run — it is the
   *  honest answer to "is this connection ok?" when no check exists, and it
   *  must never be collapsed into a positive one. */
  | 'no_probe';

/**
 * What a probe run produced. Reuses the plugin-facing verdict (`status`,
 * `title`, `detail` — the plugin's own copy, passed through for the badge and
 * for the verify endpoint's response; never authored by core) and adds the
 * kernel's own `reason`.
 *
 * A union rather than one flat shape so `reason` can only ride along with
 * `inconclusive`: `{status: 'connected', reason: 'no_probe'}` is nonsense and
 * must not typecheck.
 */
export type ConnectionProbeOutcome =
  | (PluginConnectionVerdict & {
      readonly status: 'connected';
      readonly cause?: never;
      readonly reason?: never;
      /** The verdict was served from the cache; no request was made. */
      readonly cached?: true;
    })
  | (PluginConnectionVerdict & {
      readonly status: 'rejected';
      /** Always present on a rejection — core demotes one without a cause. */
      readonly cause: ConnectionRejectionCause;
      readonly reason?: never;
      readonly cached?: true;
    })
  | (PluginConnectionVerdict & {
      readonly status: 'inconclusive';
      readonly cause?: never;
      readonly reason?: ConnectionProbeReason;
      readonly cached?: never;
    });

/** How long a DECIDED verdict stays usable for an unchanged credential.
 *  Matches `providerCredentialVerifier`'s window. */
export const CONNECTION_PROBE_CACHE_TTL_MS = 300_000;

const REJECTION_CAUSES: ReadonlySet<string> = new Set<ConnectionRejectionCause>([
  'http_401',
  'http_403_auth',
  'protocol_auth_failure',
]);

interface CachedVerdict {
  readonly outcome: ConnectionProbeOutcome;
  readonly at: number;
}

/** Keyed by `pluginId` + a fingerprint of the credentials the verdict is
 *  about, so two plugins holding the same key stay separate questions and a
 *  replaced key is never served the old answer. */
const cache = new Map<string, CachedVerdict>();

/** Test seam, mirroring `providerCredentialVerifier.__clearVerificationCache`. */
export function __clearConnectionProbeCache(): void {
  cache.clear();
}

/** The sliver of `PluginContext` the probe writes through. Structural so a
 *  test passes a two-line stub and the real context fits without a cast. */
export interface ConnectionProbeStatusSink {
  report(status: PluginActionStatus): void;
  clear(): void;
}

export interface ConnectionProbeInput {
  readonly pluginId: string;
  /** The plugin's `verifyConnection` export, already bound to the plugin's own
   *  context by the runtime. Its return type is `unknown` on purpose — the
   *  runtime reads this function off a dynamically imported module and cannot
   *  prove what it answers, which is exactly why every answer is validated
   *  below. */
  readonly verify: () => unknown;
  /** Where the verdict is written. The runtime passes a sink that stops
   *  writing once the plugin is no longer active, so a late verdict cannot
   *  re-create a badge for a plugin that was deactivated meanwhile. */
  readonly status: ConnectionProbeStatusSink;
  /** Fingerprint of the credentials this probe is about. Without one nothing
   *  is cached: a verdict that cannot be tied to a key could outlive it. */
  readonly credentialFingerprint?: string;
  /** Ignore a cached verdict and ask the target system again. The
   *  operator-triggered re-check passes this — a "check now" button that
   *  answers from a cache is not a check. */
  readonly force?: boolean;
  readonly timeoutMs?: number;
  /** Injectable clock, for the TTL test. */
  readonly now?: () => number;
  readonly log?: (msg: string) => void;
}

/**
 * Run one plugin's connection probe and translate its verdict into
 * `ctx.status`. Never throws, never rejects.
 */
export async function runConnectionProbe(
  input: ConnectionProbeInput,
): Promise<ConnectionProbeOutcome> {
  const cacheKey =
    input.credentialFingerprint === undefined
      ? undefined
      : `${input.pluginId}\u0000${input.credentialFingerprint}`;
  const clock = input.now ?? Date.now;

  const verdict = await resolveFromCacheOrProbe(input, cacheKey, clock);
  const log = input.log;

  try {
    if (verdict.status === 'rejected') {
      input.status.report({
        state: 'error',
        ...(verdict.title !== undefined ? { title: verdict.title } : {}),
        ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
      });
    } else if (verdict.status === 'connected') {
      if (verdict.title !== undefined) {
        input.status.report({
          state: 'ok',
          title: verdict.title,
          ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
        });
      } else {
        // A connected probe with no copy of its own still has to retract an
        // earlier `rejected`: the re-probe endpoint runs without a
        // deactivation, so nothing else would clear it. `clear()` and a bare
        // `report({state:'ok'})` are synonyms in the accessor; calling clear()
        // says which of the two this is.
        input.status.clear();
      }
    }
    // `inconclusive` deliberately writes nothing. An outage, a timeout or a
    // probe this kernel could not understand is not evidence about the
    // operator's credentials, and overwriting a real verdict with "we don't
    // know" would lose the one signal they can act on.
  } catch (err) {
    log?.(
      `[connection-probe] ${input.pluginId}: could not record the verdict — ${errText(err)}`,
    );
  }

  if (verdict.status === 'inconclusive' && verdict.reason !== undefined) {
    log?.(
      `[connection-probe] ${input.pluginId}: no verdict (${verdict.reason}) — status left unchanged`,
    );
  }

  return verdict;
}

/** Serve a decided verdict for an unchanged credential, or run the probe and
 *  remember what it decided. Writing the status is the caller's job either
 *  way: the status registry is in-memory and cleared on every deactivation,
 *  so a cache hit still has to re-state its verdict. */
async function resolveFromCacheOrProbe(
  input: ConnectionProbeInput,
  cacheKey: string | undefined,
  clock: () => number,
): Promise<ConnectionProbeOutcome> {
  if (cacheKey !== undefined && input.force !== true) {
    const hit = cache.get(cacheKey);
    if (hit && clock() - hit.at < CONNECTION_PROBE_CACHE_TTL_MS) {
      return { ...hit.outcome, cached: true } as ConnectionProbeOutcome;
    }
    if (hit) cache.delete(cacheKey);
  }

  const verdict = await resolveVerdict(input);

  // Only a decided verdict is worth remembering. An `inconclusive` one says
  // nothing about the credential, and pinning it would keep a recovered target
  // looking unknown for the rest of the window.
  if (cacheKey !== undefined && verdict.status !== 'inconclusive') {
    cache.set(cacheKey, { outcome: verdict, at: clock() });
  }
  return verdict;
}

async function resolveVerdict(
  input: ConnectionProbeInput,
): Promise<ConnectionProbeOutcome> {
  const budget = input.timeoutMs ?? CONNECTION_PROBE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      Promise.resolve(input.verify()),
      new Promise<typeof TIMED_OUT>((resolve) => {
        // Deliberately NOT unref'd. An unref'd timer does not keep the event
        // loop alive, so when `verify` is a promise that never settles — the
        // exact case this budget exists for — there is nothing left to run and
        // the timeout never fires. The handle is cleared in `finally` as soon
        // as the race settles, so a ref'd timer outlives the probe by nothing.
        timer = setTimeout(() => {
          resolve(TIMED_OUT);
        }, budget);
      }),
    ]);
    if (answer === TIMED_OUT) {
      return { status: 'inconclusive', reason: 'timed_out' };
    }
    return normalizeVerdict(answer);
  } catch {
    return { status: 'inconclusive', reason: 'threw' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Sentinel for the timeout leg of the race — a plugin cannot return it, so it
 *  can never be confused with a real answer. */
const TIMED_OUT: unique symbol = Symbol('connection-probe-timeout');

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Validate what the plugin returned. Anything unrecognised is `inconclusive`:
 *  a probe that cannot be understood has not rejected anything. */
function normalizeVerdict(answer: unknown): ConnectionProbeOutcome {
  if (typeof answer !== 'object' || answer === null) {
    return { status: 'inconclusive', reason: 'malformed' };
  }
  const status = (answer as { status?: unknown }).status;
  const title = (answer as { title?: unknown }).title;
  const detail = (answer as { detail?: unknown }).detail;
  const copy = {
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof detail === 'string' ? { detail } : {}),
  };

  if (status === 'rejected') {
    // The one verdict core refuses to take on trust. A plugin that saw an
    // explicit refusal can name it; one that is guessing cannot, and guessing
    // here costs the operator their tools.
    const cause = (answer as { cause?: unknown }).cause;
    if (typeof cause !== 'string' || !REJECTION_CAUSES.has(cause)) {
      return { status: 'inconclusive', reason: 'unexplained_rejection' };
    }
    return { status, cause: cause as ConnectionRejectionCause, ...copy };
  }

  if (status === 'connected') {
    // A `cause` here is meaningless; drop it rather than pass it on.
    return { status, ...copy };
  }
  if (status === 'inconclusive') return { status: 'inconclusive', ...copy };
  return { status: 'inconclusive', reason: 'malformed' };
}

/** The sliver of `SecretVault` a fingerprint needs. Structural so a test
 *  passes a two-line stub and the real vault fits without a cast. */
export interface FingerprintVault {
  listKeys(pluginId: string): Promise<string[]>;
  get(pluginId: string, key: string): Promise<string | undefined>;
}

/**
 * Issue #1453 — a stable, non-reversible fingerprint of everything a plugin's
 * connection depends on, used as part of the verdict cache KEY so a replaced
 * or repaired credential can never be served the old answer.
 *
 * Covers BOTH halves of that surface: the plugin's vault entries, and the
 * non-secret setup values from the registry (odoo's `url`, `db`, `login`).
 * The second half is not a nicety. Those fields are written through
 * `PATCH /installed/:id/config`, which reactivates the plugin — so hashing the
 * vault alone meant repairing a wrong host produced an UNCHANGED fingerprint,
 * the cached `rejected` was re-reported, and the badge kept saying the
 * connection had failed for the rest of the TTL after the operator had already
 * fixed it. That is the inverse of the honesty this issue is about.
 *
 * Mirrors `providerCredentialVerifier.keyFingerprint`: a hash, never the
 * secret, and part of the key rather than a field checked after lookup. Keys
 * are sorted — and config values serialized with their object keys sorted,
 * because a shallow-merge PATCH rewrites a config in whatever order it likes —
 * so an unchanged credential always hashes the same. Every part is
 * length-prefixed, so `{a: 'bc'}` and `{ab: 'c'}` cannot collide.
 * Over-sensitivity is the safe direction here: an unrelated config write costs
 * one extra probe, a missed change costs the operator a lying badge.
 *
 * Returns `undefined` when there is nothing to fingerprint or the vault fails
 * — and then nothing is cached at all, which is the safe direction: a verdict
 * that cannot be tied to a credential must not outlive it.
 */
export async function credentialFingerprint(
  vault: FingerprintVault,
  pluginId: string,
  config?: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    const secretKeys = [...(await vault.listKeys(pluginId))].sort();
    const configKeys = Object.keys(config ?? {}).sort();
    if (secretKeys.length === 0 && configKeys.length === 0) return undefined;
    const hash = createHash('sha256');
    for (const key of secretKeys) {
      const value = (await vault.get(pluginId, key)) ?? '';
      hash.update(fingerprintPart(key) + fingerprintPart(value));
    }
    // Section separator: without it a vault entry and a config field of the
    // same name and value would be the same hash input.
    hash.update('\u0000config\u0000');
    for (const key of configKeys) {
      hash.update(fingerprintPart(key) + fingerprintPart(stableJson(config?.[key])));
    }
    return hash.digest('hex').slice(0, 32);
  } catch {
    return undefined;
  }
}

/** Length-prefixed, so two different splits of the same characters cannot
 *  produce the same hash input. */
function fingerprintPart(value: string): string {
  return `${String(value.length)}:${value};`;
}

/** Deterministic JSON for a config value: object keys sorted, so a config
 *  rewritten in a different key order is not read as a changed credential. */
function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`)
    .join(',')}}`;
}

/** What a dynamically imported plugin module might carry. Both runtimes read
 *  the export off `import()` and cannot prove its shape, hence `unknown`. */
export interface ProbeModuleShape {
  readonly verifyConnection?: (ctx: unknown) => unknown;
  readonly default?: { readonly verifyConnection?: (ctx: unknown) => unknown };
}

/** A probe already bound to one plugin's module and context. `force` on a
 *  single run bypasses the verdict cache. */
export type BoundProbe = (opts?: {
  readonly force?: boolean;
}) => Promise<ConnectionProbeOutcome>;

export interface BoundProbeOptions {
  /** Fingerprint of the credentials the bound probe is about; enables the
   *  verdict cache for it. */
  readonly credentialFingerprint?: string;
}

export interface PluginProbeTrackerOptions {
  /** Whether the plugin is still active in the owning runtime. Asked at the
   *  moment a verdict is about to be written, never cached. */
  isActive(pluginId: string): boolean;
  log?: (msg: string) => void;
}

/**
 * Issue #1453 — the per-runtime half of the probe: binding, backgrounding and
 * the "don't haunt a dead plugin" guard.
 *
 * Owned by `ToolPluginRuntime` and `DynamicAgentRuntime`. It lives here, once,
 * because it first shipped as two near-identical copies in those two files —
 * and only one of the copies was reachable from a test.
 */
export class PluginProbeTracker {
  /** Probes still in flight, by plugin id. Activation deliberately does not
   *  await them: a probe talks to a third-party system, and N integrations
   *  must not add N network round-trips to the boot path. Tracking them anyway
   *  keeps the promises observable — `settled()` is what tests await instead
   *  of sleeping. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: PluginProbeTrackerOptions) {}

  /**
   * Bind `mod`'s `verifyConnection` (if it exports one) to `ctx`.
   *
   * Called at activation time rather than at probe time so a later re-check
   * reaches the SAME context the plugin activated with, down to the vault
   * handle and the status accessor scoped to this plugin id. Returns
   * `undefined` for a module that declares no probe — the shape every plugin
   * had before #1453.
   */
  bind(
    pluginId: string,
    mod: ProbeModuleShape,
    ctx: { readonly status: ConnectionProbeStatusSink },
    opts: BoundProbeOptions = {},
  ): BoundProbe | undefined {
    const verify = mod.verifyConnection ?? mod.default?.verifyConnection;
    if (typeof verify !== 'function') return undefined;
    return (runOpts = {}): Promise<ConnectionProbeOutcome> =>
      runConnectionProbe({
        pluginId,
        ...(opts.credentialFingerprint !== undefined
          ? { credentialFingerprint: opts.credentialFingerprint }
          : {}),
        ...(runOpts.force === true ? { force: true } : {}),
        // The plugin gets its real context; the VERDICT goes through a sink
        // that falls silent once the plugin is no longer active. A probe is
        // not awaited, so a deactivation can land while one is in flight —
        // and deactivation clears the status registry, so a verdict arriving
        // afterwards would re-create a badge for a plugin that is gone.
        status: this.sinkWhileActive(pluginId, ctx.status),
        verify: () => verify(ctx),
        ...(this.opts.log ? { log: this.opts.log } : {}),
      });
  }

  /** Run `probe` in the background, tracked until it settles.
   *  `runConnectionProbe` never rejects, so this can only drop its entry. */
  start(pluginId: string, probe: BoundProbe): void {
    void this.run(pluginId, probe);
  }

  /** Run `probe` and await its verdict, tracked the same way. `force` bypasses
   *  the verdict cache — the operator-triggered re-check passes it. */
  run(
    pluginId: string,
    probe: BoundProbe,
    opts: { readonly force?: boolean } = {},
  ): Promise<ConnectionProbeOutcome> {
    const running = probe(opts).finally(() => {
      this.inFlight.delete(pluginId);
    });
    this.inFlight.set(pluginId, running);
    return running;
  }

  /** Settle every probe started so far. For tests and for a caller that
   *  genuinely needs the verdict; nothing on the boot path waits for probes. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private sinkWhileActive(
    pluginId: string,
    sink: ConnectionProbeStatusSink,
  ): ConnectionProbeStatusSink {
    return {
      report: (status): void => {
        if (this.opts.isActive(pluginId)) sink.report(status);
      },
      clear: (): void => {
        if (this.opts.isActive(pluginId)) sink.clear();
      },
    };
  }
}
