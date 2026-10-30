/**
 * Field classification (#1556 follow-up) — the admin API. Mounted behind
 * `requireAuth` at `/api/v1/admin/privacy/field-classification` by `index.ts`.
 *
 * GET  /?status=&tool=   candidates with their status shown NOW (the current
 *                        `non_personal_fields` value and the admin decisions
 *                        laid over the last recompute), counts per status,
 *                        how many changed since this admin's last visit
 * POST /:id/decision     confirm | reject | keep_masked | revert
 * GET  /:id/preview      shape-masked sample strings (no letter or digit)
 * POST /recompute        run a recompute pass now
 *
 * Only `confirm` and `revert` write config: they append / remove exactly one
 * `tool:field` line of the privacy guard's `non_personal_fields`, through the
 * installed-registry update the `PATCH /admin/runtime/installed/:id/config`
 * route uses, serialized per plugin. Every decision writes an audit row
 * (`privacy.field_classification`). No response carries a field value.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  PRIVACY_REDACT_SERVICE_NAME,
  type PrivacyGuardService,
} from '@omadia/plugin-api';

import { auditActorFromRequest, type AdminAuditLog } from '../../auth/adminAuditLog.js';
import type { InstalledRegistry } from '../../plugins/installedRegistry.js';
import type { PluginCatalog } from '../../plugins/manifestLoader.js';
import {
  DECISION_ACTIONS,
  FIELD_STATUSES,
  appendConfigEntry,
  classifyBase,
  configCoverage,
  configEntryOf,
  removeConfigEntry,
  resolveStatus,
  type DecisionAction,
  type FieldReason,
  type FieldStatus,
  type ModelVerdictSummary,
} from './engine.js';
import {
  NON_PERSONAL_FIELDS_KEY,
  privacyGuardInstalledId,
  readNonPersonalFieldsConfig,
} from './guardConfig.js';
import { PREVIEW_LIMIT, type RecomputeResult } from './recompute.js';
import type { CandidateDecision, FieldCandidate, FieldClassificationStore } from './store.js';

export const FIELD_CLASSIFICATION_AUDIT_ACTION = 'privacy.field_classification';
/** How long `POST /recompute` waits for the pass before answering. */
const RECOMPUTE_WAIT_MS = 20_000;

export interface FieldClassificationRouteDeps {
  readonly store: FieldClassificationStore;
  readonly installedRegistry: Pick<InstalledRegistry, 'list' | 'get' | 'updateConfig'>;
  readonly catalog?: Pick<PluginCatalog, 'get'>;
  readonly serviceRegistry: { get<T>(name: string): T | undefined };
  readonly audit?: Pick<AdminAuditLog, 'record'>;
  readonly recompute: () => Promise<RecomputeResult | undefined>;
  readonly now?: () => Date;
}

const listQuerySchema = z.object({
  status: z.enum(FIELD_STATUSES).optional(),
  tool: z.string().min(1).max(200).optional(),
});

