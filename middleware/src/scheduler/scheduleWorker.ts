/**
 * Agent Builder schedule worker (P6).
 *
 * Polls `agent_schedules` once per minute and fires a synthetic chat turn
 * against the bound agent's orchestrator for each enabled schedule whose cron
 * matches the current minute. Per-minute, per-schedule de-duplication lives in
 * memory so a within-minute restart can't double-fire; overlap across ticks is
 * prevented by tracking in-flight schedule ids.
 *
 * The turn runs headlessly via the registry's `ChatAgent.chat(...)` — the same
 * entrypoint the chat route uses — so scheduled runs exercise the full
 * orchestrator (tools, sub-agents, memory) exactly like an interactive turn.
 */

import type { AgentGraphStore, OrchestratorRegistry } from '@omadia/orchestrator';

import { cronMatches } from './cron.js';

export interface ScheduleWorkerDeps {
  readonly getGraphStore: () => AgentGraphStore | undefined;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Poll cadence in ms. Defaults to 60_000 (one minute). */
  readonly intervalMs?: number;
  /** Injectable clock for tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export class ScheduleWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly firedThisMinute = new Map<string, string>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ScheduleWorkerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 60_000;
    // Run once promptly, then on the cadence.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log('schedule worker started', { intervalMs: interval });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One poll cycle. Exposed for tests (call directly, no timer needed). */
  async tick(): Promise<void> {
    const graph = this.deps.getGraphStore();
    const registry = this.deps.getRegistry();
    if (!graph || !registry) return;

    const now = (this.deps.now ?? (() => new Date()))();
    const minuteKey = isoMinute(now);

    let schedules;
    try {
      schedules = await graph.listAllSchedules();
    } catch (err) {
      this.log('schedule worker: list failed', { error: errMsg(err) });
      return;
    }

    // Map agentId → slug from the live registry (only active agents can run).
    const slugByAgentId = new Map<string, string>();
    for (const a of registry.list()) slugByAgentId.set(a.agent.id, a.agent.slug);

    for (const s of schedules) {
      if (s.status !== 'enabled') continue;
      if (this.inFlight.has(s.id)) continue;
      if (this.firedThisMinute.get(s.id) === minuteKey) continue;
      if (!cronMatches(s.cron, now, s.timezone)) continue;

      const slug = slugByAgentId.get(s.agentId);
      if (!slug) {
        this.log('schedule worker: agent not active — skipping', {
          scheduleId: s.id,
          agentId: s.agentId,
        });
        continue;
      }

      this.firedThisMinute.set(s.id, minuteKey);
      this.inFlight.add(s.id);
      void this.fire(s.id, slug, s.payload, registry, graph).finally(() =>
        this.inFlight.delete(s.id),
      );
    }

    // Bound the dedup map: drop entries from previous minutes.
    for (const [id, key] of this.firedThisMinute) {
      if (key !== minuteKey) this.firedThisMinute.delete(id);
    }
  }

  private async fire(
    scheduleId: string,
    slug: string,
    payload: Record<string, unknown>,
    registry: OrchestratorRegistry,
    graph: AgentGraphStore,
  ): Promise<void> {
    const entry = registry.get(slug);
    if (!entry) return;
    const userMessage =
      typeof payload['prompt'] === 'string' && payload['prompt'].trim()
        ? (payload['prompt'] as string)
        : 'Scheduled run: perform your configured routine.';
    try {
      this.log('schedule worker: firing', { scheduleId, slug });
      await entry.built.bundle.agent.chat({
        userMessage,
        sessionScope: `schedule:${scheduleId}`,
      });
      await graph.markScheduleRun(scheduleId);
      this.log('schedule worker: completed', { scheduleId, slug });
    } catch (err) {
      this.log('schedule worker: turn failed', {
        scheduleId,
        slug,
        error: errMsg(err),
      });
    }
  }

  private log(msg: string, fields?: Record<string, unknown>): void {
    this.deps.log?.(msg, fields);
  }
}

function isoMinute(d: Date): string {
  return d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
