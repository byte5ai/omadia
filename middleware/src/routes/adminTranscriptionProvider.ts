import { TRANSCRIPTION_CAPABILITY, parseCapabilityRef } from '@omadia/plugin-api';
import type { CapabilityRef, TranscriptionService } from '@omadia/plugin-api';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';

/**
 * `/api/v1/admin/transcription-provider` — operator surface for the
 * `transcription@1` capability (#584 WS T).
 *
 * The lean sibling of `adminEmbeddingProvider.ts`: same admin-router family
 * (cookie-session `requireAuth`, NOT the machine `ADMIN_TOKEN` surface), same
 * switch mechanics (deactivate current → activate target → VERIFY the
 * capability is actually published → verified rollback otherwise, all
 * serialised under `switchInFlight`) — but with none of the corpus/gate
 * machinery: a transcription-provider switch destroys nothing, so there is no
 * confirm-the-discard step and no re-gate.
 *
 * This page is also the CONSENT surface #584 demands: it names, in front of
 * the switch, that an active provider sends raw audio to the configured
 * external endpoint. The i18n strings live in the web-ui panel; this router
 * only reports state.
 */

const SwitchBodySchema = z.object({
  pluginId: z.string().min(1),
});

/** Structural view of `PluginCatalog` — only what this router reads, so tests
 *  can pass a stub instead of loading manifests off disk. */
export interface TranscriptionProviderCatalog {
  list(): ReadonlyArray<{
    plugin: { id: string; name: string; provides: readonly string[] };
  }>;
  get(id: string): { plugin: { id: string; name: string } } | undefined;
}

export interface AdminTranscriptionProviderDeps {
  readonly installedRegistry: InstalledRegistry;
  readonly catalog: TranscriptionProviderCatalog;
  /** Live `transcription@1` service, resolved per request. */
  readonly getTranscription: () => TranscriptionService | undefined;
  /** Runtime activation of a tool/extension plugin (ToolPluginRuntime). */
  readonly activate: (pluginId: string) => Promise<void>;
  readonly deactivate: (pluginId: string) => Promise<boolean>;
}

/** Installed plugins whose manifest publishes `transcription@1`. */
function installedProviderIds(deps: AdminTranscriptionProviderDeps): string[] {
  const wanted = parseCapabilityRef(TRANSCRIPTION_CAPABILITY);
  const out: string[] = [];
  for (const entry of deps.catalog.list()) {
    if (!deps.installedRegistry.has(entry.plugin.id)) continue;
    const publishes = entry.plugin.provides.some((rawProv) => {
      const ref = tryParseCapability(rawProv);
      return ref !== undefined && ref.name === wanted.name && ref.major === wanted.major;
    });
    if (publishes) out.push(entry.plugin.id);
  }
  return out.sort();
}

/** A malformed `provides:` entry is a manifest bug, not a reason to hide every
 *  other provider — the catalog loader already warns about it. */
function tryParseCapability(raw: string): CapabilityRef | undefined {
  try {
    return parseCapabilityRef(raw);
  } catch {
    return undefined;
  }
}

/** The provider the registry says is live. Exactly one may be active — a
 *  second `ctx.services.provide('transcription', …)` throws. */
function activeProviderId(
  deps: AdminTranscriptionProviderDeps,
  providerIds: readonly string[],
): string | null {
  for (const id of providerIds) {
    if (deps.installedRegistry.get(id)?.status === 'active') return id;
  }
  return null;
}

/** Flip the registry entry's status without touching its config or secrets. */
async function setStatus(
  registry: InstalledRegistry,
  pluginId: string,
  status: 'active' | 'inactive',
): Promise<void> {
  const entry = registry.get(pluginId);
  if (!entry) return;
  await registry.register({ ...entry, status });
}

/**
 * Raised when the target could not take over. `restoredProviderId` is the
 * provider that is VERIFIED live again — `null` when nothing was restored, so
 * the response can never claim a rollback that did not happen.
 */
class SwitchRolledBack extends Error {
  constructor(
    message: string,
    readonly restoredProviderId: string | null,
  ) {
    super(message);
  }
}