const decisionSchema = z.object({
  action: z.enum(DECISION_ACTIONS),
  fingerprint: z.string().min(1).max(200),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which action an admin may take on a field in which shown status. */
const ALLOWED_ACTIONS: Readonly<Record<FieldStatus, readonly DecisionAction[]>> = {
  suggested: ['confirm', 'reject', 'keep_masked'],
  needs_clarification: ['confirm', 'reject', 'keep_masked'],
  personal: ['keep_masked'],
  confirmed: ['revert'],
  rejected: ['revert'],
  kept_masked: ['revert'],
};

export interface FieldClassificationItem {
  readonly id: string;
  readonly toolName: string;
  readonly fieldPath: string;
  readonly valueShape: string;
  readonly sourceModels: readonly string[];
  readonly relationModels: readonly string[];
  readonly status: FieldStatus;
  readonly reasons: readonly FieldReason[];
  readonly configEntry: string;
  readonly fingerprint: string;
  readonly decision: { action: DecisionAction; by: string | null; at: string } | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly seenCount: number;
}

/** Cached schema verdicts for every relation target of `candidates`. */
async function cachedVerdicts(
  store: FieldClassificationStore,
  candidates: readonly FieldCandidate[],
): Promise<Map<string, ModelVerdictSummary>> {
  const models = [...new Set(candidates.flatMap((c) => c.relationModels))];
  const rows = await store.modelVerdicts(models, new Date(0));
  return new Map(rows.map((r) => [r.model, { verdict: r.verdict, confidence: r.confidence }]));
}

/** The status of a stored candidate under the CURRENT config and decision. */
export function liveStatus(
  candidate: FieldCandidate,
  rawConfig: string | undefined,
  verdicts: ReadonlyMap<string, ModelVerdictSummary>,
  decision: CandidateDecision | null = candidate.decision,
): { status: FieldStatus; reasons: readonly FieldReason[] } {
  const base = classifyBase({
    toolName: candidate.toolName,
    fieldPath: candidate.fieldPath,
    valueShape: candidate.valueShape,
    sourceModels: candidate.sourceModels,
    relationModels: candidate.relationModels,
    ...(candidate.sampleVerdict !== null ? { sample: candidate.sampleVerdict } : {}),
    modelVerdicts: verdicts,
  });
  return resolveStatus(
    base,
    candidate.fingerprint,
    configCoverage(rawConfig, candidate.toolName, candidate.fieldPath),
    decision,
  );
}

function toItem(
  candidate: FieldCandidate,
  shown: { status: FieldStatus; reasons: readonly FieldReason[] },
): FieldClassificationItem {
  return {
    id: candidate.id,
    toolName: candidate.toolName,
    fieldPath: candidate.fieldPath,
    valueShape: candidate.valueShape,
    sourceModels: candidate.sourceModels,
    relationModels: candidate.relationModels,
    status: shown.status,
    reasons: shown.reasons,
    configEntry: configEntryOf(candidate.toolName, candidate.fieldPath),
    fingerprint: candidate.fingerprint,
    decision:
      candidate.decision !== null
        ? {
            action: candidate.decision.action,
            by: candidate.decision.byEmail ?? candidate.decision.byId,
            at: candidate.decision.at,
          }
        : null,
    firstSeenAt: candidate.firstSeenAt,
    lastSeenAt: candidate.lastSeenAt,
    seenCount: candidate.seenCount,
  };
}

function emptyCounts(): Record<FieldStatus, number> {
  return Object.fromEntries(FIELD_STATUSES.map((s) => [s, 0])) as Record<FieldStatus, number>;
}

function visitorKey(req: Request): string {
  const actor = auditActorFromRequest(req);
  return actor.id ?? actor.email ?? req.session?.sub ?? 'admin';
}

/** Serializes the config read-modify-write per plugin id. */
function createKeyedMutex(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

class DecisionConflict extends Error {
  constructor(readonly body: Record<string, unknown>) {
    super(String(body['error']));
  }
}

export function createFieldClassificationRoutes(deps: FieldClassificationRouteDeps): Router {
  const router = Router();
  const withPluginLock = createKeyedMutex();
  const now = deps.now ?? (() => new Date());
  const rawConfig = (): string | undefined =>
    readNonPersonalFieldsConfig(deps.installedRegistry, deps.catalog);

  router.get('/', async (req: Request, res: Response) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', detail: parsed.error.issues });
      return;
    }
    try {
      const candidates = await deps.store.list(
        parsed.data.tool !== undefined ? { toolName: parsed.data.tool } : {},
      );
      const verdicts = await cachedVerdicts(deps.store, candidates);
      const config = rawConfig();
      const actor = visitorKey(req);
      const lastVisit = await deps.store.lastVisit(actor);
      const counts = emptyCounts();
      let newSinceLastVisit = 0;
      const items: FieldClassificationItem[] = [];
      for (const candidate of candidates) {
        const shown = liveStatus(candidate, config, verdicts);
        counts[shown.status] += 1;
        const open = shown.status === 'suggested' || shown.status === 'needs_clarification';
        if (open && (lastVisit === null || candidate.lastStatusChangeAt > lastVisit)) {
          newSinceLastVisit += 1;
        }
        if (parsed.data.status === undefined || parsed.data.status === shown.status) {
          items.push(toItem(candidate, shown));
        }
      }
      await deps.store.markVisit(actor, now());
      res.json({
        items,
        counts,
        newSinceLastVisit,
        computedAt: await deps.store.lastComputedAt(),
      });
    } catch (err) {
      console.error('[privacy-fields] list failed:', err);
      res.status(500).json({ error: 'field_classification_query_failed' });
    }
  });

  router.post('/recompute', async (_req: Request, res: Response) => {
    try {
      const result = await Promise.race([
        deps.recompute(),
        new Promise<undefined>((resolve) => {
          setTimeout(() => resolve(undefined), RECOMPUTE_WAIT_MS).unref();
        }),
      ]);
      res.status(202).json({
        computedAt: result?.computedAt ?? (await deps.store.lastComputedAt()) ?? now().toISOString(),
      });
    } catch (err) {
      console.error('[privacy-fields] recompute failed:', err);
      res.status(500).json({ error: 'field_classification_recompute_failed' });
    }
  });

  router.get('/:id/preview', async (req: Request, res: Response) => {
    const id = String(req.params['id'] ?? '');
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    try {
      const candidate = await deps.store.get(id);
      if (candidate === undefined) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      let samples: readonly string[] = candidate.maskedPreview;
      if (samples.length === 0) {
        const guard = deps.serviceRegistry.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);
        samples =
          guard?.maskedFieldPreview?.({
            toolName: candidate.toolName,
            fieldPath: candidate.fieldPath,
            limit: PREVIEW_LIMIT,
          }) ?? [];
      }
      res.json({ samples: samples.slice(0, PREVIEW_LIMIT) });
    } catch (err) {
      console.error('[privacy-fields] preview failed:', err);
      res.status(500).json({ error: 'field_classification_preview_failed' });
    }
  });

  /** Append or remove the field's `tool:field` line, under the plugin lock. */
  async function writeConfigEntry(
    candidate: FieldCandidate,
    mode: 'append' | 'remove',
  ): Promise<{ before: string; after: string; guardId: string }> {
    const guardId = privacyGuardInstalledId(deps.installedRegistry, deps.catalog);
    if (guardId === undefined) throw new DecisionConflict({ error: 'privacy_guard_not_installed' });
    return withPluginLock(guardId, async () => {
      const entry = deps.installedRegistry.get(guardId);
      if (entry === undefined) throw new DecisionConflict({ error: 'privacy_guard_not_installed' });
      const current = entry.config[NON_PERSONAL_FIELDS_KEY];
      const before = typeof current === 'string' ? current : '';
      if (mode === 'remove') {
        const coverage = configCoverage(before, candidate.toolName, candidate.fieldPath);
        if (coverage.wildcardEntry !== undefined) {
          throw new DecisionConflict({ error: 'covered_by_wildcard', entry: coverage.wildcardEntry });
        }
      }
      const after =
        mode === 'append'
          ? appendConfigEntry(before, candidate.toolName, candidate.fieldPath)
          : removeConfigEntry(before, candidate.toolName, candidate.fieldPath);
      if (after !== before) {
        const nextConfig: Record<string, unknown> = { ...entry.config };
        if (after.length === 0) delete nextConfig[NON_PERSONAL_FIELDS_KEY];
        else nextConfig[NON_PERSONAL_FIELDS_KEY] = after;
        await deps.installedRegistry.updateConfig(guardId, nextConfig);
      }
      return { before, after, guardId };
    });
  }

  router.post('/:id/decision', async (req: Request, res: Response) => {
    const id = String(req.params['id'] ?? '');
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input', detail: parsed.error.issues });
      return;
    }
    const { action, fingerprint } = parsed.data;
    try {
      const candidate = await deps.store.get(id);
      if (candidate === undefined) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (candidate.fingerprint !== fingerprint) {
        res.status(409).json({ error: 'stale_fingerprint', fingerprint: candidate.fingerprint });
        return;
      }
      const verdicts = await cachedVerdicts(deps.store, [candidate]);
      const shownBefore = liveStatus(candidate, rawConfig(), verdicts);
      if (!ALLOWED_ACTIONS[shownBefore.status].includes(action)) {
        res.status(409).json({ error: 'action_not_allowed', status: shownBefore.status });
        return;
      }

      const actor = auditActorFromRequest(req);
      let configChange: { before: string; after: string; guardId: string } | undefined;
      if (action === 'confirm') configChange = await writeConfigEntry(candidate, 'append');
      if (action === 'revert' && shownBefore.status === 'confirmed') {
        configChange = await writeConfigEntry(candidate, 'remove');
      }

      const decision: CandidateDecision = {
        action,
        fingerprint: candidate.fingerprint,
        byId: actor.id ?? null,
        byEmail: actor.email ?? null,
        at: now().toISOString(),
      };
      const shownAfter = liveStatus(candidate, rawConfig(), verdicts, decision);
      await deps.store.saveDecision(id, decision, shownAfter.status);

      if (deps.audit !== undefined) {
        try {
          await deps.audit.record({
            actor,
            action: FIELD_CLASSIFICATION_AUDIT_ACTION,
            target: `privacy-field:${candidate.toolName}:${candidate.fieldPath}`,
            before: {
              status: shownBefore.status,
              ...(configChange !== undefined ? { [NON_PERSONAL_FIELDS_KEY]: configChange.before } : {}),
            },
            after: {
              decision: action,
              status: shownAfter.status,
              fingerprint: candidate.fingerprint,
              ...(configChange !== undefined
                ? { plugin: configChange.guardId, [NON_PERSONAL_FIELDS_KEY]: configChange.after }
                : {}),
            },
          });
        } catch (err) {
          console.error(
            '[privacy-fields] audit write failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }

      const updated = (await deps.store.get(id)) ?? candidate;
      res.json({ item: toItem(updated, shownAfter) });
    } catch (err) {
      if (err instanceof DecisionConflict) {
        res.status(409).json(err.body);
        return;
      }
      console.error('[privacy-fields] decision failed:', err);
      res.status(500).json({ error: 'field_classification_decision_failed' });
    }
  });

  return router;
}
