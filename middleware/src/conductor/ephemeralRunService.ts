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
import { MAX_RUN_STATE_BYTES, RunStateRejectedError } from './ephemeralRunStateStore.js';
import type { ConductorEphemeralRunStateStore } from './ephemeralRunStateStore.js';
import type { ConductorEphemeralStore } from './ephemeralStore.js';
import type { PatternCatalog } from './patternCatalog.js';
import { RunAlreadyEndedError, WorkflowNotFoundError } from './runExecutor.js';
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

/** One element of `listOwnRuns` — the kernel↔plugin rehydration contract. */
export interface OwnEphemeralRun {
  runId: string;
  workflowId: string;
  workflowSlug: string;
  patternId: string | null;
  /** ISO timestamp of the workflow's TTL. */
  expiresAt: string;
  /** The start payload (run context minus the executor-owned reserved keys). */
  payload: Record<string, unknown>;
  /** Last blob saved via saveRunState, or null. */
  state: Record<string, unknown> | null;
}

export interface SaveRunStateInput {
  agentId: string;
  runId: string;
  state: Record<string, unknown>;
}

export interface CancelOwnRunInput {
  agentId: string;
  runId: string;
  reason?: string;
}

export interface CancelOwnRunResult {
  cancelled: boolean;
  reason?: 'not_found' | 'already_ended';
}

/** Mirrors the 0012 size CHECK on conductor_ephemeral_run_state.state. */
export { MAX_RUN_STATE_BYTES };

const RATE_WINDOW_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
const MAX_LOGGED_REASON_CHARS = 200;
/** Plugin ids are short package names; a bound keeps logs and the index sane. */
export const MAX_AGENT_ID_CHARS = 256;
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** Caller-controlled text on its way into a log line: control characters
 *  (newline injection, terminal escapes) become '?', length is capped. */
export function sanitizeForLog(value: string, maxChars = MAX_AGENT_ID_CHARS): string {
  const capped = value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  return capped.replace(CONTROL_CHARS_RE, '?');
}

/**
 * Executor-owned run-context keys. A caller-seeded `stepAttempts` would stretch
 * loop budgets, `steps` would fake history, and a seeded `transcript` /
 * `transcriptText` would let a caller fabricate a conversation the agents never
 * had — so they are stripped on the way in (createEphemeralRun) AND on the way
 * back out (listOwnRuns hands the plugin its start payload, not executor state).
 */
const RESERVED_CONTEXT_KEYS: ReadonlySet<string> = new Set(['steps', 'stepAttempts', 'transcript', 'transcriptText']);

function withoutReservedKeys(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !RESERVED_CONTEXT_KEYS.has(key)));
}

function requireAgentId(agentId: unknown): string {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new EphemeralInvalidInputError('agentId is required');
  }
  const trimmed = agentId.trim();
  if (trimmed.length > MAX_AGENT_ID_CHARS) {
    throw new EphemeralInvalidInputError(`agentId exceeds ${MAX_AGENT_ID_CHARS} characters`);
  }
  return trimmed;
}

