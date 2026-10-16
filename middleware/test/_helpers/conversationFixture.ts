import type { KnowledgeGraph } from '@omadia/plugin-api';

/**
 * #1334 — one captured conversation turn with everything the capture
 * pipeline derives from it: the Turn (+ its Session), a Run with an
 * orchestrator tool call and a sub-agent invocation with its own tool call,
 * a Fact extracted from the turn, and a Plan with one step. Shared by the
 * Danger-Zone purge tests of both KG backends so they assert against the
 * same graph shape.
 *
 * Returns the external ids it wrote. `nodeCount` is the number of nodes the
 * turn adds on its own (excluding the Session, which turns of one scope share).
 */
export interface SeededTurn {
  turnId: string;
  factId: string;
  planId: string;
  /** Turn, Run, 2 ToolCalls, AgentInvocation, Fact, Plan, PlanStep. */
  nodeCount: number;
}

export async function seedConversationTurn(
  kg: KnowledgeGraph,
  opts: {
    scope: string;
    time: string;
    /** `Turn.userId` — for a Teams turn the AAD object id. */
    userId?: string;
    /** `RunTrace.userId` — the cluster-root omadia user id. Needs the
     *  User cluster to exist (see {@link seedTeamsIdentity}). */
    runUserId?: string;
    tag: string;
  },
): Promise<SeededTurn> {
  const { turnId } = await kg.ingestTurn({
    scope: opts.scope,
    time: opts.time,
    userMessage: `user message ${opts.tag}`,
    assistantAnswer: `assistant answer ${opts.tag}`,
    entityRefs: [],
    ...(opts.userId ? { userId: opts.userId } : {}),
  });
  await kg.ingestRun({
    turnId,
    scope: opts.scope,
    ...(opts.runUserId ? { userId: opts.runUserId } : {}),
    startedAt: opts.time,
    finishedAt: opts.time,
    durationMs: 10,
    status: 'success',
    iterations: 1,
    orchestratorToolCalls: [
      { callId: `oc-${opts.tag}`, toolName: 'memory', durationMs: 1, isError: false, agentContext: 'orchestrator' },
    ],
    agentInvocations: [
      {
        index: 0,
        agentName: 'sub',
        durationMs: 5,
        subIterations: 1,
        status: 'success',
        toolCalls: [
          { callId: `sc-${opts.tag}`, toolName: 'search', durationMs: 1, isError: false, agentContext: 'sub' },
        ],
      },
    ],
  });
  const factId = `fact:${opts.tag}`;
  await kg.ingestFacts([
    { factId, sourceTurnId: turnId, subject: opts.tag, predicate: 'said', object: 'something' },
  ]);
  const planId = `plan-${opts.tag}`;
  await kg.ingestPlan({
    planId,
    scope: opts.scope,
    turnExternalId: turnId,
    createdAt: opts.time,
    ...(opts.userId ? { userId: opts.userId } : {}),
  });
  await kg.upsertPlanStep({
    stepId: `step-${opts.tag}`,
    planId,
    scope: opts.scope,
    goal: 'do it',
    order: 0,
  });
  return { turnId, factId, planId, nodeCount: 8 };
}

/**
 * A Teams user as production records them: a ChannelIdentity carrying the AAD
 * object id, linked to a User cluster. Their Turns store the AAD id, their
 * Runs the omadia user id — the two spellings the user-axis purge has to join.
 */
export async function seedTeamsIdentity(
  kg: KnowledgeGraph,
  aadObjectId: string,
): Promise<string> {
  const { omadiaUserId } = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'teams',
    channelUserId: aadObjectId,
    aadObjectId,
  });
  return omadiaUserId;
}
