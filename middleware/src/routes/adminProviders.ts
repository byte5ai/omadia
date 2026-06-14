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
 */
import {
  legacyProviderApiKeyVaultKey,
  listModels,
  listModelsByProvider,
  providerApiKeyVaultKey,
  resolveModelRef,
  type ProviderId,
} from '@omadia/llm-provider';
import { Router } from 'express';
import type { Request, Response } from 'express';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { SecretVault } from '../secrets/vault.js';

export interface AdminProvidersDeps {
  readonly installedRegistry: InstalledRegistry;
  readonly vault?: SecretVault;
  /** Tear down + re-activate a plugin so it re-reads its config. */
  readonly reactivate?: (agentId: string) => Promise<void>;
  /** Plugin-contributed providers — supplies display labels for ids that are
   *  not built in (structural to avoid a hard dep on the catalog class). */
  readonly llmProviderCatalog?: {
    get(id: string): { readonly label: string } | undefined;
  };
}

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
}

const LLM_PLUGINS: ReadonlyArray<LlmPluginDesc> = [
  {
    id: '@omadia/orchestrator',
    label: 'Orchestrator',
    modelKeys: ['orchestrator_model'],
    // Per-turn Sonnet/Opus routing only makes sense within Anthropic.
    extraOnNonAnthropic: { orchestrator_model_routing: 'false' },
  },
  {
    id: '@omadia/verifier',
    label: 'Verifier',
    modelKeys: ['verifier_model'],
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
    default:
      return id;
  }
}

async function nonEmptySecret(
  vault: SecretVault | undefined,
  scope: string,
  key: string,
): Promise<boolean> {
  if (!vault) return false;
  const v = await vault.get(scope, key);
  return typeof v === 'string' && v.trim().length > 0;
}

/** A provider is "connected" if any LLM plugin scope holds its API key
 *  (canonical, or the legacy flat key for Anthropic). */
async function isConnected(
  vault: SecretVault | undefined,
  provider: ProviderId,
): Promise<boolean> {
  const canonical = providerApiKeyVaultKey(provider);
  const legacy = legacyProviderApiKeyVaultKey(provider);
  for (const desc of LLM_PLUGINS) {
    if (await nonEmptySecret(vault, desc.id, canonical)) return true;
    if (legacy !== undefined && (await nonEmptySecret(vault, desc.id, legacy))) {
      return true;
    }
  }
  return false;
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
      const providers = await Promise.all(
        providerIds.map(async (id) => ({
          id,
          label: deps.llmProviderCatalog?.get(id)?.label ?? providerLabel(id),
          connected: await isConnected(deps.vault, id),
          models: listModelsByProvider(id).map((m) => ({
            id: m.id,
            modelId: m.modelId,
            label: m.label,
            class: m.class,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            vision: m.vision,
          })),
        })),
      );

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

  return router;
}
