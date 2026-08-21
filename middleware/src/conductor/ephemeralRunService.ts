// `conductor.createEphemeralRun` (#330 Workstream A) — create + start an
// agent-generated JIT workflow in one call. Generative but governed: the graph
// comes from a curated pattern (patternCatalog.ts) with the agent only filling
// validated slots; a mandatory, clamped TTL plus per-agent concurrency and
// rate guardrails keep runaway generation structurally impossible. The
// resulting workflow never appears in the library (origin 'ephemeral' +
// reserved `eph-` slug prefix); the reaper disposes of it after the run.

import { randomUUID } from 'node:crypto';

import type { JsonObject, TemplateMissingSlot, TemplateSlotMapping } from '@omadia/conductor-core';
import { applyTemplateSlots, missingSlotMappings, resolveLocalizedText } from '@omadia/conductor-core';

import type { ConductorAwaitStore } from './awaitStore.js';
import type { ConductorEphemeralStore } from './ephemeralStore.js';
import type { PatternCatalog } from './patternCatalog.js';
import type { ConductorRunExecutor } from './runExecutor.js';
import type { ConductorWorkflowStore } from './workflowStore.js';

/** Reserved prefix for agent-generated workflows — the manual create/instantiate
 *  routes reject it, so the namespaces cannot collide. */
export const EPHEMERAL_SLUG_PREFIX = 'eph-';

export class PatternNotFoundError extends Error {
  constructor(readonly patternId: string) {
    super(`ephemeral pattern '${patternId}' not found`);
    this.name = 'PatternNotFoundError';
  }
}

export class EphemeralSlotsMissingError extends Error {
  constructor(readonly missing: TemplateMissingSlot[]) {
    super(`ephemeral pattern slots unmapped: ${missing.map((m) => `${m.kind}:${m.key}`).join(', ')}`);
    this.name = 'EphemeralSlotsMissingError';
  }
}

export class EphemeralQuotaExceededError extends Error {
  constructor(
    readonly kind: 'concurrent' | 'rate',
    readonly limit: number,
  ) {
    super(
      kind === 'concurrent'
        ? `ephemeral run quota exceeded: ${limit} concurrent run(s) per agent`
        : `ephemeral create rate exceeded: ${limit} per hour per agent`,
    );
    this.name = 'EphemeralQuotaExceededError';
  }
}

export class EphemeralInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EphemeralInvalidInputError';
  }
}

export interface CreateEphemeralRunInput {
  /** The agent creating the run — quota/rate accounting key and audit provenance. */
  agentId: string;
  patternId: string;
  /** Slot mapping for the pattern (agents/roles/channels/…, see TemplateSlotMapping). */
  slots: TemplateSlotMapping;
  /** Run context payload ({{ctx.*}} in pattern prompts — e.g. goal, definitionOfDone). */
  payload?: JsonObject;
  /** Requested TTL; clamped to [1ms, maxTtlMs], defaulted to defaultTtlMs. */
  ttlMs?: number;
}

export interface EphemeralRunHandle {
  runId: string;
  workflowId: string;
  workflowSlug: string;
  /** ISO timestamp after which the reaper disposes of the workflow definition. */
  expiresAt: string;
}

export interface EphemeralRunLimits {
  defaultTtlMs: number;
  maxTtlMs: number;
  maxActivePerAgent: number;
  maxCreatesPerHour: number;
}

const RATE_WINDOW_MS = 60 * 60 * 1000;

export class ConductorEphemeralRunService {
  constructor(
    private readonly deps: {
      patterns: PatternCatalog;
      workflowStore: ConductorWorkflowStore;
      ephemeralStore: ConductorEphemeralStore;
      executor: ConductorRunExecutor;
      /** #330 C3 — backs poke(): early-expire a run's open timer tick. */
      awaitStore: ConductorAwaitStore;
      limits: EphemeralRunLimits;
      now?: () => Date;
      log?: (msg: string) => void;
    },
  ) {}

  /**
   * #330 C3 — early-fire the run's open timer await ("the group is done, do
   * not wait out the interval"). No-op when nothing is parked on a timer.
   */
  async poke(runId: string): Promise<{ poked: boolean }> {
    if (typeof runId !== 'string' || runId.trim().length === 0) {
      throw new EphemeralInvalidInputError('runId is required');
    }
    const open = await this.deps.awaitStore.openTimerAwaitForRun(runId.trim());
    if (!open) return { poked: false };
    await this.deps.executor.expireAwait(open.id);
    this.deps.log?.(`[conductor] ephemeral run ${runId} poked — timer '${open.stepId}' fired early`);
    return { poked: true };
  }

