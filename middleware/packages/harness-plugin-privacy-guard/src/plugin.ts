import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import {
  PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PolicyMode,
  type PrivacyDetector,
  type PrivacyDetectorRegistry,
  type PrivacyEgressMode,
  type PrivacyGuardService,
} from '@omadia/plugin-api';

import { createPrivacyGuardService } from './service.js';
import type { AllowlistConfig } from './allowlist.js';

/**
 * @omadia/plugin-privacy-guard — plugin entry point.
 *
 * Activation wiring:
 *   1. Read `policy_mode`, `fail_open`, `debug_show_values` from `ctx.config`.
 *   2. Privacy-Shield v2 (Slice S-3): assemble the pre-detector
 *      allowlist from the bundled repo-default JSON + two plugin-
 *      config term arrays (`tenant_self_terms`, `extra_allowlist_terms`).
 *   3. Build the {@link PrivacyGuardService} via the pure factory.
 *   4. Publish it as `privacyRedact` (capability `privacy.redact@1`)
 *      for the orchestrator hook.
 *   5. Slice 3.1: also publish a thin `PrivacyDetectorRegistry` facade
 *      under `privacyDetectorRegistry` so add-on detector plugins
 *      (Ollama, Presidio) can register at activate time without
 *      forking this plugin.
 *
 * Per-turn state: every turn gets its own tokenise-map; the service
 * discards both the map and the receipt accumulator at `finalizeTurn`
 * (Privacy-Shield v2 / Slice S-2). No cross-turn persistence.
 */

export interface PrivacyGuardPluginHandle {
  close(): Promise<void>;
  /** Privacy-Shield v2 (Slice S-6) — operator-tunable egress filter
   *  configuration, resolved at activate time. The host (orchestrator
   *  + routine runner) reads this to decide whether to call the
   *  service's `egressFilter` method and what placeholder to swap in
   *  on a `blocked` routing. Surfaced here so a half-configured
   *  plugin reveals its effective state without re-parsing config. */
  readonly egressConfig: EgressFilterPluginConfig;
}

/**
 * Privacy-Shield v2 (Slice S-6) — egress-filter plugin config. Reads
 * three operator-tunable keys with safe defaults:
 *
 *   - `egress_filter_enabled` (default `true`):  master switch read
 *     by the host. The plugin itself always exposes the
 *     `egressFilter` method; the host decides whether to call it.
 *     This config is surfaced on the plugin handle so the host can
 *     short-circuit cleanly without poking at internal state.
 *   - `egress_filter_mode`    (default `'mask'`): reaction mode for
 *     spontaneous PII detected at egress time. `mark` records on the
 *     receipt only; `mask` rewrites the spans inline; `block` returns
 *     a `blocked` routing so the host swaps the payload for a
 *     placeholder.
 *   - `egress_block_placeholder_text` (default localised English):
 *     channel-agnostic placeholder the host substitutes when
 *     `egress_filter_mode === 'block'` and the routing comes back as
 *     `blocked`. The plugin does not perform the swap itself — that
 *     belongs to the integration boundary (orchestrator + routine
 *     runner).
 */
export interface EgressFilterPluginConfig {
  readonly enabled: boolean;
  readonly mode: PrivacyEgressMode;
  readonly placeholderText: string;
}

const DEFAULT_EGRESS_PLACEHOLDER =
  'The response was withheld because it contained data the privacy filter could not verify. Please rephrase your request.';

