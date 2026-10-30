/**
 * Field classification (#1556 follow-up, contract v2) — the admin API.
 * Mounted behind `requireAuth` at `/api/v1/admin/privacy/field-classification`
 * by `index.ts`. Every authenticated session is an admin session (there is
 * no non-admin login), so `requireAuth` IS the admin gate — including for
 * the real-value preview below. Should a non-admin role ever exist, this
 * router (the preview first) needs an explicit admin check.
 *
 * GET  /?status=&tool=   candidates (one per tool + scope + field) with their
 *                        status shown NOW (the current `non_personal_fields`
 *                        value and the admin decisions laid over the last
 *                        recompute), counts per status, how many changed
 *                        since this admin's last visit
 * POST /:id/decision     confirm | reject | keep_masked | revert
 * GET  /:id/preview      the REAL buffered values (admin only, read from the
 *                        kernel-only `privacyFieldSamples` service, audited
 *                        as `privacy.field_preview`, never logged) plus the
 *                        stored shape-masked strings as a fallback; for an
 *                        uploaded dataset (`query_dataset`) masked only —
 *                        its rows belong to the uploading user
 * GET  /legacy           legacy entries (`tool:field`, `*:field`, `field` —
 *                        they apply to every model) and the fields each covers
 * POST /legacy/convert   replace one legacy entry by scoped entries for the
 *                        fields it covers — except fields whose base status
 *                        is personal (`skippedPersonal`): they are masked
 *                        afterwards and the admin decides about them
 * POST /recompute        run a recompute pass now
 *
 * Only `confirm`, `revert` and `legacy/convert` write config: confirm
 * appends exactly one scoped entry (`<tool>:<scope>/<field>`,
 * `dataset:<id>/<column>`), revert removes it, through the installed-registry
 * update the `PATCH /admin/runtime/installed/:id/config` route uses,
 * serialized per plugin. A `confirm` on a field the setting already covers
 * (`confirmed_conflict`) only acknowledges: it records the decision on the
 * current fingerprint and leaves the setting untouched. A field that cannot
 * be written as exactly one scoped entry is refused (409 `invalid_field`).
 * Every decision and conversion writes an audit row
 * (`privacy.field_classification`). Only the preview response carries field
 * values, and nothing here logs them. Every response is `Cache-Control:
 * no-store` — the preview's real values must not land in a browser or proxy
 * cache, and the lists change with every decision.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  PRIVACY_FIELD_SAMPLES_SERVICE_NAME,
  PRIVACY_REDACT_SERVICE_NAME,
  type PrivacyFieldSampleService,
  type PrivacyGuardService,
} from '@omadia/plugin-api';
import { DATASET_TOOL } from '@omadia/plugin-privacy-guard/dist/nonPersonalFields.js';

import { auditActorFromRequest, type AdminAuditLog } from '../../auth/adminAuditLog.js';
import type { InstalledRegistry } from '../../plugins/installedRegistry.js';
import type { PluginCatalog } from '../../plugins/manifestLoader.js';
import {
  DECISION_ACTIONS,
  FIELD_STATUSES,
  InvalidFieldEntryError,
  appendConfigEntry,
  classifyBase,
  configCoverage,
  configEntryOf,
  isValidFieldIdentity,
  legacyEntries,
  legacyEntryCovers,
  removeConfigEntry,
  replaceLegacyEntry,
  resolveStatus,
  sourceKeyOf,
  type CandidateKey,
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
import { PREVIEW_LIMIT, fieldKeyOf, type RecomputeResult } from './recompute.js';
import type { CandidateDecision, FieldCandidate, FieldClassificationStore } from './store.js';

export const FIELD_CLASSIFICATION_AUDIT_ACTION = 'privacy.field_classification';
export const FIELD_PREVIEW_AUDIT_ACTION = 'privacy.field_preview';
/** Real values shown per preview open. */
export const ADMIN_SAMPLE_LIMIT = 10;
/** How long `POST /recompute` waits for the pass before answering. */
const RECOMPUTE_WAIT_MS = 20_000;