  async createEphemeralRun(input: CreateEphemeralRunInput): Promise<EphemeralRunHandle> {
    // Boundary validation — callers are plugins, the input is untrusted.
    if (typeof input.agentId !== 'string' || input.agentId.trim().length === 0) {
      throw new EphemeralInvalidInputError('agentId is required');
    }
    if (typeof input.patternId !== 'string' || input.patternId.trim().length === 0) {
      throw new EphemeralInvalidInputError('patternId is required');
    }
    if (typeof input.slots !== 'object' || input.slots === null || Array.isArray(input.slots)) {
      throw new EphemeralInvalidInputError('slots must be a slot-mapping object');
    }
    if (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
      throw new EphemeralInvalidInputError('ttlMs must be a positive number when present');
    }
    const agentId = input.agentId.trim();

    const pattern = this.deps.patterns.get(input.patternId);
    if (!pattern) throw new PatternNotFoundError(input.patternId);

    const missing = missingSlotMappings(pattern, input.slots);
    if (missing.length > 0) throw new EphemeralSlotsMissingError(missing);

    const { limits } = this.deps;
    const active = await this.deps.ephemeralStore.countActiveRunsByAgent(agentId);
    if (active >= limits.maxActivePerAgent) {
      throw new EphemeralQuotaExceededError('concurrent', limits.maxActivePerAgent);
    }
    const now = (this.deps.now ?? (() => new Date()))();
    const recent = await this.deps.ephemeralStore.countRecentCreatesByAgent(
      agentId,
      new Date(now.getTime() - RATE_WINDOW_MS),
    );
    if (recent >= limits.maxCreatesPerHour) {
      throw new EphemeralQuotaExceededError('rate', limits.maxCreatesPerHour);
    }

    // TTL is mandatory and bounded — an unbounded ephemeral definition is the
    // exact clutter #330 forbids (also CHECK-enforced in the schema).
    const ttlMs = Math.min(input.ttlMs ?? limits.defaultTtlMs, limits.maxTtlMs);
    const expiresAt = new Date(now.getTime() + ttlMs);

    const graph = applyTemplateSlots(pattern, input.slots);
    const slug = `${EPHEMERAL_SLUG_PREFIX}${input.patternId}-${randomUUID().slice(0, 8)}`;

    const published = await this.deps.workflowStore.createOrPublish({
      slug,
      name: resolveLocalizedText(pattern.name),
      description: resolveLocalizedText(pattern.description),
      graph,
      enable: true,
      expectNew: true,
      origin: 'ephemeral',
      expiresAt,
      createdByAgent: agentId,
      publishedBy: `agent:${agentId}`,
    });

    try {
      // Reserved context keys are executor-owned: a caller-seeded
      // `stepAttempts` would stretch loop budgets, `steps` would fake history.
      const { stepAttempts: _ignoredAttempts, steps: _ignoredSteps, ...payload } = input.payload ?? {};
      const run = await this.deps.executor.startRun({
        slug,
        payload,
        triggerKind: 'agent',
        triggerSource: { agentId, patternId: input.patternId },
      });
      return {
        runId: run.id,
        workflowId: published.workflow.id,
        workflowSlug: slug,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (err) {
      // Best-effort immediate disposal of the never-started scaffold; the reaper
      // is the safety net if this cleanup itself fails. startRun CAN throw after
      // the durable run row exists (a drive crash) — the cancel request below
      // covers that window, since a reaped definition leaves listReapable and the
      // reaper would otherwise never cancel the orphan.
      await this.deps.ephemeralStore
        .requestCancelActiveRuns(published.workflow.id, `agent:${agentId}`)
        .catch(() => undefined);
      await this.deps.ephemeralStore.markReaped(published.workflow.id).catch(() => undefined);
      await this.deps.ephemeralStore.hardDeleteUnreferenced(published.workflow.id).catch(() => undefined);
      this.deps.log?.(
        `[conductor] ephemeral start of '${slug}' failed — scaffold reaped: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}
