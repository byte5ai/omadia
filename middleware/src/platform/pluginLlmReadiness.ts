/**
 * Shared LLM-provider readiness verdicts. This logic used to live inline in
 * the providers-admin list handler. Plugin readiness (#884) needs the exact
 * same answer, and duplicating it would have let the Hub's "ready" count and
 * the providers page disagree about the very same credential — which is the
 * bug #884 reports.
 */
import {
  isProviderOAuthReconnectRequired,
  legacyProviderApiKeyVaultKey,
  providerApiKeyVaultKey,
  readProviderOAuthTokens,
  type ProviderId,
} from '@omadia/llm-provider';

import {
  detectCliBackends,
  type CliBackendsSnapshot,
} from './cliBackendDetector.js';
import {
  decodeVerifiedRecord,
  getCachedVerification,
  primeVerification,
  providerVerifiedAtVaultKey,
  type ProviderVerification,
} from './providerCredentialVerifier.js';

/**
 * LLM-consuming plugins whose provider/model is operator-selectable. The
 * provider key is the standardized `llm_provider` (S4b) for all; the model key
 * differs per plugin. `extraOnSwitch` is applied when assigning — e.g. the
 * orchestrator's per-turn model routing must be OFF for a non-Anthropic
 * provider, else it would emit Claude model ids to a non-Claude provider.
 */
export interface LlmPluginDesc {
  readonly id: string;
  readonly label: string;
  /** Model config keys to set (first is the primary shown in the UI). */
  readonly modelKeys: readonly string[];
  /** Extra config to apply on a non-Anthropic assignment. */
  readonly extraOnNonAnthropic?: Readonly<Record<string, string>>;
  /** This plugin drives a tool loop, so a tool-less provider (e.g. the
   *  `claude-cli` Shape-2 backend) must NOT be assignable to it — that would
   *  silently disable its tools. Tool-less plugins (extractors/classifiers)
   *  omit this. */
  readonly requiresTools?: boolean;
}

export const LLM_PLUGINS: ReadonlyArray<LlmPluginDesc> = [
  {
    id: '@omadia/orchestrator',
    label: 'Orchestrator',
    modelKeys: ['orchestrator_model'],
    // Per-turn Sonnet/Opus routing only makes sense within Anthropic; the
    // default chatAgent path now accepts the subscription CLI via Shape 3.
    extraOnNonAnthropic: { orchestrator_model_routing: 'false' },
  },
  {
    id: '@omadia/verifier',
    label: 'Verifier',
    modelKeys: ['verifier_model'],
    // The verifier uses FORCED single-tool structured output (claimExtractor /
    // evidenceJudge), which the claude-cli provider now supports via a
    // JSON-schema prompt — so the subscription CLI is a valid choice here.
  },
  {
    id: '@omadia/orchestrator-extras',
    label: 'Background-Scorer',
    modelKeys: ['fact_extractor_model', 'topic_classifier_model'],
  },
];

export const DEFAULT_PROVIDER: ProviderId = 'anthropic';

export interface LlmProviderDescriptorView {
  readonly label: string;
  readonly wireFormat?: string;
  readonly baseURL?: string;
  readonly policy?: {
    readonly requiresAvvDisclosure?: boolean;
    readonly euHosted?: boolean;
    readonly requiresApiKey?: boolean;
    readonly subscriptionNotice?: boolean;
  };
  readonly oauth?: { readonly kind: 'device' };
}

export interface LlmProviderCatalogView {
  get(id: string): LlmProviderDescriptorView | undefined;
}

/** The subset of `SecretVault` the provider-credential lookups need. Structural
 *  for the same reason `ReadinessVault` is: a test passes a one-line stub and
 *  the real vault fits without a cast. */
export interface ProviderKeyVault {
  get(agentId: string, key: string): Promise<string | undefined>;
}

export interface StoredProviderKey {
  /** The LLM-plugin vault scope the key was found in. Durable verification
   *  records are written to (and read from) this same scope, so the two never
   *  disagree about which scope owns the provider's state. */
  readonly scope: string;
  readonly apiKey: string;
}

/** First LLM-plugin scope holding this provider's API key (canonical, or the
 *  legacy flat key for Anthropic), or `undefined` if no scope has one. */
export async function findProviderKey(
  vault: ProviderKeyVault | undefined,
  provider: ProviderId,
): Promise<StoredProviderKey | undefined> {
  if (!vault) return undefined;
  const canonical = providerApiKeyVaultKey(provider);
  const legacy = legacyProviderApiKeyVaultKey(provider);
  for (const desc of LLM_PLUGINS) {
    for (const key of legacy === undefined ? [canonical] : [canonical, legacy]) {
      const v = await vault.get(desc.id, key);
      if (typeof v === 'string' && v.trim().length > 0) {
        return { scope: desc.id, apiKey: v.trim() };
      }
    }
  }
  return undefined;
}