export interface FieldClassificationRouteDeps {
  readonly store: FieldClassificationStore;
  readonly installedRegistry: Pick<InstalledRegistry, 'list' | 'get' | 'updateConfig'>;
  readonly catalog?: Pick<PluginCatalog, 'get'>;
  readonly serviceRegistry: { get<T>(name: string): T | undefined };
  /** Without an audit log the preview shows no real value (it must be
   *  audited) — only the masked fallback. */
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

const convertSchema = z.object({
  entry: z.string().trim().min(1).max(400),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which action an admin may take on a field in which shown status. */
const ALLOWED_ACTIONS: Readonly<Record<FieldStatus, readonly DecisionAction[]>> = {
  suggested: ['confirm', 'reject', 'keep_masked'],
  needs_clarification: ['confirm', 'reject', 'keep_masked'],
  personal: ['keep_masked'],
  confirmed: ['revert'],
  // `confirm` acknowledges the conflict without touching the setting.
  confirmed_conflict: ['confirm', 'revert'],
  rejected: ['revert'],
  kept_masked: ['revert'],
};

export interface FieldClassificationItem {
  readonly id: string;
  readonly toolName: string;
  /** An Odoo model, a dataset id, or `-`. */
  readonly scope: string;
  readonly fieldPath: string;
  /** The field's schema label where the source has one. */
  readonly label: string | null;
  readonly valueShape: string;
  readonly relationModels: readonly string[];
  readonly status: FieldStatus;
  readonly reasons: readonly FieldReason[];
  /** The scoped entry a confirm writes. */
  readonly configEntry: string;
  readonly fingerprint: string;
  readonly decision: { action: DecisionAction; by: string | null; at: string } | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly seenCount: number;
}

export interface LegacyCoveredField extends CandidateKey {
  readonly id: string;
  /** The scoped entry a conversion writes for this field. */
  readonly configEntry: string;
  /** The classifier rates the field personal: a conversion does NOT write
   *  its scoped entry (it is masked afterwards; the admin decides). */
  readonly personal: boolean;
}

function coveredField(
  c: FieldCandidate,
  verdicts: ReadonlyMap<string, ModelVerdictSummary>,
): LegacyCoveredField {
  return {
    id: c.id,
    toolName: c.toolName,
    scope: c.scope,
    fieldPath: c.fieldPath,
    configEntry: configEntryOf(c),
    personal: baseOf(c, verdicts).status === 'personal',
  };
}

/** Cached schema verdicts for every relation target and source of
 *  `candidates`. */
async function cachedVerdicts(
  store: FieldClassificationStore,
  candidates: readonly FieldCandidate[],
): Promise<Map<string, ModelVerdictSummary>> {
  const keys = [
    ...new Set(
      candidates.flatMap((c) => (c.relationModels.length > 0 ? c.relationModels : [sourceKeyOf(c)])),
    ),
  ];
  const rows = await store.modelVerdicts(keys, new Date(0));
  return new Map(rows.map((r) => [r.model, { verdict: r.verdict, confidence: r.confidence }]));
}

/** What the classifier itself says about a stored candidate (no config,
 *  no decision). */
function baseOf(
  candidate: FieldCandidate,
  verdicts: ReadonlyMap<string, ModelVerdictSummary>,
): ReturnType<typeof classifyBase> {
  return classifyBase({
    ...fieldKeyOf(candidate),
    valueShape: candidate.valueShape,
    relationModels: candidate.relationModels,
    ...(candidate.sampleVerdict !== null ? { sample: candidate.sampleVerdict } : {}),
    modelVerdicts: verdicts,
  });
}

/** The status of a stored candidate under the CURRENT config and decision. */
export function liveStatus(
  candidate: FieldCandidate,
  rawConfig: string | undefined,
  verdicts: ReadonlyMap<string, ModelVerdictSummary>,
  decision: CandidateDecision | null = candidate.decision,
): { status: FieldStatus; reasons: readonly FieldReason[] } {
  const base = baseOf(candidate, verdicts);
  return resolveStatus(base, candidate.fingerprint, configCoverage(rawConfig, candidate), decision);
}

function toItem(
  candidate: FieldCandidate,
  shown: { status: FieldStatus; reasons: readonly FieldReason[] },
): FieldClassificationItem {
  return {
    id: candidate.id,
    toolName: candidate.toolName,
    scope: candidate.scope,
    fieldPath: candidate.fieldPath,
    label: candidate.label,
    valueShape: candidate.valueShape,
    relationModels: candidate.relationModels,
    status: shown.status,
    reasons: shown.reasons,
    configEntry: configEntryOf(candidate),
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

/** The audit target of a field: `privacy-field:<tool>:<scope>/<path>`. */
export function fieldAuditTarget(candidate: CandidateKey): string {
  return `privacy-field:${candidate.toolName}:${candidate.scope}/${candidate.fieldPath}`;
}

function emptyCounts(): Record<FieldStatus, number> {
  return Object.fromEntries(FIELD_STATUSES.map((s) => [s, 0])) as Record<FieldStatus, number>;
}

function visitorKey(req: Request): string {
  const actor = auditActorFromRequest(req);
  return actor.id ?? actor.email ?? req.session?.sub ?? 'admin';
}

/** Statuses an admin still has to look at. */
function isOpenStatus(status: FieldStatus): boolean {
  return status === 'suggested' || status === 'needs_clarification' || status === 'confirmed_conflict';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Serializes the config read-modify-write per plugin id.
 *
 * Known race (L3, accepted): this lock only orders writes made through THIS
 * router. A concurrent `PATCH /admin/runtime/installed/:id/config` (the
 * generic plugin settings form) is not serialized against it, so one of the
 * two writes can overwrite the other's `non_personal_fields`. Both outcomes
 * fail safe — a lost append leaves the field masked, a lost removal is
 * visible on the page as still confirmed — so it is left as is.
 */
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

interface ConfigChange {
  readonly before: string;
  readonly after: string;
  readonly guardId: string;
}

export function createFieldClassificationRoutes(deps: FieldClassificationRouteDeps): Router {
  const router = Router();
  const withPluginLock = createKeyedMutex();
  const now = deps.now ?? (() => new Date());
  const rawConfig = (): string | undefined =>
    readNonPersonalFieldsConfig(deps.installedRegistry, deps.catalog);
  const guard = (): PrivacyGuardService | undefined =>
    deps.serviceRegistry.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);
  /** Real values: the kernel-only service no plugin can resolve. */
  const fieldSamples = (): PrivacyFieldSampleService | undefined =>
    deps.serviceRegistry.get<PrivacyFieldSampleService>(PRIVACY_FIELD_SAMPLES_SERVICE_NAME);

  router.use((_req: Request, res: Response, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  /** Candidates that form one scoped entry — the only ones ever shown. */
  const listable = async (filter: { toolName?: string } = {}): Promise<FieldCandidate[]> =>
    (await deps.store.list(filter)).filter((c) => isValidFieldIdentity(c));

  /** Read-modify-write of `non_personal_fields` under the plugin lock. */
  async function editConfig(edit: (before: string) => string): Promise<ConfigChange> {
    const guardId = privacyGuardInstalledId(deps.installedRegistry, deps.catalog);
    if (guardId === undefined) throw new DecisionConflict({ error: 'privacy_guard_not_installed' });
    return withPluginLock(guardId, async () => {
      const entry = deps.installedRegistry.get(guardId);
      if (entry === undefined) throw new DecisionConflict({ error: 'privacy_guard_not_installed' });
      const current = entry.config[NON_PERSONAL_FIELDS_KEY];
      const before = typeof current === 'string' ? current : '';
      const after = edit(before);
      if (after !== before) {
        const nextConfig: Record<string, unknown> = { ...entry.config };
        if (after.length === 0) delete nextConfig[NON_PERSONAL_FIELDS_KEY];
        else nextConfig[NON_PERSONAL_FIELDS_KEY] = after;
        await deps.installedRegistry.updateConfig(guardId, nextConfig);
      }
      return { before, after, guardId };
    });
  }

  /** Append or remove the field's scoped entry. */
  function writeConfigEntry(candidate: FieldCandidate, mode: 'append' | 'remove'): Promise<ConfigChange> {
    return editConfig((before) => {
      if (mode === 'append') return appendConfigEntry(before, candidate);
      // A legacy entry applies to every model: removing the scoped entry
      // would leave the field in clear text. The page offers to convert it.
      const coverage = configCoverage(before, candidate);
      if (coverage.legacyEntry !== undefined) {
        throw new DecisionConflict({ error: 'covered_by_legacy', entry: coverage.legacyEntry });
      }
      return removeConfigEntry(before, candidate);
    });
  }

  async function recordAudit(entry: Parameters<AdminAuditLog['record']>[0]): Promise<void> {
    if (deps.audit === undefined) return;
    try {
      await deps.audit.record(entry);
    } catch (err) {
      console.error('[privacy-fields] audit write failed:', errorText(err));
    }
  }

  router.get('/', async (req: Request, res: Response) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', detail: parsed.error.issues });
      return;
    }
    try {
      const candidates = await listable(
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
        if (isOpenStatus(shown.status) && (lastVisit === null || candidate.lastStatusChangeAt > lastVisit)) {
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
      console.error('[privacy-fields] list failed:', errorText(err));
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
      console.error('[privacy-fields] recompute failed:', errorText(err));
      res.status(500).json({ error: 'field_classification_recompute_failed' });
    }
  });

  router.get('/legacy', async (_req: Request, res: Response) => {
    try {
      const candidates = await listable();
      const verdicts = await cachedVerdicts(deps.store, candidates);
      const entries = legacyEntries(rawConfig()).map((legacy) => ({
        entry: legacy.entry,
        covers: candidates
          .filter((c) => legacyEntryCovers(legacy, c))
          .map((c) => coveredField(c, verdicts)),
      }));
      res.json({ entries });
    } catch (err) {
      console.error('[privacy-fields] legacy list failed:', errorText(err));
      res.status(500).json({ error: 'field_classification_query_failed' });
    }
  });

  /**
   * Replace ONE legacy entry by the scoped entries of every field it covers
   * that the page has seen. Fields it covers that were never seen are masked
   * afterwards (fail safe), and so are covered fields whose BASE status is
   * personal: the response lists them as `skippedPersonal` and the page shows
   * them, so the admin decides instead of a conversion carrying a person's
   * field into a scoped entry. A covered field the admin had confirmed records a
   * `confirm` decision on its current fingerprint; a `confirmed_conflict`
   * field keeps its entry and stays a conflict until acknowledged.
   */
  router.post('/legacy/convert', async (req: Request, res: Response) => {
    const parsed = convertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input', detail: parsed.error.issues });
      return;
    }
    const { entry } = parsed.data;
    try {
      const candidates = await listable();
      const verdicts = await cachedVerdicts(deps.store, candidates);
      const configBefore = rawConfig();
      const added: string[] = [];
      const skipped: CandidateKey[] = [];
      const skippedPersonal: LegacyCoveredField[] = [];
      const converted: FieldCandidate[] = [];
      const change = await editConfig((before) => {
        const legacy = legacyEntries(before).find((l) => l.entry === entry);
        if (legacy === undefined) throw new DecisionConflict({ error: 'legacy_entry_not_found', entry });
        for (const c of candidates.filter((x) => legacyEntryCovers(legacy, x))) {
          if (baseOf(c, verdicts).status === 'personal') {
            skippedPersonal.push(coveredField(c, verdicts));
            continue;
          }
          try {
            added.push(configEntryOf(c));
            converted.push(c);
          } catch (err) {
            if (!(err instanceof InvalidFieldEntryError)) throw err;
            skipped.push(fieldKeyOf(c));
          }
        }
        const after = replaceLegacyEntry(before, entry, added);
        if (after === undefined) throw new DecisionConflict({ error: 'legacy_entry_not_found', entry });
        return after;
      });

      const actor = auditActorFromRequest(req);
      const at = now().toISOString();
      const conflicts: string[] = [];
      for (const candidate of converted) {
        const shownBefore = liveStatus(candidate, configBefore, verdicts);
        const decision: CandidateDecision | null =
          shownBefore.status === 'confirmed'
            ? {
                action: 'confirm',
                fingerprint: candidate.fingerprint,
                byId: actor.id ?? null,
                byEmail: actor.email ?? null,
                at,
              }
            : candidate.decision;
        if (shownBefore.status === 'confirmed_conflict') conflicts.push(candidate.id);
        const shownAfter = liveStatus(candidate, change.after, verdicts, decision);
        try {
          await deps.store.saveDecision(candidate.id, decision, shownAfter.status);
        } catch (err) {
          // The setting covers exactly what it covered before for this field;
          // only the decision row is missing. Logged, not undone.
          console.error('[privacy-fields] decision write after convert failed:', errorText(err));
        }
      }

      await recordAudit({
        actor,
        action: FIELD_CLASSIFICATION_AUDIT_ACTION,
        target: `privacy-field-legacy:${entry}`,
        before: { [NON_PERSONAL_FIELDS_KEY]: change.before },
        after: {
          conversion: 'legacy_to_scoped',
          plugin: change.guardId,
          [NON_PERSONAL_FIELDS_KEY]: change.after,
          added,
          skipped: skipped.length,
          skippedPersonal: skippedPersonal.map((f) => f.configEntry),
        },
      });
      res.json({ entry, added, skipped, skippedPersonal, conflicts });
    } catch (err) {
      if (err instanceof DecisionConflict) {
        res.status(409).json(err.body);
        return;
      }
      console.error('[privacy-fields] legacy convert failed:', errorText(err));
      res.status(500).json({ error: 'field_classification_convert_failed' });
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
      if (!isValidFieldIdentity(candidate)) {
        res.status(409).json({ error: 'invalid_field' });
        return;
      }
      const key = fieldKeyOf(candidate);
      const service = guard();
      let maskedSamples: readonly string[] = candidate.maskedPreview;
      if (maskedSamples.length === 0) {
        maskedSamples = service?.maskedFieldPreview?.({ ...key, limit: PREVIEW_LIMIT }) ?? [];
      }
      // An uploaded dataset's rows are owner-scoped (encrypted per owner):
      // its real values are never shown, only the masked fallback.
      const withheld = candidate.toolName === DATASET_TOOL ? 'owner_scoped_dataset' : null;
      // Real values only with an audit trail to record the view in.
      let samples: readonly string[] = [];
      if (deps.audit !== undefined && withheld === null) {
        samples = (fieldSamples()?.fieldSampleForAdmin({ ...key, limit: ADMIN_SAMPLE_LIMIT }) ?? []).slice(
          0,
          ADMIN_SAMPLE_LIMIT,
        );
        // Audited only when real values go out. Fail closed: no audit row,
        // no values. The row carries the count only — never a value.
        if (samples.length > 0) {
          await deps.audit.record({
            actor: auditActorFromRequest(req),
            action: FIELD_PREVIEW_AUDIT_ACTION,
            target: fieldAuditTarget(candidate),
            after: { count: samples.length },
          });
        }
      }
      res.json({
        samples,
        maskedSamples: maskedSamples.slice(0, PREVIEW_LIMIT),
        samplesWithheld: withheld,
      });
    } catch (err) {
      // Only the error text — the values are never part of it.
      console.error('[privacy-fields] preview failed:', errorText(err));
      res.status(500).json({ error: 'field_classification_preview_failed' });
    }
  });

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
      if (!isValidFieldIdentity(candidate)) {
        res.status(409).json({ error: 'invalid_field' });
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
      let configChange: ConfigChange | undefined;
      const covered = shownBefore.status === 'confirmed' || shownBefore.status === 'confirmed_conflict';
      // On a covered field, confirm only acknowledges: decision row, no write.
      if (action === 'confirm' && !covered) {
        configChange = await writeConfigEntry(candidate, 'append');
      }
      if (action === 'revert' && covered) {
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
      try {
        await deps.store.saveDecision(id, decision, shownAfter.status);
      } catch (err) {
        // No setting change without its decision row: undo the write, so a
        // field never reaches the model in clear on a decision nobody can see.
        if (configChange !== undefined) {
          await writeConfigEntry(candidate, action === 'confirm' ? 'remove' : 'append').catch(
            (undoErr: unknown) => {
              console.error(
                '[privacy-fields] undoing the setting change after a failed decision write failed:',
                errorText(undoErr),
              );
            },
          );
        }
        throw err;
      }

      await recordAudit({
        actor,
        action: FIELD_CLASSIFICATION_AUDIT_ACTION,
        target: fieldAuditTarget(candidate),
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

      const updated = (await deps.store.get(id)) ?? candidate;
      res.json({ item: toItem(updated, shownAfter) });
    } catch (err) {
      if (err instanceof DecisionConflict) {
        res.status(409).json(err.body);
        return;
      }
      if (err instanceof InvalidFieldEntryError) {
        res.status(409).json({ error: 'invalid_field' });
        return;
      }
      console.error('[privacy-fields] decision failed:', errorText(err));
      res.status(500).json({ error: 'field_classification_decision_failed' });
    }
  });

  return router;
}