export function createAdminTranscriptionProviderRouter(
  deps: AdminTranscriptionProviderDeps,
): Router {
  const router = Router();
  // Serialises `POST /switch` — two interleaved switches once corrupted the
  // embeddings registry into a two-actives boot crash; same guard here.
  let switchInFlight = false;

  function snapshot(): Record<string, unknown> {
    const providerIds = installedProviderIds(deps);
    const activeId = activeProviderId(deps, providerIds);
    const live = deps.getTranscription();
    return {
      providers: providerIds.map((id) => ({
        pluginId: id,
        label: deps.catalog.get(id)?.plugin.name ?? id,
        active: id === activeId,
        registryStatus: deps.installedRegistry.get(id)?.status ?? null,
      })),
      activeProviderId: activeId,
      capabilityPublished: live !== undefined,
      // Provider self-description, e.g. `openai:gpt-transcribe`. `null` while
      // no service is published (missing API key, no active provider).
      activeProvider: live?.providerId ?? null,
    };
  }

  router.get('/', (_req: Request, res: Response) => {
    try {
      res.json(snapshot());
    } catch (err) {
      res.status(500).json({
        code: 'transcriptionProvider.read_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post('/switch', async (req: Request, res: Response) => {
    const parsed = SwitchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'transcriptionProvider.invalid_request',
        message: 'body must be { pluginId }',
        details: parsed.error.issues,
      });
      return;
    }
    if (switchInFlight) {
      res.status(409).json({
        code: 'transcriptionProvider.switch_in_progress',
        message:
          'another transcription-provider switch is still running; wait for it to finish and re-read the current state before retrying',
      });
      return;
    }
    switchInFlight = true;
    try {
      await handleSwitch(parsed.data.pluginId, res);
    } finally {
      switchInFlight = false;
    }
  });

  async function handleSwitch(pluginId: string, res: Response): Promise<void> {
    // Never activate an arbitrary caller-supplied plugin id: the target must
    // be installed AND actually declare `transcription@1`.
    const providerIds = installedProviderIds(deps);
    if (!providerIds.includes(pluginId)) {
      res.status(400).json({
        code: 'transcriptionProvider.unknown_target',
        message: `'${pluginId}' is not an installed transcription@1 provider`,
      });
      return;
    }
    const previousId = activeProviderId(deps, providerIds);
    if (previousId === pluginId) {
      res.status(409).json({
        code: 'transcriptionProvider.already_active',
        message: `'${pluginId}' is already the active transcription provider`,
      });
      return;
    }

    try {
      await applySwitch(deps, previousId, pluginId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(err instanceof SwitchRolledBack ? 409 : 500).json({
        code:
          err instanceof SwitchRolledBack
            ? 'transcriptionProvider.target_unavailable'
            : 'transcriptionProvider.switch_failed',
        message,
        details:
          err instanceof SwitchRolledBack ? { restoredProviderId: err.restoredProviderId } : {},
      });
      return;
    }

    res.json({ ok: true, switchedTo: pluginId, ...snapshot() });
  }

  async function applySwitch(
    d: AdminTranscriptionProviderDeps,
    previousId: string | null,
    targetId: string,
  ): Promise<void> {
    if (previousId !== null) {
      await d.deactivate(previousId);
      await setStatus(d.installedRegistry, previousId, 'inactive');
    }

    // Put the world back. Returns the provider id that is VERIFIED live
    // again (post-condition: `getTranscription()`), or `null`.
    const restorePrevious = async (): Promise<string | null> => {
      await d.deactivate(targetId).catch(() => false);
      await setStatus(d.installedRegistry, targetId, 'inactive');
      if (previousId === null) return null;
      await setStatus(d.installedRegistry, previousId, 'active');
      await d.activate(previousId).catch(() => undefined);
      if (d.getTranscription() === undefined) {
        await setStatus(d.installedRegistry, previousId, 'inactive');
        return null;
      }
      return previousId;
    };

    await setStatus(d.installedRegistry, targetId, 'active');
    try {
      await d.activate(targetId);
    } catch (err) {
      const restored = await restorePrevious();
      throw new SwitchRolledBack(
        `activating '${targetId}' failed (${err instanceof Error ? err.message : String(err)}) — ${describeRestore(restored)}`,
        restored,
      );
    }

    // An adapter that activates without publishing anything (no API key in
    // the vault) leaves the deployment with NO transcription provider —
    // strictly worse than not switching. Treat it as a failure.
    if (d.getTranscription() === undefined) {
      const restored = await restorePrevious();
      throw new SwitchRolledBack(
        `'${targetId}' activated but published no transcription@1 — it is not configured (missing API key); ${describeRestore(restored)}`,
        restored,
      );
    }
  }

  return router;
}

/** Wording for a rollback that may or may not have taken. */
function describeRestore(restored: string | null): string {
  return restored === null
    ? 'AND THE PREVIOUS PROVIDER COULD NOT BE RESTORED — there is no live transcription@1 right now; configure one and activate it'
    : `the previous provider ('${restored}') was restored and verified live`;
}
