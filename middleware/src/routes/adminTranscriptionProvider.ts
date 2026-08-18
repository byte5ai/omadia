/**
 * `/api/v1/admin/transcription-provider` — the backend for the transcription
 * provider admin page (#584). The transcription twin of
 * `adminProviders.ts` (key verdict + verify probe) and
 * `adminEmbeddingProvider.ts` (single-active-capability selection):
 * `transcription@1` is served by exactly one active provider plugin
 * (`ServiceRegistry.provide` throws on a duplicate), so selection means
 * activating the chosen adapter plugin and deactivating the previous one.
 *
 * GET  /                → providers from the transcription catalog with the
 *                         4-state credential verdict, policy flags (AVV/EU
 *                         banner) and models, plus the active provider id.
 * POST /:id/verify      → probe the stored key and record the verdict. The
 *                         ONLY path in this router that touches the network.
 * POST /:id/key         → store/remove the provider's API key in the ADAPTER
 *                         PLUGIN's own vault scope under `api_key` (the
 *                         embedding-adapter precedent — the adapter reads it
 *                         at activate), drop the old verdict, reactivate.
 * POST /select          → switch the active provider plugin (with rollback).
 *
 * HARD CONTRACT (inherited from adminProviders): the GET handler NEVER makes
 * a network call — it serves the cached verdict, the durable record, or
 * `unverified`.
 *
 * Verification reuses `providerCredentialVerifier` UNCHANGED: every v1
 * transcription provider is OpenAI-wire, so the cheapest authenticated call
 * is the existing `GET {base}/models` Bearer probe. No new probe shape means
 * the desktop pre-boot twin (`desktop/src/ipc.ts`) needs no change either.
 * Cache + durable-record ids are namespaced `transcription:<providerId>` so
 * a same-named LLM provider (e.g. `openai`) can never cross-talk verdicts.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { SecretVault } from '../secrets/vault.js';
import type { TranscriptionProviderCatalogEntry } from '../platform/transcriptionProviderCatalog.js';
import {
  invalidate,
  probeAndPersistVerification,
  providerVerifiedAtVaultKey,
  resolveStoredVerification,
  type ProviderVerification,
} from '../platform/providerCredentialVerifier.js';

/** Vault key holding the adapter's API key IN ITS OWN plugin scope (manifest
 *  `setup.fields` secret — see `transcription-adapter-openai/manifest.yaml`). */
const ADAPTER_API_KEY = 'api_key';

export interface AdminTranscriptionProviderDeps {
  readonly installedRegistry: InstalledRegistry;
  readonly vault?: SecretVault;
  /** Providers contributed by installed plugins' `transcription_provider`
   *  manifest blocks (structural, to avoid a hard dep on the catalog class). */
  readonly catalog: {
    get(id: string): TranscriptionProviderCatalogEntry | undefined;
    list(): ReadonlyArray<TranscriptionProviderCatalogEntry>;
  };
  /** Tear down + re-activate a plugin so it re-reads its key/config. */
  readonly reactivate?: (pluginId: string) => Promise<void>;
  /** Selection seam (the embedding-provider precedent): activate/deactivate
   *  the adapter plugin itself — `provide()` throwing on duplicates is what
   *  makes "exactly one active transcription provider" structural. REQUIRED
   *  (like the embedding router's): an optional activate would let /select
   *  flip a registry status without actually activating anything. */
  readonly activate: (pluginId: string) => Promise<unknown>;
  readonly deactivate: (pluginId: string) => Promise<unknown>;
}

/** Cache + durable-record id. NEVER the bare provider id: the verifier's
 *  module-level cache is shared with the LLM seam, and `openai` exists there
 *  too. */
function verificationId(providerId: string): string {
  return `transcription:${providerId}`;
}

/**
 * The provider's credential verdict WITHOUT touching the network — the
 * `resolveStatus` twin of adminProviders, reading the key from the adapter
 * plugin's own vault scope:
 *   - keyless provider (policy)                    → `verified`
 *   - no key in the adapter scope                  → `no_key`
 *   - a fresh cached probe for THIS key            → that verdict
 *   - a durable `verified_at` record for THIS key  → `verified`
 *   - otherwise                                    → `unverified`
 */
async function resolveStatus(
  vault: SecretVault | undefined,
  entry: TranscriptionProviderCatalogEntry,
): Promise<ProviderVerification> {
  if (entry.descriptor.policy?.requiresApiKey === false) {
    return { status: 'verified' };
  }
  const apiKey = (await vault?.get(entry.pluginId, ADAPTER_API_KEY))?.trim();
  if (apiKey === undefined || apiKey.length === 0) return { status: 'no_key' };

  return resolveStoredVerification({
    vault,
    scope: entry.pluginId,
    verificationId: verificationId(entry.descriptor.id),
    apiKey,
  });
}

/** Stable ordering, copied from adminProviders (OM-10b): usable providers
 *  first, then label, then id. Deliberately NOT `localeCompare` (hydration —
 *  see `web-ui/app/_components/Nav.tsx`). */