export async function activate(
  ctx: PluginContext,
): Promise<PrivacyGuardPluginHandle> {
  ctx.log('[privacy-guard] activating');

  const policyMode = readPolicyMode(ctx);
  // `fail_open` is read for log visibility; the actual fail-mode plumbing
  // lands in Slice 2 with the orchestrator hook (the service today is
  // pure compute, never `fail`s).
  const failOpen = readFailOpen(ctx);
  // Slice 3.2.1: operator-toggle that authorises the receipt to carry
  // raw matched values. Default off — receipts stay PII-free.
  const debugShowValues = readDebugShowValues(ctx);

  // Privacy-Shield v2 (Slice S-3) — assemble the three allowlist
  // sources at activate time. Repo-default ships in the package; the
  // tenant-self and operator-override come from plugin config.
  const allowlist = await loadAllowlistConfig(ctx);

  // Privacy-Shield v2 (Slice S-6) — egress filter config. The plugin
  // surfaces the resolved values on its handle so the host can wire
  // them without re-parsing config.
  const egressConfig: EgressFilterPluginConfig = {
    enabled: readEgressEnabled(ctx),
    mode: readEgressMode(ctx),
    placeholderText: readEgressPlaceholder(ctx),
  };

  // Privacy-Shield v2 (D-1) — Output Validator's token-loss threshold.
  // Below the threshold, the validator emits `recommendation: retry`;
  // above, it escalates to `block` (when combined with spontaneous-PII
  // hits). Surfaced as plugin config so operators can tune the
  // sensitivity per tenant without a code change.
  const tokenLossThreshold = readTokenLossThreshold(ctx);

  const service = createPrivacyGuardService({
    defaultPolicyMode: policyMode,
    debugShowValues,
    allowlist,
    egressFilterMode: egressConfig.mode,
    egressFilterEnabled: egressConfig.enabled,
    egressBlockPlaceholderText: egressConfig.placeholderText,
    ...(tokenLossThreshold !== undefined ? { tokenLossThreshold } : {}),
  });

  const disposeService = ctx.services.provide<PrivacyGuardService>(
    PRIVACY_REDACT_SERVICE_NAME,
    service,
  );

  // Slice 3.1: thin facade over the service's internal detector list.
  // Add-on plugins (Slice 3.2 Ollama, Slice 3.4 Presidio) resolve this
  // service via `ctx.services.get(PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME)`
  // and call `register(detector)` from their own `activate()`.
  const registry: PrivacyDetectorRegistry = {
    register: (detector: PrivacyDetector) => service.registerDetector(detector),
    list: () => service.listDetectors(),
  };
  const disposeRegistry = ctx.services.provide<PrivacyDetectorRegistry>(
    PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
    registry,
  );

  const allowlistTotals =
    (allowlist.tenantSelfTerms?.length ?? 0) +
    (allowlist.repoDefaultTerms?.length ?? 0) +
    (allowlist.operatorOverrideTerms?.length ?? 0);
  ctx.log(
    `[privacy-guard] ready (policy_mode=${policyMode}, fail_open=${failOpen}, ` +
      `debug_show_values=${debugShowValues ? 'on' : 'off'}, ` +
      `detectors=${service
        .listDetectors()
        .map((d) => d.id)
        .join(',')}, ` +
      `allowlist=${String(allowlistTotals)} terms ` +
      `(tenant=${String(allowlist.tenantSelfTerms?.length ?? 0)} ` +
      `repo=${String(allowlist.repoDefaultTerms?.length ?? 0)} ` +
      `override=${String(allowlist.operatorOverrideTerms?.length ?? 0)}), ` +
      `egress=${egressConfig.enabled ? `on/${egressConfig.mode}` : 'off'}, ` +
      `token_loss_threshold=${tokenLossThreshold === undefined ? 'default' : tokenLossThreshold.toFixed(2)})`,
  );
  if (debugShowValues) {
    ctx.log(
      '[privacy-guard] WARNING: debug_show_values=on — receipts will carry raw matched values for tokenized hits. Disable before exporting receipts outside this dev tenant.',
    );
  }

  return {
    async close(): Promise<void> {
      ctx.log('[privacy-guard] deactivating');
      // Reverse-order dispose: registry first (so a late detector
      // registration during shutdown can't slip in after the service
      // has already gone away), then the service itself.
      disposeRegistry();
      disposeService();
    },
    egressConfig,
  };
}

// ---------------------------------------------------------------------------
// Config readers — tolerate missing/malformed inputs by falling back to
// safe defaults so a half-configured plugin still boots.
// ---------------------------------------------------------------------------

function readPolicyMode(ctx: PluginContext): PolicyMode {
  const raw = ctx.config.get<unknown>('policy_mode');
  if (typeof raw !== 'string') return 'pii-shield';
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'data-residency') return 'data-residency';
  return 'pii-shield';
}

function readFailOpen(ctx: PluginContext): 'open' | 'closed' {
  const raw = ctx.config.get<unknown>('fail_open');
  if (typeof raw !== 'string') return 'closed';
  return raw.trim().toLowerCase() === 'open' ? 'open' : 'closed';
}

function readDebugShowValues(ctx: PluginContext): boolean {
  const raw = ctx.config.get<unknown>('debug_show_values');
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === 'on' || trimmed === 'true' || trimmed === 'yes' || trimmed === '1';
}

// Privacy-Shield v2 (Slice S-6) — egress filter config readers.

function readEgressEnabled(ctx: PluginContext): boolean {
  const raw = ctx.config.get<unknown>('egress_filter_enabled');
  // Default on: omitting the key keeps the safer behaviour.
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'true' || trimmed === '1' || trimmed === 'on' || trimmed === 'yes') {
      return true;
    }
    if (trimmed === 'false' || trimmed === '0' || trimmed === 'off' || trimmed === 'no') {
      return false;
    }
  }
  ctx.log("[privacy-guard] config 'egress_filter_enabled' has unsupported value; defaulting to enabled");
  return true;
}

function readEgressMode(ctx: PluginContext): PrivacyEgressMode {
  const raw = ctx.config.get<unknown>('egress_filter_mode');
  if (typeof raw !== 'string') return 'mask';
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'mark' || trimmed === 'mask' || trimmed === 'block') {
    return trimmed;
  }
  ctx.log(
    `[privacy-guard] config 'egress_filter_mode' has unsupported value '${raw}'; defaulting to 'mask'`,
  );
  return 'mask';
}