/** True when any LLM-plugin scope holds an OAuth access token for the provider
 *  (#294). "Connected via Sign in with ChatGPT" is exactly this. */
async function isProviderOAuthConnected(
  vault: ProviderKeyVault | undefined,
  provider: ProviderId,
): Promise<boolean> {
  if (!vault) return false;
  for (const desc of LLM_PLUGINS) {
    const tokens = await readProviderOAuthTokens(
      (k) => vault.get(desc.id, k),
      provider,
    );
    if (tokens !== undefined) return true;
  }
  return false;
}

/**
 * The provider's credential verdict, WITHOUT touching the network:
 *   - no key in any scope                       → `no_key`
 *   - keyless provider (local/self-hosted)      → `verified`
 *   - a fresh cached probe for THIS key         → that verdict
 *   - a durable `verified_at` record for THIS key → `verified`
 *   - otherwise                                 → `unverified`
 *
 * `unverified` is the honest default: a key exists, but nothing has ever proved
 * it works. That is precisely the state the old boolean rendered as "connected".
 */
async function resolveKeyBasedStatus(
  vault: ProviderKeyVault | undefined,
  provider: ProviderId,
  descriptor: LlmProviderDescriptorView | undefined,
): Promise<ProviderVerification> {
  // Local / self-hosted providers have no credential to reject.
  if (descriptor?.policy?.requiresApiKey === false) {
    return { status: 'verified' };
  }
  const found = await findProviderKey(vault, provider);
  if (found === undefined) return { status: 'no_key' };

  const cached = getCachedVerification(provider, found.apiKey);
  if (cached !== undefined) return cached;

  // Cold cache (fresh process). A durable record proves an earlier probe
  // succeeded — but only if it was written for the key that is stored NOW.
  const raw = await vault?.get(
    found.scope,
    providerVerifiedAtVaultKey(provider),
  );
  const verifiedAt = decodeVerifiedRecord(raw, found.apiKey);
  if (verifiedAt !== undefined) {
    const verification: ProviderVerification = {
      status: 'verified',
      verifiedAt,
      checkedAt: verifiedAt,
    };
    primeVerification(provider, found.apiKey, verification);
    return verification;
  }
  return { status: 'unverified' };
}