function requireRunId(runId: unknown): string {
  // A non-UUID would make Postgres throw 22P02 deep in the query — reject at the boundary.
  if (typeof runId !== 'string' || !UUID_RE.test(runId.trim())) {
    throw new EphemeralInvalidInputError('runId must be a run UUID');
  }
  return runId.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeRunState(state: unknown): string {
  if (!isPlainObject(state)) {
    throw new EphemeralInvalidInputError('state must be a plain JSON object');
  }
  let json: string;
  let hasNul = false;
  try {
    // Postgres jsonb cannot store U+0000 (22P05) — find it in keys and strings
    // here, where it is a caller error, instead of as a 500 from the driver.
    json = JSON.stringify(state, (key: string, value: unknown) => {
      if (key.includes('\u0000') || (typeof value === 'string' && value.includes('\u0000'))) hasNul = true;
      return value;
    });
  } catch (err) {
    throw new EphemeralInvalidInputError(
      `state is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (hasNul) {
    throw new EphemeralInvalidInputError('state must not contain U+0000 characters');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_RUN_STATE_BYTES) {
    throw new EphemeralInvalidInputError(`state exceeds ${MAX_RUN_STATE_BYTES} bytes when serialized`);
  }
  return json;
}

export class ConductorEphemeralRunService {
  constructor(
    private readonly deps: {
      patterns: PatternCatalog;
      workflowStore: ConductorWorkflowStore;
      ephemeralStore: ConductorEphemeralStore;
      executor: ConductorRunExecutor;
      /** #330 C3 — backs poke(): early-expire a run's open timer tick. */
      awaitStore: ConductorAwaitStore;
      /** Durable per-run plugin state + owner-scoped run lookups (0012). */
      runState: ConductorEphemeralRunStateStore;
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

  /**
   * Every live ephemeral run the agent created, with its start payload and the
   * last saved state — what a plugin needs to rebuild its in-memory view after
   * a restart. Owner scoping is in the SQL (created_by_agent).
   */
  async listOwnRuns(input: { agentId: string }): Promise<OwnEphemeralRun[]> {
    const agentId = requireAgentId(input?.agentId);
    const now = (this.deps.now ?? (() => new Date()))();
    const rows = await this.deps.runState.listOwnActiveRuns(agentId, now);
    return rows.map((row) => ({
      runId: row.runId,
      workflowId: row.workflowId,
      workflowSlug: row.workflowSlug,
      patternId: row.patternId,
      expiresAt: row.expiresAt.toISOString(),
      payload: withoutReservedKeys(row.context),
      state: row.state,
    }));
  }

  /**
   * Persist the agent's working state for one of its own active runs (last
   * write wins). `{ saved: false }` when the run is unknown, foreign, ended or
   * reaped — never an error, so a late write after a cancel stays harmless.
   */
  async saveRunState(input: SaveRunStateInput): Promise<{ saved: boolean }> {
    const agentId = requireAgentId(input?.agentId);
    const runId = requireRunId(input?.runId);
    serializeRunState(input?.state);
    try {
      const saved = await this.deps.runState.upsertOwned(agentId, runId, input.state);
      return { saved };
    } catch (err) {
      if (err instanceof RunStateRejectedError) throw new EphemeralInvalidInputError(err.message);
      throw err;
    }
  }

  /**
   * Cancel one of the agent's own runs. Uses `executor.cancelRun` (not the
   * reaper's requestCancelActiveRuns): a 'waiting' run is finalized at once,
   * which fires run-ended → the ephemeral reap/dispose; a 'running' run is
   * flagged and the driver stops at the next step boundary.
   */
  async cancelOwnRun(input: CancelOwnRunInput): Promise<CancelOwnRunResult> {
    const agentId = requireAgentId(input?.agentId);
    const runId = requireRunId(input?.runId);
    if (input.reason !== undefined && typeof input.reason !== 'string') {
      throw new EphemeralInvalidInputError('reason must be a string when present');
    }
    const reason = sanitizeForLog((input.reason ?? '').trim(), MAX_LOGGED_REASON_CHARS) || '(none)';
    const logAgent = sanitizeForLog(agentId);
    const logOutcome = (outcome: string): void =>
      this.deps.log?.(`[conductor] ephemeral run ${runId} cancel by agent '${logAgent}' → ${outcome} (reason: ${reason})`);

    const owned = await this.deps.runState.getOwnedRun(agentId, runId);
    if (!owned) {
      logOutcome('not_found');
      return { cancelled: false, reason: 'not_found' };
    }
    if (TERMINAL_RUN_STATUSES.has(owned.status)) {
      logOutcome(`already_ended (${owned.status})`);
      return { cancelled: false, reason: 'already_ended' };
    }
    try {
      await this.deps.executor.cancelRun(runId, `agent:${agentId}`);
    } catch (err) {
      // The run ended (or vanished) between the owner check and the cancel.
      if (err instanceof RunAlreadyEndedError) {
        logOutcome('already_ended (raced)');
        return { cancelled: false, reason: 'already_ended' };
      }
      if (err instanceof WorkflowNotFoundError) {
        logOutcome('not_found (raced)');
        return { cancelled: false, reason: 'not_found' };
      }
      logOutcome(`failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err), MAX_LOGGED_REASON_CHARS)}`);
      throw err;
    }
    logOutcome('cancelled');
    return { cancelled: true };
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
      // conductor_workflow_versions.published_by is a UUID column reserved for
      // human operators; the agent handle lives in created_by_agent (TEXT).
      publishedBy: null,
    });

    try {
      // Reserved context keys are executor-owned (see RESERVED_CONTEXT_KEYS) —
      // a seeded transcript would be answered by the next speaker as if real.
      const payload = withoutReservedKeys(input.payload ?? {}) as JsonObject;
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