function compareProviders(
  a: { connected: boolean; label: string; id: string },
  b: { connected: boolean; label: string; id: string },
): number {
  if (a.connected !== b.connected) return a.connected ? -1 : 1;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function createAdminTranscriptionProviderRouter(
  deps: AdminTranscriptionProviderDeps,
): Router {
  const router = Router();

  const isActive = (entry: TranscriptionProviderCatalogEntry): boolean =>
    deps.installedRegistry.get(entry.pluginId)?.status === 'active';

  const activeEntry = (): TranscriptionProviderCatalogEntry | undefined =>
    deps.catalog.list().find(isActive);

  // One switch at a time — a second concurrent switch would interleave
  // activate/deactivate and could leave zero or two providers active.
  let switchInFlight = false;

  router.get('/', async (_req: Request, res: Response) => {
    // Async-handler rejections do not reach error middleware — an uncaught
    // vault/read failure would hang the request. Catch → 500.
    try {
      const rows = await Promise.all(
        deps.catalog.list().map(async (entry) => {
          const { descriptor } = entry;
          const verification = await resolveStatus(deps.vault, entry);
          return {
            id: descriptor.id,
            label: descriptor.label,
            pluginId: entry.pluginId,
            active: isActive(entry),
            status: verification.status,
            ...(verification.verifiedAt !== undefined
              ? { verifiedAt: verification.verifiedAt }
              : {}),
            ...(verification.error !== undefined
              ? { verifyError: verification.error }
              : {}),
            ...(verification.code !== undefined
              ? { verifyErrorCode: verification.code }
              : {}),
            ...(verification.reason !== undefined
              ? { verifyReason: verification.reason }
              : {}),
            // Retained with the adminProviders meaning: "a key is on file".
            connected: verification.status !== 'no_key',
            // Data-protection hints for the AVV/EU banner. Safe defaults for
            // an unknown provider: third-party, non-EU.
            requiresAvvDisclosure:
              descriptor.policy?.requiresAvvDisclosure ?? true,
            euHosted: descriptor.policy?.euHosted ?? false,
            models: descriptor.models.map((m) => ({
              id: m.id,
              modelId: m.modelId,
              label: m.label,
              surfaces: [...m.surfaces],
            })),
          };
        }),
      );
      const providers = [...rows].sort(compareProviders);
      res.json({
        providers,
        active: activeEntry()?.descriptor.id ?? null,
        vault_available: deps.vault !== undefined,
      });
    } catch (err) {
      res.status(500).json({
        code: 'transcriptionProvider.read_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Force a live probe of the provider's stored key and record the verdict —
   * the operator asked for it explicitly, so latency and rate limits are
   * acceptable here in a way they never are on the dashboard's read path.
   * On success the verdict is persisted to a vault sibling key so it survives
   * a restart; on rejection that record is deleted, so a revoked key cannot
   * come back as `verified` after a reboot.
   */
  router.post('/:providerId/verify', async (req: Request, res: Response) => {
    const raw = (req.params as Record<string, string | string[] | undefined>)[
      'providerId'
    ];
    const providerId = typeof raw === 'string' ? raw : '';
    const entry = deps.catalog.get(providerId);
    if (entry === undefined) {
      res.status(404).json({
        code: 'transcriptionProvider.unknown_provider',
        message: `'${providerId}' is not a registered transcription provider`,
      });
      return;
    }

    try {
      const apiKey = (
        await deps.vault?.get(entry.pluginId, ADAPTER_API_KEY)
      )?.trim();
      if (apiKey === undefined || apiKey.length === 0) {
        // Keyless providers verify without a credential; everything else
        // needs one before there is anything to probe.
        if (entry.descriptor.policy?.requiresApiKey === false) {
          res.json({ status: 'verified' } satisfies ProviderVerification);
          return;
        }
        res.json({ status: 'no_key' } satisfies ProviderVerification);
        return;
      }

      // Probe + durable record in one shared step (also used by the LLM
      // twin) — see `probeAndPersistVerification` for the durability contract.
      const verification = await probeAndPersistVerification({
        vault: deps.vault,
        scope: entry.pluginId,
        verificationId: verificationId(providerId),
        apiKey,
        probe: {
          // Every v1 transcription provider speaks the OpenAI wire, so the
          // cheapest authenticated call is `GET {base}/models` with a Bearer
          // header. When a non-OpenAI-wire provider arrives, the manifest
          // block grows a `wire_format` field — until then a constant is
          // honest, not a shortcut.
          wireFormat: 'openai',
          baseURL: entry.descriptor.baseURL,
          ...(entry.descriptor.policy?.requiresApiKey !== undefined
            ? { requiresApiKey: entry.descriptor.policy.requiresApiKey }
            : {}),
        },
      });

      res.json(verification);
    } catch (err) {
      res.status(500).json({
        code: 'transcriptionProvider.verify_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Store (string) or remove (null / empty) the provider's API key. Writes to
   * the ADAPTER PLUGIN's own vault scope — the same `api_key` the adapter
   * reads at activate — then drops every cached/durable verdict for the
   * provider and reactivates the plugin so the capability (un)publishes
   * immediately instead of on the next boot.
   */
  // POST (not PUT) for parity with the web-ui's single JSON transport helper.
  router.post('/:providerId/key', async (req: Request, res: Response) => {
    const raw = (req.params as Record<string, string | string[] | undefined>)[
      'providerId'
    ];
    const providerId = typeof raw === 'string' ? raw : '';
    const entry = deps.catalog.get(providerId);
    if (entry === undefined) {
      res.status(404).json({
        code: 'transcriptionProvider.unknown_provider',
        message: `'${providerId}' is not a registered transcription provider`,
      });
      return;
    }
    const body = req.body as { apiKey?: unknown } | null;
    const apiKeyRaw = body?.apiKey;
    if (apiKeyRaw !== null && typeof apiKeyRaw !== 'string') {
      res.status(400).json({
        code: 'transcriptionProvider.invalid_request',
        message: 'body must be { apiKey: string | null }',
      });
      return;
    }
    const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw.trim() : '';

    try {
      if (deps.vault === undefined) {
        throw new Error('secret vault unavailable');
      }
      const id = verificationId(providerId);
      if (apiKey.length > 0) {
        await deps.vault.setMany(entry.pluginId, { [ADAPTER_API_KEY]: apiKey });
      } else {
        await deps.vault.deleteKey(entry.pluginId, ADAPTER_API_KEY);
      }
      // The old verdict belongs to the old key: drop the in-memory cache for
      // EVERY fingerprint and the durable record, so nothing stale survives —
      // not even across a restart.
      invalidate(id);
      await deps.vault.deleteKey(entry.pluginId, providerVerifiedAtVaultKey(id));
      if (deps.reactivate) await deps.reactivate(entry.pluginId);
    } catch (err) {
      res.status(500).json({
        code: 'transcriptionProvider.key_write_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    res.json({ ok: true, providerId, hasKey: apiKey.length > 0 });
  });

  /**
   * Switch the active transcription provider: deactivate the previous
   * adapter plugin, activate the target, persist both statuses. On a failed
   * activate the previous provider is restored — the platform must never end
   * up with zero transcription providers because a switch went wrong.
   */
  router.post('/select', async (req: Request, res: Response) => {
    const body = req.body as { providerId?: unknown } | null;
    const providerId =
      typeof body?.providerId === 'string' ? body.providerId.trim() : '';
    if (providerId.length === 0) {
      res.status(400).json({
        code: 'transcriptionProvider.invalid_request',
        message: 'body must be { providerId }',
      });
      return;
    }
    const entry = deps.catalog.get(providerId);
    if (entry === undefined) {
      res.status(404).json({
        code: 'transcriptionProvider.unknown_provider',
        message: `'${providerId}' is not a registered transcription provider`,
      });
      return;
    }
    if (!deps.installedRegistry.has(entry.pluginId)) {
      res.status(404).json({
        code: 'transcriptionProvider.not_installed',
        message: `${entry.pluginId} is not installed`,
      });
      return;
    }
    const previous = activeEntry();
    if (previous?.descriptor.id === providerId) {
      res.status(409).json({
        code: 'transcriptionProvider.already_active',
        message: `'${providerId}' is already the active transcription provider`,
      });
      return;
    }
    if (switchInFlight) {
      res.status(409).json({
        code: 'transcriptionProvider.switch_in_progress',
        message: 'another provider switch is still running',
      });
      return;
    }
    switchInFlight = true;
    try {
      const setStatus = async (
        pluginId: string,
        status: 'active' | 'inactive',
      ): Promise<void> => {
        const reg = deps.installedRegistry.get(pluginId);
        if (reg !== undefined) {
          await deps.installedRegistry.register({ ...reg, status });
        }
      };

      if (previous !== undefined) {
        await deps.deactivate(previous.pluginId);
        await setStatus(previous.pluginId, 'inactive');
      }
      try {
        await deps.activate(entry.pluginId);
        await setStatus(entry.pluginId, 'active');
      } catch (err) {
        // Roll back: restore the previous provider so the capability does not
        // silently vanish. A rollback failure is logged, not masked — the
        // response already reports the switch as failed.
        //
        // Deliberate difference from the embedding router, which VERIFIES the
        // restore by re-evaluating its gate: transcription has no gate — a
        // non-throwing `activate()` IS the only success signal there is, so
        // there is nothing further to verify against.
        if (previous !== undefined) {
          try {
            await deps.activate(previous.pluginId);
            await setStatus(previous.pluginId, 'active');
          } catch (rollbackErr) {
            console.warn(
              `[adminTranscriptionProvider] rollback to '${previous.descriptor.id}' failed:`,
              rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
            );
          }
        }
        res.status(500).json({
          code: 'transcriptionProvider.switch_failed',
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      res.json({ ok: true, active: providerId });
    } finally {
      switchInFlight = false;
    }
  });

  return router;
}
