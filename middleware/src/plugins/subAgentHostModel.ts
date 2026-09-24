/**
 * Provider + model selection for a dynamic (uploaded / built-in package)
 * sub-agent — extracted from `DynamicAgentRuntime.activate` so the exact code
 * that runs in production is unit-testable without a package on disk (#1079).
 */
import {
  createAnthropicProvider,
  type AnthropicClient,
} from '@omadia/llm-adapter-anthropic';
import {
  resolveLlmProvider,
  resolveModelRefStrict,
  UnresolvedModelRefError,
  type LlmProvider,
  type LlmProviderPool,
} from '@omadia/llm-provider';

import { builtinClassDefault } from '../platform/builtinLlmProviders.js';
import type { ServiceRegistry } from '../platform/serviceRegistry.js';

export interface SubAgentHostDeps {
  /** The boot-time Anthropic client (env key); fallback when no vault-armed
   *  shared client is registered. */
  readonly anthropic: AnthropicClient;
  readonly serviceRegistry: Pick<ServiceRegistry, 'get'>;
  readonly hostProviderId?: () => string;
  readonly hostGetSecret?: (key: string) => Promise<string | undefined>;
  readonly providerPool?: Pick<LlmProviderPool, 'get'>;
}

export interface SubAgentHostRequest {
  readonly agentId: string;
  /** The configured model ref — `SUB_AGENT_MODEL` or the manifest's
   *  `llm.prefers.model` — possibly a class ref such as `class:frontier`. */
  readonly effectiveModel: string;
  /** Where `effectiveModel` came from; named in the error when it cannot be
   *  resolved. */
  readonly modelSource: 'SUB_AGENT_MODEL' | 'manifest';
}

export interface SubAgentHost {
  readonly providerId: string;
  readonly provider: LlmProvider;
  /** A concrete model id for `provider` — never a class ref. */
  readonly model: string;
}

export async function selectSubAgentHost(
  deps: SubAgentHostDeps,
  req: SubAgentHostRequest,
): Promise<SubAgentHost> {
  const { agentId } = req;
  // OB-61 follow-up: the host arms the shared Anthropic client from the
  // operator's vault key AFTER boot (see index.ts
  // `refreshSharedAnthropicClientFromVault` →
  // `serviceRegistry.replace('anthropicClient', …)`). The constructor-
  // injected `deps.anthropic` is the *boot-time* client, built from
  // `config.ANTHROPIC_API_KEY ?? ''`. On deployments where the key lives
  // only in the vault (operator completed /setup, no ANTHROPIC_API_KEY in
  // ENV — e.g. the Docker demo), that injected client has an empty apiKey
  // and every sub-agent inner call throws "Could not resolve authentication
  // method" at construction time (0 ms, before any tool runs). Late-resolve
  // the live, vault-armed client from the registry — matching the documented
  // late-resolve contract (index.ts ~295) — and fall back to the injected
  // client only when no provider override is registered (env-key path).
  // Provider-agnostic sub-agents: run on the host's configured provider
  // (default Anthropic). For Anthropic we keep the live, vault-armed shared
  // client (the OB-61 late-resolve). For any other provider we build it from
  // the host vault key via the factory. The model ref is resolved AFTER the
  // branch, identically for every provider (#1079).
  const liveAnthropicProvider = (): LlmProvider =>
    createAnthropicProvider({
      client:
        deps.serviceRegistry.get<AnthropicClient>('anthropicClient') ??
        deps.anthropic,
    });
  const hostProviderId = deps.hostProviderId?.() ?? 'anthropic';
  let provider: LlmProvider;
  if (hostProviderId === 'anthropic') {
    provider = liveAnthropicProvider();
  } else {
    // #1033 W1 — through the kernel's provider pool when one is wired
    // (memoised per provider id; a key change is picked up on invalidate),
    // else a one-off resolve as before.
    const resolved = deps.providerPool
      ? await deps.providerPool.get(hostProviderId)
      : deps.hostGetSecret
        ? await resolveLlmProvider({
            providerId: hostProviderId,
            getSecret: deps.hostGetSecret,
          })
        : undefined;
    if (resolved === undefined) {
      // #1033 W1 — no key for the configured non-Anthropic provider. This
      // used to fall back to the shared Anthropic client SILENTLY, so a
      // sub-agent on a host configured for, say, Mistral would quietly run
      // on Anthropic (or throw an unrelated auth error at first call).
      // Refusing to build it names the actual problem at the point where an
      // operator can fix it.
      throw new Error(
        `dynamic agent '${agentId}': the host LLM provider '${hostProviderId}' has no API key configured — add the key under Providers or switch the orchestrator's llm_provider`,
      );
    }
    provider = resolved;
  }
  return {
    providerId: hostProviderId,
    provider,
    model: resolveSubAgentModel(req, hostProviderId),
  };
}

/**
 * #1079 — resolve the configured ref on EVERY provider branch through the
 * orchestrator's resolver. The Anthropic branch used to hand the raw string to
 * the sub-agent, so the default `SUB_AGENT_MODEL=class:frontier` reached
 * api.anthropic.com verbatim and 404'd on every call. A class ref the registry
 * cannot serve falls back to the bundled provider's pinned seed; with no seed
 * either, activation fails naming the setting to fix. Concrete ids keep the
 * previous behaviour (same-class remap across providers, custom ids pass).
 */
function resolveSubAgentModel(
  req: SubAgentHostRequest,
  providerId: string,
): string {
  const configKey =
    req.modelSource === 'manifest'
      ? `llm.prefers.model in the manifest of '${req.agentId}'`
      : 'SUB_AGENT_MODEL';
  try {
    return resolveModelRefStrict(req.effectiveModel, providerId, {
      configKey,
      pinnedClassDefault: builtinClassDefault,
    });
  } catch (err) {
    if (err instanceof UnresolvedModelRefError) {
      throw new Error(`dynamic agent '${req.agentId}': ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }
}
