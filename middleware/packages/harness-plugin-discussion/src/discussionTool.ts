import type { NativeToolSpec } from '@omadia/plugin-api';
import { z } from 'zod';

/**
 * `discussion_start` — the chat-side entry point to an agent topic discussion.
 *
 * Deliberately minimal surface. The tool takes WHO to discuss with and WHAT
 * about; it does not take a conversation, because the kernel resolves that from
 * the turn being answered. An agent therefore cannot open a discussion anywhere
 * but in the chat it was addressed in, no matter what the model asks for.
 *
 * Result shape (success): a short confirmation sentence naming the partner and
 * the bound. Errors come back as `Error: <message>` — the orchestrator's
 * convention, so the model can explain the refusal to the person who asked
 * instead of the turn collapsing.
 */

export const DISCUSSION_START_TOOL_NAME = 'discussion_start';

const DiscussionStartInputSchema = z.object({
  with_agent: z
    .string()
    .min(1, 'with_agent must be a non-empty agent slug')
    .max(64, 'with_agent must be ≤ 64 chars')
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u, 'with_agent must be an agent slug'),
  topic: z.string().min(1, 'topic must be non-empty').max(2000, 'topic must be ≤ 2000 chars'),
  guiding_question: z.string().min(1).max(2000).optional(),
});

export type DiscussionStartInput = z.infer<typeof DiscussionStartInputSchema>;

export const discussionStartToolSpec: NativeToolSpec = {
  name: DISCUSSION_START_TOOL_NAME,
  description:
    "Open a visible, bounded topic discussion with ANOTHER agent in this chat. The two of you then post in turn under your own names, responding to each other, for at most seven contributions before you write a closing summary. Use it when the person asks two agents to discuss, compare, or reconcile something across domains — 'discuss X with the accounting agent', 'get HR's and finance's view on Y'. Do NOT use it to answer a question you can answer yourself, and do NOT use it to talk to a person. Call it at most once per request; after it returns, reply with one short sentence and stop — your first contribution is posted by the discussion itself, not by this turn.",
  input_schema: {
    type: 'object',
    properties: {
      with_agent: {
        type: 'string',
        description:
          "Slug of the agent to discuss with (e.g. 'accounting'). It must be a different agent, and it needs its own bot in this chat — otherwise the start is refused.",
      },
      topic: {
        type: 'string',
        description:
          'What the discussion is about, in the language of the conversation. One or two sentences of substance, not a headline.',
      },
      guiding_question: {
        type: 'string',
        description:
          'The single question the exchange should answer. Defaults to the topic when omitted — pass it whenever the person named something more specific than the subject.',
      },
    },
    required: ['with_agent', 'topic'],
  },
};

export const DISCUSSION_PROMPT_DOC = [
  'discussion_start opens a real, visible conversation between you and another agent in this chat.',
  'Both of you post under your own bot identities; there is no need to label who is speaking.',
  'It is bounded (at most seven contributions plus a summary) and can be stopped by an operator.',
  'Start one only when the person actually asked for two agents to talk — otherwise just answer.',
].join(' ');

/**
 * The kernel seam. Note what is NOT in the signature: neither the conversation
 * nor the opening agent. A tool plugin is registered once per process and
 * cannot know which agent invoked it or where — so the kernel reads both off
 * the turn being answered instead of taking this plugin's word for them.
 */
export interface DiscussionsCapability {
  startHere(input: {
    agentB: string;
    topic: string;
    guidingQuestion?: string;
  }): Promise<{ runId: string; workflowSlug: string; expiresAt: string }>;
}

export function createDiscussionStartHandler(deps: {
  /** Absent = the kernel seam is missing; the tool says so instead of throwing. */
  discussions: DiscussionsCapability | undefined;
  log?: (msg: string) => void;
}): (raw: unknown) => Promise<string> {
  return async (raw: unknown): Promise<string> => {
    const parsed = DiscussionStartInputSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return `Error: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid input'}`;
    }
    const input = parsed.data;

    if (!deps.discussions) {
      return 'Error: agent discussions are not available on this deployment (the kernel publishes no conductorDiscussions capability — it needs Postgres and a recent core).';
    }

    try {
      const handle = await deps.discussions.startHere({
        agentB: input.with_agent,
        topic: input.topic,
        ...(input.guiding_question !== undefined ? { guidingQuestion: input.guiding_question } : {}),
      });
      deps.log?.(`[discussion] opened a discussion with '${input.with_agent}' (run ${handle.runId})`);
      return JSON.stringify({
        started: true,
        with_agent: input.with_agent,
        topic: input.topic,
        max_contributions: 7,
        note: 'The discussion posts itself into this chat. Reply with one short sentence and stop; do not repeat the topic or write the first contribution here.',
      });
    } catch (err) {
      // Every refusal from the kernel is a named, explainable outcome — hand it
      // to the model as prose so it can tell the person WHY, rather than
      // silently answering as if nothing had been asked.
      const message = err instanceof Error ? err.message : String(err);
      deps.log?.(`[discussion] start refused: ${message}`);
      return `Error: ${message}`;
    }
  };
}