export function readStringConfig(
  cfg: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = cfg[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export interface ProviderVerificationDeps {
  readonly vault?: ProviderKeyVault;
  readonly llmProviderCatalog?: LlmProviderCatalogView;
  /** Pre-detected CLI snapshot. The providers-admin list handler probes ONCE
   *  and fans the same snapshot across every row; passing it in preserves that
   *  single-probe property instead of re-detecting per provider. `undefined`
   *  means "not detected, or detection failed". */
  readonly cliSnapshot?: CliBackendsSnapshot | undefined;
}

export async function resolveProviderVerification(
  provider: ProviderId,
  deps: ProviderVerificationDeps,
): Promise<ProviderVerification> {
  const descriptor = deps.llmProviderCatalog?.get(provider);
  // #294: an OAuth provider is "connected" when device-flow tokens are
  // stored — the login IS the credential, so there is no key to probe.
  const oauthConnect = descriptor?.oauth !== undefined;
  const cliConnected = (cliId: string): boolean =>
    deps.cliSnapshot?.backends.find((b) => b.id === cliId)?.loggedIn === 'yes';
  // #309: a CLI-backed provider is keyless — its "does it work" probe is
  // the CLI login check above, not a credential probe.
  return provider === 'claude-cli'
    ? cliConnected('claude')
      ? { status: 'verified' }
      : { status: 'no_key' }
    : oauthConnect
      ? // A dead grant (terminal refresh failure) leaves stale tokens
        // in the vault; the process-wide latch is the truth. Report
        // `no_key` so the row shows "Reconnect" instead of a green
        // chip that lies while every call throws.
        isProviderOAuthReconnectRequired(provider) ||
        !(await isProviderOAuthConnected(deps.vault, provider))
        ? { status: 'no_key' }
        : { status: 'verified' }
      : await resolveKeyBasedStatus(deps.vault, provider, descriptor);
}

export interface PluginLlmReadinessDeps extends ProviderVerificationDeps {
  /** CLI detection for callers that — unlike the providers-admin page — have no
   *  pre-detected snapshot to hand down. Defaults to the cached
   *  `detectCliBackends()`; a test injects a stub so no test ever shells out. */
  readonly detectCli?: () => Promise<CliBackendsSnapshot | undefined>;
}

const detectCliSnapshot = (): Promise<CliBackendsSnapshot | undefined> =>
  detectCliBackends().catch(() => undefined);

export async function resolvePluginLlmReadiness(
  pluginId: string,
  config: Record<string, unknown> | undefined,
  deps: PluginLlmReadinessDeps,
): Promise<ProviderVerification | undefined> {
  if (!LLM_PLUGINS.some((desc) => desc.id === pluginId)) {
    return undefined;
  }

  const provider = (
    readStringConfig(config ?? {}, 'llm_provider') ?? DEFAULT_PROVIDER
  ) as ProviderId;
  const cliSnapshot =
    'cliSnapshot' in deps
      ? deps.cliSnapshot
      : provider === 'claude-cli'
        ? await (deps.detectCli ?? detectCliSnapshot)()
        : undefined;
  return await resolveProviderVerification(provider, { ...deps, cliSnapshot });
}

/**
 * OM-75 / OM-78 (#1000, #1001) — WHY the agent runtime is down, for the
 * `multi_orchestrator_unavailable` 503 the readiness banner probes.
 *
 * The banner used to render one fixed text ("no key or subscription yet") for
 * every 503. In the round-4 beta test that text was wrong at the moment it
 * mattered: the tester HAD a working subscription login, and what was missing
 * was the orchestrator's provider assignment (`llm_provider` still on the
 * default `anthropic`, for which no key exists). Two different remedies, one
 * message. This verdict tells them apart:
 *
 *   - `no_llm_access`  → no provider has any credential (key, OAuth, CLI login)
 *   - `no_assignment`  → some provider has access, but the one the orchestrator
 *                        is assigned to does not
 *   - `unknown`        → access and assignment line up; the runtime is down
 *                        for another reason (DATABASE_URL, boot, crash)
 */
export type RuntimeReadinessCause = 'no_llm_access' | 'no_assignment' | 'unknown';

export interface RuntimeReadinessCauseInputs {
  /** Credential verdict per provider id, as `resolveProviderVerification`
   *  reports it. Any status other than `no_key` counts as "has access". */
  readonly providerStatuses: ReadonlyMap<string, ProviderVerification['status']>;
  /** The provider the orchestrator is assigned to (`llm_provider`, defaulted). */
  readonly assignedProvider: string;
}

/** Pure verdict. Kept separate from the I/O so it can be tested exhaustively. */
export function computeRuntimeReadinessCause(
  inputs: RuntimeReadinessCauseInputs,
): RuntimeReadinessCause {
  const hasAccess = (status: ProviderVerification['status'] | undefined): boolean =>
    status !== undefined && status !== 'no_key';
  const anyAccess = [...inputs.providerStatuses.values()].some(hasAccess);
  if (!anyAccess) return 'no_llm_access';
  if (!hasAccess(inputs.providerStatuses.get(inputs.assignedProvider))) {
    return 'no_assignment';
  }
  return 'unknown';
}

export interface RuntimeReadinessCauseDeps extends PluginLlmReadinessDeps {
  /** Every provider id the credential lookup should consider. The providers
   *  admin derives this from `listModels()`; passing it in keeps this module
   *  free of the model registry. */
  readonly providerIds: readonly string[];
  /** The orchestrator plugin's installed config (`llm_provider` is read from
   *  it). `undefined` when the plugin is not installed. */
  readonly orchestratorConfig: Record<string, unknown> | undefined;
}

/**
 * I/O wrapper around `computeRuntimeReadinessCause`: resolves every provider's
 * verdict WITHOUT touching the network (cached probes, durable records, one
 * CLI detection), reads the orchestrator's assignment, and never throws — a
 * failure inside the lookup degrades to `unknown`, because this only decorates
 * an error response that is being sent anyway.
 */
export async function resolveRuntimeReadinessCause(
  deps: RuntimeReadinessCauseDeps,
): Promise<RuntimeReadinessCause> {
  try {
    const cliSnapshot =
      'cliSnapshot' in deps
        ? deps.cliSnapshot
        : await (deps.detectCli ?? detectCliSnapshot)();
    const entries = await Promise.all(
      deps.providerIds.map(async (id) => {
        const verdict = await resolveProviderVerification(id as ProviderId, {
          ...deps,
          cliSnapshot,
        });
        return [id, verdict.status] as const;
      }),
    );
    const assignedProvider =
      readStringConfig(deps.orchestratorConfig ?? {}, 'llm_provider') ??
      DEFAULT_PROVIDER;
    return computeRuntimeReadinessCause({
      providerStatuses: new Map(entries),
      assignedProvider,
    });
  } catch {
    return 'unknown';
  }
}
