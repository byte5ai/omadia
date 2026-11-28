/**
 * Spec 2042 §5.4 / ADR-0018 (#2047) — the consultation broker: the kernel side
 * of the harness tool `consult(agent, request)`.
 *
 * Consulting adds a colleague's skill and judgement, never access. On every
 * call, fresh from the database:
 *  1. both agents exist, neither archetype omits consultation (facilitators);
 *  2. A's `may_consult`, B's `consultable`, the directed grant A→B, its
 *     channel scope;
 *  3. the audience floor is active for A's turn;
 *  4. the per-turn and per-day budgets (the day budget atomically with the
 *     call ledger), depth 1.
 * Then B runs its ordinary turn inside the consultation scope: tools only from
 * `grant.allowed_capabilities ∩ B's grants ∩ A's grants`, memory only when
 * `discreet` (and then bounded by A's audience), nothing written, no further
 * consultation, a timeout. A's request is checked first: B starts with A's
 * labels and receives them only when B's grants and the room cover them.
 * B's output is checked by the discretion rule for A and A's audience and
 * capped by the grant's disclosure levels (§5.11); a contribution capped at
 * `none` is regenerated from permitted context only (no memory, no tools),
 * so the visible answer cannot tell "withheld" from "does not exist".
 *
 * Cost: B's model calls are recorded under B's own turn id; the call ledger
 * links it to A's turn.
 */

import { randomUUID } from 'node:crypto';

import type { AgentSpeaker, Contribution } from '@omadia/plugin-api';
import { withoutFoldedAiDisclosure, type ChatTurnInput, type SemanticAnswer } from '@omadia/channel-sdk';
import {
  archetypeOmits,
  checkFlow,
  currentConsultation,
  decideDisclosure,
  existenceText,
  labelSummary,
  runAsConsultation,
  turnContext,
  unionLabels,
  violationSummary,
  type ConsultOutcome,
  type ConsultRefusalReason,
  type ConsultRequest,
  type ConsultTarget,
  type ConsultationPort,
  type ConsultationRunScope,
  type DiscretionAuditEntry,
  type LabelSet,
  today,
} from '@omadia/orchestrator';

import type {
  ActiveConsultationPair,
  ConsultationGrant,
  ConsultationStore,
} from './consultationStore.js';

/** What the broker needs of a registry entry (structural, for tests). */
export interface ConsultRegistryEntry {
  readonly agent: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly status?: string;
    readonly archetype?: string;
    readonly identityName?: string | null;
    readonly identityShortDescription?: string | null;
    readonly identityLanguage?: string | null;
  };
  readonly plugins: ReadonlyArray<{ readonly pluginId: string; readonly enabled: boolean }>;
  readonly built: {
    readonly bundle: { readonly agent: { chat(input: ChatTurnInput): Promise<SemanticAnswer> } };
  };
}

export interface ConsultRegistry {
  get(slug: string): ConsultRegistryEntry | undefined;
}

export type ConsultationBrokerStore = Pick<
  ConsultationStore,
  'getSwitches' | 'getGrant' | 'startCall' | 'finishCall' | 'listActivePairs'
>;

