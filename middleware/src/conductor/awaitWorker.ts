import { resolveAwaitHolders } from './awaitStore.js';
import type { ConductorAwait, ConductorAwaitStore } from './awaitStore.js';
import type { ConductorRunExecutor } from './runExecutor.js';
import type { ConductorChannelBindingStore } from './channelBindingStore.js';

interface ReminderDeps {
  bindingStore: ConductorChannelBindingStore;
  resolveRoleHolders: (roleKey: string) => Promise<string[]>;
  getProactiveSender: (channel: string) => ProactiveSenderLike | undefined;
}

/** Minimal proactive-sender shape (structural) — keeps the worker decoupled from the channel SDK's
 *  SemanticAnswer type. `{ text }` is a valid SemanticAnswer: `text` is its ONLY required field
 *  (see `@omadia/channel-sdk` SemanticAnswer in harness-channel-sdk/src/outgoing.ts). If the SDK ever
 *  adds a second required field this structural call breaks — re-check there before relying on it. */
export interface ProactiveSenderLike {
  send(opts: { conversationRef: unknown; message: { text: string } }): Promise<void>;
}

/**
 * Polls `conductor_awaits` on a minute tick and expires any waiting await whose deadline has
 * passed — firing the human step's in-graph fallback transition (FR-017). Reminders (which need
 * proactive channel notification) are a later addition; this worker handles the deadline path.
 * graphPool-gated by the caller (only started when Postgres is available).
 */
export class ConductorAwaitWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly deps: {
      awaitStore: ConductorAwaitStore;
      executor: ConductorRunExecutor;
      // US5 reminders (all optional — absent ⇒ the worker only does the deadline path):
      bindingStore?: ConductorChannelBindingStore;
      resolveRoleHolders?: (roleKey: string) => Promise<string[]>;
      getProactiveSender?: (channel: string) => ProactiveSenderLike | undefined;
      intervalMs?: number;
      now?: () => Date;
      log?: (msg: string) => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 60_000;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.deps.log?.('[conductor] await worker started (deadline poll)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return; // never let two ticks overlap (consistent with the resume/schedule workers)
    this.ticking = true;
    try {
      const now = (this.deps.now ?? (() => new Date()))();
      let due;
      try {
        due = await this.deps.awaitStore.listDue(now);
      } catch (err) {
        this.deps.log?.(`[conductor] await worker list failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      for (const aw of due) {
        try {
          await this.deps.executor.expireAwait(aw.id);
        } catch (err) {
          this.deps.log?.(`[conductor] await worker expire ${aw.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Reminders (US5) — only when the reminder substrate is wired (binding store + holder resolver
      // + proactive sender). Resolve the optional deps into a non-null bundle once, here.
      const { bindingStore, resolveRoleHolders, getProactiveSender } = this.deps;
      if (bindingStore && resolveRoleHolders && getProactiveSender) {
        let reminders: ConductorAwait[];
        try {
          reminders = await this.deps.awaitStore.listRemindersDue(now);
        } catch (err) {
          this.deps.log?.(`[conductor] await worker reminder list failed: ${err instanceof Error ? err.message : String(err)}`);
          reminders = [];
        }
        const reminderDeps: ReminderDeps = { bindingStore, resolveRoleHolders, getProactiveSender };
        for (const aw of reminders) {
          try {
            // Claim-then-send: atomically advance the reminder clock first; only the winner delivers,
            // so two replicas (or a failed send/record) can't re-nudge before the next interval.
            if (!(await this.deps.awaitStore.claimReminderDue(aw.id, now))) continue;
            await this.sendReminder(aw, reminderDeps);
          } catch (err) {
            this.deps.log?.(`[conductor] await worker reminder ${aw.id} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Nudge a waiting await's current holder(s) on their bound channel — called only after the reminder
   * slot is claimed (clock already advanced). Holders are resolved LIVE (FR-022) so a moved baton
   * re-targets, and de-duplicated. For quorum='all' the holders who already responded are dropped (the
   * await stays open for the others). Each send is isolated: one holder's stale/deleted ref
   * (ProactiveSender.send throws) must not block the others. `unreachable` is set iff at least one
   * holder still needs nudging but none could be reached (cleared on a successful delivery).
   */
  private async sendReminder(aw: ConductorAwait, deps: ReminderDeps): Promise<void> {
    let holders = [...new Set(await resolveAwaitHolders(aw, deps.resolveRoleHolders))];
    if (aw.quorum === 'all') {
      const responded = new Set((await this.deps.awaitStore.listResponses(aw.id)).map((r) => r.responderId));
      holders = holders.filter((h) => !responded.has(h));
    }
    // Nothing to nudge (all responded, or no current holder) — not an unreachable condition.
    if (holders.length === 0) return;

    const sender = deps.getProactiveSender(aw.channelType);
    let delivered = 0;
    if (sender) {
      const refs = await deps.bindingStore.getMany(holders, aw.channelType);
      const text = `Reminder: ${aw.message || 'a pending step awaits your response.'}`;
      for (const holder of holders) {
        const conversationRef = refs.get(holder);
        if (!conversationRef) continue;
        try {
          await sender.send({ conversationRef, message: { text } });
          delivered += 1;
        } catch (err) {
          this.deps.log?.(`[conductor] await ${aw.id} reminder to '${holder}' failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    await this.deps.awaitStore.setReminderUnreachable(aw.id, delivered === 0);
    this.deps.log?.(
      delivered > 0
        ? `[conductor] await ${aw.id} reminder sent to ${delivered} holder(s)`
        : `[conductor] await ${aw.id} reminder: no reachable holder on '${aw.channelType}' → unreachable`,
    );
  }
}
