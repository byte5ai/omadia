// Channel readiness and session capabilities, kernel side (#2043, #2077).
//
// What an agent can perceive and do in a conversation is limited by the
// channel and its media. Channel plugins declare it (readiness provider,
// meeting source, pushed snapshots, meeting lifecycle events); this hub is
// where the kernel asks them and passes pushes on.
//
// Rules:
//   - A provider RETURNS what is missing. A provider that throws is reported
//     as an error of the check, never as "ready".
//   - No meeting source, or one that knows nothing about a conversation, is
//     the chat baseline (text in, text out), never "nothing".
//   - Pushed snapshots and session events reach an engine only for
//     conversations its agent holds a message subscription for. Nothing is
//     stored; the only memory is a bounded set that removes the duplicates N
//     bots in one chat produce.

import type {
  ChannelReadinessProvider,
  MeetingSourceProvider,
  SessionEvent,
} from '@omadia/channel-sdk';
import type {
  ChannelConsentRepairOutcome,
  ChannelReadinessReport,
  ChannelReadinessRequest,
  SessionCapabilitySnapshot,
  SessionEventKind,
  SessionEventRecord,
} from '@omadia/plugin-api';

import type { MessageSubscription } from '../conversationMessages/store.js';
import type { ChannelProviderRegistry } from './providerRegistry.js';

const SESSION_EVENT_KINDS: readonly SessionEventKind[] = [
  'session_started',
  'session_ended',
  'participant_joined',
  'participant_left',
];
const MAX_ID_LENGTH = 512;
const MAX_PARTICIPANTS = 500;
const DEDUPE_CAPACITY = 2_000;

