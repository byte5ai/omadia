/**
 * `/api/v1/admin/providers` — the backend for the dedicated "Modelle"
 * (models/providers) admin page (S6 of the LLM-provider plan). Deliberately
 * SEPARATE from the generic settings catalog: the operator manages many
 * providers + many models here, and per-orchestrator provider/model selection
 * lives on this page (not buried in the per-plugin settings panel).
 *
 * GET  /                 → providers (from the global model registry, with
 *                          connection status) + per-plugin LLM assignments.
 * POST /assignment       → set { provider, model } for an LLM-consuming plugin
 *                          (writes its config + reactivates). A dedicated
 *                          endpoint (plugin id in the body, not the URL) avoids
 *                          the encoded-slash proxy 404 the runtime config route
 *                          hits from the browser.
 * POST /:id/verify       → probe the stored key against the provider's API and
 *                          record the verdict.
 *
 * CONNECTION STATUS (OM-02/03/04): "connected" used to mean nothing more than
 * "the vault holds a non-empty string". A stale env-seeded key therefore
 * rendered as a green badge while every chat turn failed with
 * `invalid x-api-key`. The status is now a four-state verdict from
 * `providerCredentialVerifier` — `no_key` / `unverified` / `verified` /
 * `invalid`. `connected` is retained as `status !== 'no_key'` for
 * backwards-compatible consumers.
 *
 * HARD CONTRACT: the GET handler NEVER makes a network call. It serves the
 * cached verdict (or `unverified`), exactly like `detectCliBackends()` already
 * does here. Probing on read would make the dashboard slow, rate-limitable and
 * dependent on the provider being up.
 */
import {
  exchangeAuthorizationCode,
  isProviderOAuthReconnectRequired,
  legacyProviderApiKeyVaultKey,
  listModels,
  listModelsByProvider,
  OPENAI_CODEX_OAUTH,
  pollDeviceToken,
  primeProviderOAuthTokens,
  providerApiKeyVaultKey,
  readProviderOAuthTokens,
  requestUserCode,
  resolveModelRef,
  writeProviderOAuthTokens,
  type OAuthClientConfig,
  type OAuthTokens,
  type ProviderId,
  type UserCodeGrant,
} from '@omadia/llm-provider';
import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import type { Request, Response } from 'express';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { SecretVault } from '../secrets/vault.js';
import { detectCliBackends } from '../platform/cliBackendDetector.js';
import {
  decodeVerifiedRecord,
  encodeVerifiedRecord,
  getCachedVerification,
  keyFingerprint,
  primeVerification,
  providerVerifiedAtVaultKey,
  verifyProviderCredential,
  type ProviderVerification,
} from '../platform/providerCredentialVerifier.js';