export interface ConsultationBrokerDeps {
  readonly store: ConsultationBrokerStore;
  readonly getRegistry: () => ConsultRegistry | undefined;
  readonly audit?: (entry: DiscretionAuditEntry) => void;
  /** Deadline of B's run. Default 120 s. */
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export interface ConsultationBroker extends ConsultationPort {
  /** Re-read the offering snapshot (after a grant or switch change, at boot). */
  refresh(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** How long the offering snapshot is trusted before a background refresh. */
const SNAPSHOT_TTL_MS = 30_000;
/** Channel type of a turn that names none (web chat, API without origin). */
const NO_ORIGIN_CHANNEL = 'web';

class ConsultTimeoutError extends Error {}

function speakerOf(entry: ConsultRegistryEntry): AgentSpeaker {
  return {
    kind: 'agent',
    agentId: entry.agent.id,
    slug: entry.agent.slug,
    displayName: entry.agent.identityName?.trim() || entry.agent.name,
  };
}

/** Plugin ids an agent holds an enabled grant for. */
function grantedSystems(entry: ConsultRegistryEntry): Set<string> {
  return new Set(entry.plugins.filter((p) => p.enabled).map((p) => p.pluginId));
}

/** `grant.allowed_capabilities ∩ B's grants ∩ A's grants`. */
export function consultationEnvelope(
  grant: Pick<ConsultationGrant, 'allowedCapabilities'>,
  from: ConsultRegistryEntry,
  to: ConsultRegistryEntry,
): Set<string> {
  const fromSystems = grantedSystems(from);
  const toSystems = grantedSystems(to);
  return new Set(grant.allowedCapabilities.filter((id) => fromSystems.has(id) && toSystems.has(id)));
}

function frameRequest(from: AgentSpeaker, request: string): string {
  return (
    `Your colleague ${from.displayName} asks you for a contribution. Answer as yourself; ` +
    `your answer is shown to the people in ${from.displayName}'s conversation, attributed to you.\n\n` +
    request
  );
}

function failedText(speaker: AgentSpeaker, locale: string | undefined): string {
  return locale?.toLowerCase().startsWith('de')
    ? `${speaker.displayName} konnte gerade nicht antworten.`
    : `${speaker.displayName} could not answer right now.`;
}

export function createConsultationBroker(deps: ConsultationBrokerDeps): ConsultationBroker {
  const log = deps.log ?? (() => undefined);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let pairs: readonly ActiveConsultationPair[] = [];
  let refreshedAt = 0;
  let refreshing: Promise<void> | undefined;

  const refused = (reason: ConsultRefusalReason, message: string): ConsultOutcome => ({
    kind: 'refused',
    reason,
    message,
  });

  async function runColleague(
    entry: ConsultRegistryEntry,
    scope: ConsultationRunScope,
    request: ConsultRequest,
    from: AgentSpeaker,
  ): Promise<SemanticAnswer> {
    const parent = turnContext.current();
    const turn: ChatTurnInput = {
      userMessage: frameRequest(from, request.request),
      // B runs in A's conversation and for A's audience. No `sessionScope`:
      // nothing of the run is logged, ingested or promoted. The user id only
      // with `discreet` memory, where recall needs it.
      ...(request.origin ? { origin: request.origin } : {}),
      // #2379 / ADR-0350 — B answers A's user, so its own frozen clock reads in
      // that person's zone, as A's did.
      ...(parent?.userTimeZone ? { userTimeZone: parent.userTimeZone } : {}),
      ...(scope.memoryAccess === 'discreet' && request.userId ? { userId: request.userId } : {}),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // B's run cannot be aborted: from now on it gets no tool, and its
        // answer is discarded (see `consultationAllowsTool`).
        scope.result.expired = true;
        reject(new ConsultTimeoutError());
      }, timeoutMs);
      timer.unref?.();
    });
    // A clean outer scope: A's roster and MCP caller identity carry over (B
    // answers in A's room, for A's user); A's raw-result taps (canvas sink,
    // routine capture) do not, so none of B's raw data leaves its shield.
    const outer = {
      turnId: '',
      // #2379 — outside a turn, today in the turn zone, never a UTC date.
      turnDate: parent?.turnDate ?? today(),
      ...(parent?.chatParticipants ? { chatParticipants: parent.chatParticipants } : {}),
      ...(parent?.mcpUserKey ? { mcpUserKey: parent.mcpUserKey } : {}),
      // ADR-0206 — a consultation inside an unattended run is unattended too.
      ...(parent?.mcpUnattended ? { mcpUnattended: true } : {}),
      ...(parent?.audienceFloor ? { audienceFloor: parent.audienceFloor } : {}),
    };
    try {
      return await Promise.race([
        turnContext.run(outer, () =>
          runAsConsultation(scope, () => entry.built.bundle.agent.chat(turn)),
        ),
        deadline,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function check(
    request: ConsultRequest,
  ): Promise<
    | { ok: false; outcome: ConsultOutcome }
    | { ok: true; from: ConsultRegistryEntry; to: ConsultRegistryEntry; grant: ConsultationGrant; channelType: string }
  > {
    // Depth 1, enforced here as well as by the tool: no consultation starts
    // inside a consultation run, whichever orchestrator asks.
    if (currentConsultation()) {
      return { ok: false, outcome: refused('depth', 'a consultation cannot start inside another consultation.') };
    }
    const registry = deps.getRegistry();
    if (!registry) return { ok: false, outcome: refused('unavailable', 'the agent registry is not available.') };
    const from = registry.get(request.fromAgentSlug);
    const to = registry.get(request.toAgentSlug);
    if (!from) return { ok: false, outcome: refused('unavailable', 'your own agent is not active.') };
    if (!to || to.agent.status === 'disabled') {
      return { ok: false, outcome: refused('unknown_agent', `there is no active colleague '${request.toAgentSlug}'.`) };
    }
    if (from.agent.id === to.agent.id) {
      return { ok: false, outcome: refused('no_grant', 'an agent cannot consult itself.') };
    }
    if (archetypeOmits(from.agent, 'consultation') || archetypeOmits(to.agent, 'consultation')) {
      return { ok: false, outcome: refused('archetype', 'facilitators neither consult nor are consulted.') };
    }
    const [fromSwitches, toSwitches, grant] = await Promise.all([
      deps.store.getSwitches(from.agent.id),
      deps.store.getSwitches(to.agent.id),
      deps.store.getGrant(from.agent.id, to.agent.id),
    ]);
    if (!fromSwitches?.mayConsult) {
      return { ok: false, outcome: refused('may_not_consult', 'you are not allowed to consult colleagues.') };
    }
    if (!toSwitches?.consultable) {
      return { ok: false, outcome: refused('not_consultable', `${to.agent.slug} does not take consultations.`) };
    }
    if (!grant) {
      return { ok: false, outcome: refused('no_grant', `you have no grant to consult ${to.agent.slug}.`) };
    }
    const channelType = request.origin?.channelType ?? NO_ORIGIN_CHANNEL;
    if (grant.channelScope !== null && !grant.channelScope.includes(channelType)) {
      return {
        ok: false,
        outcome: refused('channel_not_granted', `you may not consult ${to.agent.slug} in this channel.`),
      };
    }
    // Spec §5.4 step 5 — no consultation without an active audience floor.
    if (!turnContext.current()?.audienceFloor) {
      return {
        ok: false,
        outcome: refused('no_audience_floor', 'the audience floor is not active, so no consultation can run.'),
      };
    }
    if (request.callsThisTurn >= grant.maxCallsPerTurn) {
      return {
        ok: false,
        outcome: refused('turn_budget', `you reached the limit of consultations of ${to.agent.slug} for this turn.`),
      };
    }
    // Spec §5.11 — the request carries everything A's turn has read: B may
    // receive it only when B's own grants cover it and the room may know it.
    const inbound = checkFlow(request.labels, {
      kind: 'agent',
      agentId: to.agent.id,
      grantedSystems: grantedSystems(to),
      ...(request.contextKey !== undefined ? { contextKey: request.contextKey } : {}),
      readers: request.readers,
    });
    if (!inbound.allowed) {
      deps.audit?.({
        turnId: request.fromTurnId,
        agentSlug: from.agent.slug,
        egress: 'agent',
        target: to.agent.slug,
        allowed: false,
        labels: labelSummary(request.labels),
        violations: violationSummary(inbound),
      });
      return {
        ok: false,
        outcome: refused(
          'discretion',
          `this turn holds information ${to.agent.slug} may not receive, so it cannot be consulted here.`,
        ),
      };
    }
    return { ok: true, from, to, grant, channelType };
  }

  return {
    targetsFor(agentSlug: string): readonly ConsultTarget[] {
      // The snapshot only decides whether `consult` is offered; every call
      // re-checks fresh. Stale → refresh in the background, answer from the
      // last snapshot now (a tool list is built synchronously).
      if (Date.now() - refreshedAt > SNAPSHOT_TTL_MS && !refreshing) {
        refreshing = this.refresh().finally(() => {
          refreshing = undefined;
        });
      }
      const registry = deps.getRegistry();
      const targets: ConsultTarget[] = [];
      for (const pair of pairs) {
        if (pair.fromSlug !== agentSlug) continue;
        const entry = registry?.get(pair.toSlug);
        if (!entry || archetypeOmits(entry.agent, 'consultation')) continue;
        const description = entry.agent.identityShortDescription?.trim();
        targets.push({
          slug: entry.agent.slug,
          displayName: speakerOf(entry).displayName,
          ...(description ? { description } : {}),
        });
      }
      return targets;
    },

    async refresh(): Promise<void> {
      try {
        pairs = await deps.store.listActivePairs();
        refreshedAt = Date.now();
      } catch (err) {
        refreshedAt = Date.now();
        // Keep the last snapshot: offering is a hint, every call re-checks.
        log(`[consultation] refresh failed, keeping ${String(pairs.length)} pair(s): ${String(err)}`);
      }
    },

    async consult(request: ConsultRequest): Promise<ConsultOutcome> {
      const checked = await check(request);
      if (!checked.ok) {
        log(`[consultation] ${request.fromAgentSlug} → ${request.toAgentSlug} refused: ${checked.outcome.kind === 'refused' ? checked.outcome.reason : ''}`);
        return checked.outcome;
      }
      const { from, to, grant, channelType } = checked;
      const fromSpeaker = speakerOf(from);
      const toSpeaker = speakerOf(to);
      const locale = to.agent.identityLanguage ?? undefined;
      const callId = randomUUID();
      const id = `c${String(request.sequence)}`;
      const started = await deps.store.startCall({
        id: callId,
        fromAgentId: from.agent.id,
        toAgentId: to.agent.id,
        fromTurnId: request.fromTurnId,
        channelType,
        maxCallsPerDay: grant.maxCallsPerDay,
      });
      if (!started) {
        return refused('day_budget', `you reached today's limit of consultations of ${to.agent.slug}.`);
      }

      const fromSystems = grantedSystems(from);
      const attempt = async (allowed: ReadonlySet<string>, memoryAccess: 'none' | 'discreet') => {
        const scope: ConsultationRunScope = {
          agentSlug: to.agent.slug,
          fromAgentSlug: from.agent.slug,
          fromTurnId: request.fromTurnId,
          callId,
          allowedPluginIds: allowed,
          memoryAccess,
          initialLabels: request.labels,
          readers: request.readers,
          result: {},
        };
        const answer = await runColleague(to, scope, request, fromSpeaker);
        // Fail closed: a run that reported no labels counts as unreadable.
        const labels: LabelSet =
          scope.result.labels ?? { labels: [{ kind: 'context', key: 'unreadable', readers: { kind: 'unknown' } }] };
        const flow = checkFlow(labels, {
          kind: 'agent',
          agentId: from.agent.id,
          grantedSystems: fromSystems,
          ...(request.contextKey !== undefined ? { contextKey: request.contextKey } : {}),
          readers: request.readers,
        });
        const outcome = decideDisclosure({
          contribution: labels,
          requester: request.labels,
          requesterSystems: fromSystems,
          policy: grant.disclosure,
          flow,
        });
        deps.audit?.({
          turnId: request.fromTurnId,
          agentSlug: to.agent.slug,
          egress: 'agent',
          target: from.agent.slug,
          allowed: flow.allowed,
          labels: labelSummary(labels),
          violations: violationSummary(flow),
        });
        const turnId = (answer as { turnId?: unknown }).turnId;
        return {
          answer,
          labels,
          outcome,
          // The masked view exists only when B's shield masked the answer.
          wireAnswer: scope.result.shielded === true ? scope.result.wireAnswer : undefined,
          toTurnId: typeof turnId === 'string' ? turnId : undefined,
        };
      };

      const finish = async (
        status: 'delivered' | 'withheld' | 'failed',
        outcome: string,
        toTurnId: string | undefined,
      ): Promise<void> => {
        await deps.store
          .finishCall(callId, { status, outcome, ...(toTurnId ? { toTurnId } : {}) })
          .catch((err: unknown) => log(`[consultation] ledger update failed for ${callId}: ${String(err)}`));
      };

      const answered = (contribution: Contribution, labels: LabelSet): ConsultOutcome => ({
        kind: 'answered',
        contribution,
        labels,
      });

      try {
        const envelope = consultationEnvelope(grant, from, to);
        let run = await attempt(envelope, grant.memoryAccess);
        if (run.outcome.kind === 'none') {
          // Regenerate from permitted context only: no memory and no tools.
          // Without tools the second run cannot repeat a write the first one
          // made, and it sees nothing beyond A's request.
          run = await attempt(new Set<string>(), 'none');
          if (run.outcome.kind !== 'deliver') {
            await finish('withheld', 'none', run.toTurnId);
            return answered(
              { id, speaker: toSpeaker, text: failedText(toSpeaker, locale), status: 'failed' },
              request.labels,
            );
          }
        }
        if (run.outcome.kind === 'existence') {
          await finish('withheld', 'existence', run.toTurnId);
          // A learns only that B can help: nothing of B's labels joins A's turn.
          return answered(
            { id, speaker: toSpeaker, text: existenceText(toSpeaker.displayName, locale), status: 'delivered' },
            request.labels,
          );
        }
        if (run.outcome.kind !== 'deliver') {
          await finish('failed', 'undeliverable', run.toTurnId);
          return answered(
            { id, speaker: toSpeaker, text: failedText(toSpeaker, locale), status: 'failed' },
            request.labels,
          );
        }
        // The contribution carries B's words, not B's AI-disclosure sentence:
        // A's message is marked once, by A's own disclosure (spec §5.14).
        const userView = withoutFoldedAiDisclosure(run.answer.text, run.answer.aiDisclosure);
        if (run.outcome.view === 'redacted' && run.wireAnswer === undefined) {
          // No masked view (B ran without a shield): `redacted` must not
          // become `full`, so A learns only that B can help.
          await finish('withheld', 'existence', run.toTurnId);
          return answered(
            { id, speaker: toSpeaker, text: existenceText(toSpeaker.displayName, locale), status: 'delivered' },
            request.labels,
          );
        }
        const text = run.outcome.view === 'redacted' ? (run.wireAnswer ?? '') : userView;
        if (!text.trim()) {
          await finish('failed', 'empty', run.toTurnId);
          return answered(
            { id, speaker: toSpeaker, text: failedText(toSpeaker, locale), status: 'failed' },
            request.labels,
          );
        }
        await finish('delivered', run.outcome.view, run.toTurnId);
        return answered({ id, speaker: toSpeaker, text, status: 'delivered' }, unionLabels(request.labels, run.labels));
      } catch (err) {
        const reason = err instanceof ConsultTimeoutError ? 'timeout' : 'error';
        log(`[consultation] ${from.agent.slug} → ${to.agent.slug} ${reason}: ${err instanceof Error ? err.name : 'unknown'}`);
        await finish('failed', reason, undefined);
        // A failed delivery is shown as failed, never dropped (spec §5.4 step 4).
        return answered(
          { id, speaker: toSpeaker, text: failedText(toSpeaker, locale), status: 'failed' },
          request.labels,
        );
      }
    },
  };
}