export interface SessionCapabilityHubDeps {
  readonly readiness: ChannelProviderRegistry<ChannelReadinessProvider>;
  readonly meetingSources: ChannelProviderRegistry<MeetingSourceProvider>;
  /** The agent's OWN identity on a channel; never the default bot. */
  readonly identityFor: (agentSlug: string, channelType: string) => { channelKey: string } | undefined;
  /** Active message subscriptions for a conversation (any agent). Absent (no
   *  database) = pushes are delivered to nobody. */
  readonly subscriptionsIn?: (channelType: string, conversationId: string) => readonly MessageSubscription[];
  /** Canonical principal of a channel user. */
  readonly principalOf: (user: { readonly id: string }) => string | undefined;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

interface Listener<T> {
  readonly agentSlug: string;
  /** `undefined` = the kernel itself. */
  readonly pluginId: string | undefined;
  /** Asked at every delivery. */
  readonly allowed: () => boolean;
  readonly handler: (value: T) => void | Promise<void>;
}

function isText(value: unknown, max = MAX_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function notReady(code: string, message: string): ChannelReadinessReport {
  return {
    ready: false,
    installed: false,
    canReadAllMessages: false,
    canPost: false,
    missing: [{ code, message }],
  };
}

export class SessionCapabilityHub {
  private snapshotListeners: Listener<SessionCapabilitySnapshot>[] = [];
  private eventListeners: Listener<SessionEventRecord>[] = [];
  private readonly seen = new Set<string>();
  private readonly log: (message: string) => void;
  private readonly now: () => Date;

  constructor(private readonly deps: SessionCapabilityHubDeps) {
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? (() => new Date());
  }

  // ── readiness ────────────────────────────────────────────────────────────

  /** `undefined` when the channel type has no readiness provider. */
  async checkIdentity(
    channelType: string,
    conversationId: string,
    channelKey: string,
  ): Promise<ChannelReadinessReport | undefined> {
    const provider = this.deps.readiness.get(channelType);
    if (!provider) return undefined;
    try {
      return await provider.check(conversationId, { asChannelKey: channelKey });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[readiness] ${channelType} check for ${conversationId} threw: ${message}`);
      return notReady('graph_error', `the readiness check failed: ${message}`);
    }
  }

  async check(request: ChannelReadinessRequest): Promise<ChannelReadinessReport> {
    if (!isText(request?.agentSlug, 128) || !isText(request.channelType, 64) || !isText(request.conversationId)) {
      return notReady('unsupported_conversation', 'agentSlug, channelType and conversationId are required');
    }
    const identity = this.deps.identityFor(request.agentSlug, request.channelType);
    if (!identity) {
      return notReady(
        'no_identity',
        `agent '${request.agentSlug}' has no identity of its own on '${request.channelType}'`,
      );
    }
    const report = await this.checkIdentity(request.channelType, request.conversationId, identity.channelKey);
    if (report) return report;
    // No readiness provider: the channel never declared that it can hand
    // over messages that do not mention the bot. That is not "ready" — a
    // subscription there would silence the agent and deliver nothing.
    return notReady(
      'unsupported_conversation',
      `channel '${request.channelType}' does not declare delivery of all messages (it registered no readiness provider)`,
    );
  }

  async repairConsent(request: ChannelReadinessRequest): Promise<ChannelConsentRepairOutcome> {
    if (!isText(request?.agentSlug, 128) || !isText(request.channelType, 64) || !isText(request.conversationId)) {
      return { outcome: 'failed', code: 'unsupported_conversation', message: 'agentSlug, channelType and conversationId are required' };
    }
    const identity = this.deps.identityFor(request.agentSlug, request.channelType);
    if (!identity) {
      return {
        outcome: 'failed',
        code: 'no_identity',
        message: `agent '${request.agentSlug}' has no identity of its own on '${request.channelType}'`,
      };
    }
    const provider = this.deps.readiness.get(request.channelType);
    if (!provider?.repairConsent) {
      return {
        outcome: 'failed',
        code: 'unsupported',
        message: `channel '${request.channelType}' offers no consent repair`,
      };
    }
    try {
      return await provider.repairConsent(request.conversationId, { asChannelKey: identity.channelKey });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[readiness] ${request.channelType} consent repair for ${request.conversationId} threw: ${message}`);
      return { outcome: 'failed', code: 'graph_error', message };
    }
  }

  // ── capabilities ─────────────────────────────────────────────────────────

  baseline(channelType: string, conversationId: string, sessionRef?: string): SessionCapabilitySnapshot {
    return {
      channelType,
      conversationId,
      ...(sessionRef !== undefined ? { sessionRef } : {}),
      modality: 'chat',
      inputs: ['text'],
      outputs: ['text'],
      capturedAt: this.now().toISOString(),
    };
  }

  async getSnapshot(request: {
    agentSlug: string;
    channelType: string;
    conversationId: string;
    sessionRef?: string;
  }): Promise<SessionCapabilitySnapshot> {
    const base = this.baseline(request.channelType, request.conversationId, request.sessionRef);
    const provider = this.deps.meetingSources.get(request.channelType);
    if (!provider) return base;
    const identity = this.deps.identityFor(request.agentSlug, request.channelType);
    try {
      const snapshot = await provider.snapshot(request.conversationId, {
        ...(identity ? { asChannelKey: identity.channelKey } : {}),
        ...(request.sessionRef !== undefined ? { sessionRef: request.sessionRef } : {}),
      });
      return snapshot ?? base;
    } catch (err) {
      this.log(
        `[capabilities] ${request.channelType} snapshot for ${request.conversationId} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return base;
    }
  }

  onSnapshot(
    agentSlug: string,
    pluginId: string | undefined,
    handler: (snapshot: SessionCapabilitySnapshot) => void | Promise<void>,
    allowed: () => boolean = () => true,
  ): () => void {
    const listener = { agentSlug, pluginId, handler, allowed };
    this.snapshotListeners = [...this.snapshotListeners, listener];
    return () => {
      this.snapshotListeners = this.snapshotListeners.filter((l) => l !== listener);
    };
  }

  onSessionEvent(
    agentSlug: string,
    pluginId: string | undefined,
    handler: (event: SessionEventRecord) => void | Promise<void>,
    allowed: () => boolean = () => true,
  ): () => void {
    const listener = { agentSlug, pluginId, handler, allowed };
    this.eventListeners = [...this.eventListeners, listener];
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  // ── channel side ─────────────────────────────────────────────────────────

  emitSnapshot(snapshot: SessionCapabilitySnapshot): void {
    if (
      snapshot === null ||
      typeof snapshot !== 'object' ||
      !isText(snapshot.channelType, 64) ||
      !isText(snapshot.conversationId) ||
      !Array.isArray(snapshot.inputs) ||
      !Array.isArray(snapshot.outputs)
    ) {
      this.log('[capabilities] dropped an invalid snapshot');
      return;
    }
    this.deliver(this.snapshotListeners, snapshot.channelType, snapshot.conversationId, snapshot, 'snapshot');
  }

  emitSessionEvent(event: SessionEvent): void {
    if (
      event === null ||
      typeof event !== 'object' ||
      !isText(event.channelType, 64) ||
      !isText(event.conversationId) ||
      !isText(event.sessionRef) ||
      !SESSION_EVENT_KINDS.includes(event.kind) ||
      typeof event.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(event.occurredAt))
    ) {
      this.log('[capabilities] dropped an invalid session event');
      return;
    }
    const subscribers = this.deps.subscriptionsIn?.(event.channelType, event.conversationId) ?? [];
    if (subscribers.length === 0) return; // nobody moderates here
    const participants = (Array.isArray(event.participants) ? event.participants : [])
      .filter((p) => p !== null && typeof p === 'object' && isText(p.id) && isText(p.kind, 64))
      .slice(0, MAX_PARTICIPANTS)
      .map((p) => {
        const principalId = this.deps.principalOf(p);
        return {
          kind: p.kind,
          id: p.id,
          ...(typeof p.displayName === 'string' ? { displayName: p.displayName.slice(0, 256) } : {}),
          ...(principalId !== undefined ? { principalId } : {}),
        };
      });
    const record: SessionEventRecord = {
      channelType: event.channelType,
      conversationId: event.conversationId,
      sessionRef: event.sessionRef,
      kind: event.kind,
      ...(event.kind === 'participant_joined' || event.kind === 'participant_left' ? { participants } : {}),
      occurredAt: new Date(event.occurredAt).toISOString(),
    };
    // N bots in one chat report the same platform event N times.
    const key = JSON.stringify([
      record.channelType,
      record.conversationId,
      record.sessionRef,
      record.kind,
      record.occurredAt,
      participants.map((p) => p.id.toLowerCase()).sort(),
    ]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > DEDUPE_CAPACITY) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.deliver(this.eventListeners, record.channelType, record.conversationId, record, 'session event', subscribers);
  }

  private deliver<T>(
    listeners: readonly Listener<T>[],
    channelType: string,
    conversationId: string,
    value: T,
    what: string,
    known?: readonly MessageSubscription[],
  ): void {
    const subscriptions = known ?? this.deps.subscriptionsIn?.(channelType, conversationId) ?? [];
    for (const listener of listeners) {
      const entitled = subscriptions.some(
        (s) =>
          s.agentSlug === listener.agentSlug &&
          (listener.pluginId === undefined || s.pluginId === listener.pluginId),
      );
      if (!entitled || !listener.allowed()) continue;
      void Promise.resolve()
        .then(() => listener.handler(value))
        .catch((err: unknown) => {
          this.log(
            `[capabilities] ${what} handler for '${listener.agentSlug}' failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }
}