function readEgressPlaceholder(ctx: PluginContext): string {
  const raw = ctx.config.get<unknown>('egress_block_placeholder_text');
  if (typeof raw !== 'string') return DEFAULT_EGRESS_PLACEHOLDER;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_EGRESS_PLACEHOLDER;
}

// Privacy-Shield v2 (D-1) — Output Validator token-loss threshold reader.
// Accepts a float in [0, 1]; out-of-range or unparseable values fall back
// to the service-internal default (0.3). Returns undefined when the
// operator did not set the key so the service keeps using its own default.
function readTokenLossThreshold(ctx: PluginContext): number | undefined {
  const raw = ctx.config.get<unknown>('token_loss_threshold');
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string') {
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed)) {
      ctx.log(
        `[privacy-guard] config 'token_loss_threshold' is not a valid number ('${raw}'); using service default`,
      );
      return undefined;
    }
    value = parsed;
  } else {
    ctx.log(
      "[privacy-guard] config 'token_loss_threshold' has unsupported type; using service default",
    );
    return undefined;
  }
  if (value < 0 || value > 1) {
    ctx.log(
      `[privacy-guard] config 'token_loss_threshold' out of range [0,1] (got ${String(value)}); using service default`,
    );
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Privacy-Shield v2 (Slice S-3) — allowlist assembly.
//
// Reads the bundled repo-default JSON and the two operator-supplied
// term lists from plugin config:
//
//   - `tenant_self_terms`        — populated by the host from the
//                                  operator profile (tenant.name,
//                                  aliases, gf_namen, address,
//                                  domain, hrb_nr). The plugin does
//                                  not query the operator-profile
//                                  service directly; the host is
//                                  responsible for wiring this in
//                                  on plugin activate.
//   - `extra_allowlist_terms`    — free-form additions by the
//                                  operator via plugin setup UI.
//
// Both are accepted as JSON-array-of-strings. Malformed inputs fall
// back to an empty list and log a warning so the plugin still boots.
// ---------------------------------------------------------------------------

async function loadAllowlistConfig(ctx: PluginContext): Promise<AllowlistConfig> {
  const repoDefaultTerms = await loadRepoDefaultTerms(ctx);
  const tenantSelfTerms = readStringArray(ctx, 'tenant_self_terms');
  const operatorOverrideTerms = readStringArray(ctx, 'extra_allowlist_terms');
  return { tenantSelfTerms, repoDefaultTerms, operatorOverrideTerms };
}

async function loadRepoDefaultTerms(ctx: PluginContext): Promise<readonly string[]> {
  // Two repo-shipped categories merge into the `repoDefault` source:
  //   - topic-nouns: HR/office compound nouns FP-tagged by spaCy
  //   - common-words: greetings + affirmations + casual filler
  // Loading both is best-effort: a missing file logs once and the
  // allowlist runs with whatever did load. Returning [] for both is
  // a degraded-but-functional path.
  const [topicNouns, commonWords] = await Promise.all([
    loadTermsFile(ctx, 'privacy-topic-nouns-de.json'),
    loadTermsFile(ctx, 'privacy-common-words-de.json'),
  ]);
  return [...topicNouns, ...commonWords];
}

async function loadTermsFile(
  ctx: PluginContext,
  filename: string,
): Promise<readonly string[]> {
  try {
    // Resolve the JSON path relative to the compiled plugin module so
    // it works in both `dist/` (production) and `src/` (dev / tsx).
    const here = path.dirname(fileURLToPath(import.meta.url));
    // From `dist/` we step up to the package root and down to data/.
    // The same relative path works from `src/` too because the data
    // folder sits alongside both.
    const candidates = [
      path.resolve(here, '..', 'data', filename),
      path.resolve(here, '..', '..', 'data', filename),
    ];
    for (const p of candidates) {
      try {
        const raw = await readFile(p, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'terms' in parsed &&
          Array.isArray((parsed as { terms: unknown }).terms)
        ) {
          const terms = (parsed as { terms: unknown[] }).terms.filter(
            (t): t is string => typeof t === 'string',
          );
          return terms;
        }
      } catch {
        // Try the next candidate.
      }
    }
    ctx.log(
      `[privacy-guard] ${filename} not found in package data/ — allowlist runs without those repo defaults`,
    );
    return [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`[privacy-guard] failed to load ${filename}: ${msg}`);
    return [];
  }
}

function readStringArray(ctx: PluginContext, key: string): readonly string[] {
  const raw = ctx.config.get<unknown>(key);
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string');
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];
    // Accept JSON-encoded arrays or comma-separated bare strings.
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((x): x is string => typeof x === 'string');
        }
      } catch {
        ctx.log(
          `[privacy-guard] config '${key}' is a string but not valid JSON; falling back to comma-split`,
        );
      }
    }
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  ctx.log(`[privacy-guard] config '${key}' has unsupported type, ignoring`);
  return [];
}