export interface AdminProvidersDeps {
  readonly installedRegistry: InstalledRegistry;
  readonly vault?: SecretVault;
  /** Tear down + re-activate a plugin so it re-reads its config. */
  readonly reactivate?: (agentId: string) => Promise<void>;
  /** Provider catalog — supplies display labels + data-protection policy hints
   *  for the admin UI (structural, to avoid a hard dep on the catalog class). */
  readonly llmProviderCatalog?: {
    get(id: string):
      | {
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
      | undefined;
  };
  /** OAuth client config for the device flow. Defaults to the OpenAI Codex
   *  client; a test injects a fake pointing at a mock issuer. */
  readonly oauthConfig?: OAuthClientConfig;
  /** Injected fetch for the device-flow HTTP calls (test seam). */
  readonly oauthFetch?: typeof fetch;
}

/** The subset of a catalog descriptor the credential probe needs. */
type ProviderDescriptorView = NonNullable<
  ReturnType<NonNullable<AdminProvidersDeps['llmProviderCatalog']>['get']>
>;

/**
 * LLM-consuming plugins whose provider/model is operator-selectable. The
 * provider key is the standardized `llm_provider` (S4b) for all; the model key
 * differs per plugin. `extraOnSwitch` is applied when assigning — e.g. the
 * orchestrator's per-turn model routing must be OFF for a non-Anthropic
 * provider, else it would emit Claude model ids to a non-Claude provider.
 */
interface LlmPluginDesc {
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

const LLM_PLUGINS: ReadonlyArray<LlmPluginDesc> = [
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

const DEFAULT_PROVIDER: ProviderId = 'anthropic';

function providerLabel(id: ProviderId): string {
  switch (id) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'openai-compatible':
      return 'OpenAI-compatible';
    case 'mistral':
      return 'Mistral';
    default:
      return id;
  }
}

interface StoredProviderKey {
  /** The LLM-plugin vault scope the key was found in. Durable verification
   *  records are written to (and read from) this same scope, so the two never
   *  disagree about which scope owns the provider's state. */
  readonly scope: string;
  readonly apiKey: string;
}

/** First LLM-plugin scope holding this provider's API key (canonical, or the
 *  legacy flat key for Anthropic), or `undefined` if no scope has one. */
async function findProviderKey(
  vault: SecretVault | undefined,
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
  vault: SecretVault | undefined,
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

/** Fan a provider's OAuth tokens out to EVERY LLM-plugin scope with one shared
 *  `updatedAt` stamp (newest-wins hydration relies on the stamp), then reactivate
 *  the installed ones so they re-read. Refresh-token rotation makes divergent
 *  per-scope copies dangerous — this keeps them identical. */
async function fanOutProviderOAuthTokens(
  deps: AdminProvidersDeps,
  provider: ProviderId,
  tokens: OAuthTokens,
): Promise<void> {
  const vault = deps.vault;
  if (!vault) return;
  const updatedAt = Date.now();
  for (const desc of LLM_PLUGINS) {
    await writeProviderOAuthTokens(
      (k, v) => vault.setMany(desc.id, { [k]: v }),
      provider,
      tokens,
      updatedAt,
    );
  }
  if (deps.reactivate) {
    for (const desc of LLM_PLUGINS) {
      if (deps.installedRegistry.has(desc.id)) {
        await deps.reactivate(desc.id).catch(() => undefined);
      }
    }
  }
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
async function resolveStatus(
  vault: SecretVault | undefined,
  provider: ProviderId,
  descriptor: ProviderDescriptorView | undefined,
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

/**
 * Stable provider ordering (OM-10b). `listModels()` returns providers in plugin
 * ACTIVATION order, and `reactivate()` after a key save disposes + re-registers
 * that plugin's models — moving the provider the operator just configured to the
 * bottom of the list. Sort explicitly instead: usable providers first, then by
 * label, then by id as the final tiebreaker.
 *
 * Deliberately NOT `localeCompare` — see `web-ui/app/_components/Nav.tsx`: the
 * server and the client can resolve different collations, which makes the
 * rendered order differ from the server order and trips React hydration.
 */
function compareProviders(
  a: { connected: boolean; label: string; id: string },
  b: { connected: boolean; label: string; id: string },
): number {
  if (a.connected !== b.connected) return a.connected ? -1 : 1;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function readStringConfig(
  cfg: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = cfg[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function createAdminProvidersRouter(deps: AdminProvidersDeps): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    // Express 4 does not forward async-handler rejections to error middleware —
    // an uncaught vault/read failure would hang the request. Catch → 500.
    try {
      const providerIds = [...new Set(listModels().map((m) => m.provider))];
      // #309: a CLI-backed provider is keyless — "connected" means the local CLI
      // is installed AND logged in (host capability), not a vault key. Detect once.
      const cliSnap = await detectCliBackends().catch(() => undefined);
      const cliConnected = (cliId: string): boolean =>
        cliSnap?.backends.find((b) => b.id === cliId)?.loggedIn === 'yes';
      // OM-11: "is the host binary this provider needs actually present?".
      // Distinct from `connected` — a CLI that is absent can never be logged
      // into, and the UI must not offer "Anmelden" as if it could. Detection
      // failure is treated as "present" so a probe outage never disables a
      // working action.
      const cliInstalled = (cliId: string): boolean =>
        cliSnap === undefined
          ? true
          : (cliSnap.backends.find((b) => b.id === cliId)?.installed ?? false);
      const providerRows = await Promise.all(
        providerIds.map(async (id) => {
          const descriptor = deps.llmProviderCatalog?.get(id);
          // #294: an OAuth provider is "connected" when device-flow tokens are
          // stored — the login IS the credential, so there is no key to probe.
          const oauthConnect = descriptor?.oauth !== undefined;
          // #309: a CLI-backed provider is keyless — its "does it work" probe is
          // the CLI login check above, not a credential probe.
          const verification: ProviderVerification =
            id === 'claude-cli'
              ? cliConnected('claude')
                ? { status: 'verified' }
                : { status: 'no_key' }
              : oauthConnect
                ? // A dead grant (terminal refresh failure) leaves stale tokens
                  // in the vault; the process-wide latch is the truth. Report
                  // `no_key` so the row shows "Reconnect" instead of a green
                  // chip that lies while every call throws.
                  isProviderOAuthReconnectRequired(id) ||
                  !(await isProviderOAuthConnected(deps.vault, id))
                  ? { status: 'no_key' }
                  : { status: 'verified' }
                : await resolveStatus(deps.vault, id, descriptor);
          return {
          id,
          label: descriptor?.label ?? providerLabel(id),
          status: verification.status,
          ...(verification.verifiedAt !== undefined
            ? { verifiedAt: verification.verifiedAt }
            : {}),
          ...(verification.error !== undefined
            ? { verifyError: verification.error }
            : {}),
          // OM-09: the machine-readable twin of `verifyError`. Additive and
          // conditional — a verdict without a code (every non-`invalid` one)
          // leaves the field off entirely, so nothing about the existing DTO
          // shape changes for a client that does not know about it.
          ...(verification.code !== undefined
            ? { verifyErrorCode: verification.code }
            : {}),
          // #671 — why the probe could not confirm the key. A CODE, never a
          // sentence: the web-ui owns all user-facing copy.
          //
          // This is what makes the #599 403 decision legible instead of just
          // lenient. That change stopped calling every 403 a bad key, because
          // OpenAI and Anthropic also answer 403 for region and org-permission
          // blocks — only an explicit `authentication_error` marker still
          // earns `invalid`. Correct, but it left the operator with a bare
          // `UNVERIFIED` chip and no way to tell "your key is fine, your
          // region is blocked" from "the provider was down". The verdict
          // already carried `reason`; `ProviderVerificationReason`'s own
          // comment says it exists so "a future UI can map it to a localized
          // string without a second server change". This is that UI.
          ...(verification.reason !== undefined
            ? { verifyReason: verification.reason }
            : {}),
          // Retained for backwards compatibility: "a key is on file". Callers
          // that need "the key actually works" must read `status` instead.
          connected: verification.status !== 'no_key',
          // OM-11: the customer clicked "Anmelden →" on a provider whose CLI is
          // not on this server and landed on a page with no possible action.
          // The DTO carried no way to know that. Key-based providers need no
          // host binary, so they are always `true`.
          installed: id === 'claude-cli' ? cliInstalled('claude') : true,
          // Tool-less (Shape-2 CLI) providers can't drive a tool loop — the UI
          // uses this to disable them for tool-dependent plugins.
          toolLess: descriptor?.wireFormat === 'claude-cli',
          // Data-protection hints for the operator UI (data-driven, no id checks).
          // Safe defaults for an unknown provider: third-party, non-EU.
          requiresAvvDisclosure: descriptor?.policy?.requiresAvvDisclosure ?? true,
          euHosted: descriptor?.policy?.euHosted ?? false,
          // Subscription CLIs run on a PERSONAL consumer plan: no DPA/AVV can
          // exist for them, which the operator must know BEFORE routing
          // personal data through such an agent (field-test OM-10 family).
          subscriptionNotice: descriptor?.policy?.subscriptionNotice ?? false,
          // #294: the provider connects via an OAuth device flow, so the UI
          // renders a "Sign in with ChatGPT" button instead of a key field.
          oauthConnect,
          models: listModelsByProvider(id).map((m) => ({
            id: m.id,
            modelId: m.modelId,
            label: m.label,
            class: m.class,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            vision: m.vision,
          })),
          };
        }),
      );
      // OM-10b: pin the order here rather than inheriting plugin activation order.
      const providers = [...providerRows].sort(compareProviders);

      const assignments = LLM_PLUGINS.map((p) => {
        const installed = deps.installedRegistry.has(p.id);
        const cfg = (installed ? deps.installedRegistry.get(p.id)?.config : {}) ?? {};
        const modelKey = p.modelKeys[0] ?? '';
        return {
          pluginId: p.id,
          label: p.label,
          installed,
          provider: readStringConfig(cfg, 'llm_provider') ?? DEFAULT_PROVIDER,
          model: readStringConfig(cfg, modelKey) ?? null,
          modelKey,
          // This plugin drives a tool loop → the UI disables tool-less providers.
          requiresTools: p.requiresTools === true,
          // surface the orchestrator's per-turn routing flag so the page can show
          // /edit it directly (it gets force-disabled on a non-Anthropic switch).
          ...(p.id === '@omadia/orchestrator'
            ? { modelRouting: readStringConfig(cfg, 'orchestrator_model_routing') ?? 'false' }
            : {}),
        };
      });

      res.json({ providers, assignments, vault_available: deps.vault !== undefined });
    } catch (err) {
      res.status(500).json({
        code: 'providers.read_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Force a live probe of a provider's stored key and record the verdict. This
   * is the ONLY path in this router that touches the network — the operator
   * asked for it explicitly, so latency and rate limits are acceptable here in a
   * way they never are on the dashboard's read path.
   *
   * On success the verdict is also persisted to a vault sibling key so it
   * survives a restart; on rejection that record is deleted, so a revoked key
   * cannot come back as `verified` after a reboot.
   */
  router.post('/:providerId/verify', async (req: Request, res: Response) => {
    const raw = (req.params as Record<string, string | string[] | undefined>)[
      'providerId'
    ];
    const providerId = typeof raw === 'string' ? raw : '';
    const known = new Set(listModels().map((m) => m.provider));
    if (!known.has(providerId as ProviderId)) {
      res.status(404).json({
        code: 'providers.unknown_provider',
        message: `'${providerId}' is not a registered provider`,
      });
      return;
    }

    try {
      const descriptor = deps.llmProviderCatalog?.get(providerId);
      const found = await findProviderKey(deps.vault, providerId as ProviderId);
      if (found === undefined) {
        // Keyless providers verify without a credential; everything else needs
        // one before there is anything to probe.
        if (descriptor?.policy?.requiresApiKey === false) {
          res.json({ status: 'verified' } satisfies ProviderVerification);
          return;
        }
        res.json({ status: 'no_key' } satisfies ProviderVerification);
        return;
      }

      const verification = await verifyProviderCredential({
        providerId,
        apiKey: found.apiKey,
        ...(descriptor?.wireFormat !== undefined
          ? { wireFormat: descriptor.wireFormat }
          : {}),
        ...(descriptor?.baseURL !== undefined
          ? { baseURL: descriptor.baseURL }
          : {}),
        ...(descriptor?.policy?.requiresApiKey !== undefined
          ? { requiresApiKey: descriptor.policy.requiresApiKey }
          : {}),
        force: true,
      });

      // Durability. Written ONLY here and on a key save — never on a read: the
      // vault is a single encrypted blob rewritten in full on every write.
      if (deps.vault) {
        const vaultKey = providerVerifiedAtVaultKey(providerId);
        try {
          if (verification.status === 'verified') {
            await deps.vault.setMany(found.scope, {
              [vaultKey]: encodeVerifiedRecord(
                verification.verifiedAt ?? new Date().toISOString(),
                keyFingerprint(found.apiKey),
              ),
            });
          } else if (verification.status === 'invalid') {
            await deps.vault.deleteKey(found.scope, vaultKey);
          }
        } catch (err) {
          // The verdict itself is still valid and cached in memory — a vault
          // write failure must not turn a successful probe into an error.
          console.warn(
            `[adminProviders] could not persist verification for ${providerId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      res.json(verification);
    } catch (err) {
      res.status(500).json({
        code: 'providers.verify_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post('/assignment', async (req: Request, res: Response) => {
    const body = req.body as
      | { pluginId?: unknown; provider?: unknown; model?: unknown }
      | null;
    const pluginId = typeof body?.pluginId === 'string' ? body.pluginId : '';
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const model = typeof body?.model === 'string' ? body.model.trim() : '';

    const desc = LLM_PLUGINS.find((p) => p.id === pluginId);
    if (desc === undefined) {
      res.status(400).json({
        code: 'providers.unknown_plugin',
        message: `'${pluginId}' is not a selectable LLM plugin`,
      });
      return;
    }
    if (provider.length === 0 || model.length === 0) {
      res.status(400).json({
        code: 'providers.invalid_request',
        message: 'body must be { pluginId, provider, model }',
      });
      return;
    }
    if (!deps.installedRegistry.has(pluginId)) {
      res.status(404).json({
        code: 'providers.not_installed',
        message: `${pluginId} is not installed`,
      });
      return;
    }
    // Fail closed: never assign a tool-less provider (the `claude-cli` Shape-2
    // backend) to a plugin that drives a tool loop — it would silently disable
    // tools/memory/sub-agents. Tool-less plugins (extractors/classifiers) are
    // fine and are the intended target for the subscription CLI.
    const providerWire = deps.llmProviderCatalog?.get(provider)?.wireFormat;
    if (desc.requiresTools === true && providerWire === 'claude-cli') {
      res.status(400).json({
        code: 'providers.tool_incompatible',
        message: `${desc.label} needs tool support; the subscription CLI provider is tool-less. Use it only for tool-less roles (e.g. extraction/classification).`,
      });
      return;
    }
    // Resolve against the CHOSEN provider so class refs (`class:frontier`),
    // provider-qualified ids (`openai:gpt-5.5`) and legacy aliases (`opus`) all
    // disambiguate to it. Guard the classic mistake: a known model that belongs
    // to a DIFFERENT provider (e.g. claude-* assigned to openai). Unknown models
    // (custom / openai-compatible) are allowed through.
    const known = resolveModelRef(model, { defaultProvider: provider as ProviderId });
    if (known !== undefined && known.provider !== provider) {
      res.status(400).json({
        code: 'providers.model_provider_mismatch',
        message: `model '${model}' belongs to provider '${known.provider}', not '${provider}'`,
      });
      return;
    }
    // Persist the bare vendor id the adapter expects — normalise qualified ids /
    // class refs / aliases to `modelId`; pass unknown custom ids through as-is.
    const storeModel = known?.modelId ?? model;

    const entry = deps.installedRegistry.get(pluginId);
    const nextConfig: Record<string, unknown> = { ...(entry?.config ?? {}) };
    nextConfig['llm_provider'] = provider;
    for (const mk of desc.modelKeys) nextConfig[mk] = storeModel;
    if (provider !== 'anthropic' && desc.extraOnNonAnthropic !== undefined) {
      for (const [k, v] of Object.entries(desc.extraOnNonAnthropic)) {
        nextConfig[k] = v;
      }
    }

    try {
      await deps.installedRegistry.updateConfig(pluginId, nextConfig);
      if (deps.reactivate) await deps.reactivate(pluginId);
    } catch (err) {
      res.status(500).json({
        code: 'providers.apply_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    res.json({ ok: true, pluginId, provider, model: storeModel });
  });

  // -------------------------------------------------------------------------
  // #294 — "Sign in with ChatGPT" device-flow connect. The device-auth id +
  // user code (the poll secret) never leave the server; the browser only ever
  // holds a random flowId. Single-operator, single-process → an in-memory map
  // mirrors the plugin OAuth broker's pendingFlows pattern.
  // -------------------------------------------------------------------------
  interface PendingFlow {
    readonly providerId: ProviderId;
    readonly grant: UserCodeGrant;
    readonly deadlineMs: number;
  }
  const pendingFlows = new Map<string, PendingFlow>();
  const FLOW_CAP_MS = 15 * 60_000;
  const MAX_PENDING_FLOWS = 32;
  const oauthConfig = deps.oauthConfig ?? OPENAI_CODEX_OAUTH;

  /** Drop expired flows so an operator closing the modal (or StrictMode's
   *  double-mount) can't leak entries forever. */
  const sweepExpiredFlows = (): void => {
    const now = Date.now();
    for (const [id, flow] of pendingFlows) {
      if (now > flow.deadlineMs) pendingFlows.delete(id);
    }
  };

  const resolveOAuthProvider = (raw: unknown): ProviderId | undefined => {
    const id = typeof raw === 'string' && raw.length > 0 ? raw : 'openai-chatgpt';
    return deps.llmProviderCatalog?.get(id)?.oauth !== undefined
      ? (id as ProviderId)
      : undefined;
  };

  router.post('/oauth/start', async (req: Request, res: Response) => {
    const providerId = resolveOAuthProvider(
      (req.body as { provider?: unknown } | null)?.provider,
    );
    if (providerId === undefined) {
      res.status(400).json({
        code: 'providers.oauth_unsupported',
        message: 'This provider does not support OAuth device login.',
      });
      return;
    }
    sweepExpiredFlows();
    if (pendingFlows.size >= MAX_PENDING_FLOWS) {
      res.status(429).json({
        code: 'providers.oauth_too_many_flows',
        message: 'Too many login attempts in flight. Try again shortly.',
      });
      return;
    }
    try {
      const fetchImpl = deps.oauthFetch ?? fetch;
      const grant = await requestUserCode(
        (url, init) => fetchImpl(url, init),
        oauthConfig,
      );
      const flowId = randomUUID();
      pendingFlows.set(flowId, {
        providerId,
        grant,
        deadlineMs: Date.now() + FLOW_CAP_MS,
      });
      res.json({
        flowId,
        userCode: grant.userCode,
        verificationUri: grant.verificationUri,
        interval: grant.interval,
      });
    } catch (err) {
      res.status(502).json({
        code: 'providers.oauth_start_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post('/oauth/poll', async (req: Request, res: Response) => {
    const flowId = (req.body as { flowId?: unknown } | null)?.flowId;
    const flow = typeof flowId === 'string' ? pendingFlows.get(flowId) : undefined;
    if (flow === undefined) {
      res.status(404).json({ status: 'expired' });
      return;
    }
    if (Date.now() > flow.deadlineMs) {
      pendingFlows.delete(flowId as string);
      res.json({ status: 'expired' });
      return;
    }
    try {
      const fetchImpl = deps.oauthFetch ?? fetch;
      const wrapped = (url: string, init: Parameters<typeof fetchImpl>[1]) =>
        fetchImpl(url, init);
      const poll = await pollDeviceToken(wrapped, oauthConfig, flow.grant);
      if (poll.status === 'pending') {
        res.json({ status: 'pending' });
        return;
      }
      // Approved → exchange for tokens, fan out to every scope, prime the store.
      const tokens = await exchangeAuthorizationCode(
        wrapped,
        oauthConfig,
        { authorizationCode: poll.authorizationCode, codeVerifier: poll.codeVerifier },
        Date.now,
      );
      await fanOutProviderOAuthTokens(deps, flow.providerId, tokens);
      primeProviderOAuthTokens(flow.providerId, tokens);
      pendingFlows.delete(flowId as string);
      res.json({ status: 'complete' });
    } catch (err) {
      res.status(502).json({
        status: 'error',
        code: 'providers.oauth_poll_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
