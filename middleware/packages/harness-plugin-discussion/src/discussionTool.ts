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
    "Open a visible, bounded topic discussion with ANOTHER agent in this chat. The two of you then post in turn under your own names, responding to each other, for at most seven contributions before you write a closing summary. Use it when the person asks two agents to discuss, compare, or reconcile something across domains — 'discuss X with the accounting agent', 'get HR's and finance's view on Y'. If you do not know the partner's slug for certain, call discussion_partners FIRST — do not guess and do not tell the person the agent is unknown before you have checked. A result starting with 'Error:' means nothing was started; report that in one sentence and never claim otherwise. Do NOT use this to answer a question you can answer yourself, and do NOT use it to talk to a person. Call it at most once per request; after a successful call, reply with one short sentence and stop — your first contribution is posted by the discussion itself, not by this turn.",
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

export const DISCUSSION_PARTNERS_TOOL_NAME = 'discussion_partners';

export const discussionPartnersToolSpec: NativeToolSpec = {
  name: DISCUSSION_PARTNERS_TOOL_NAME,
  description:
    'List the agents you could hold a discussion with IN THIS CHAT: their slug and the name people see on their bot. Call this FIRST whenever someone asks you to discuss something with another agent and you are not certain of that agent\'s slug — never guess a slug, and never claim an agent does not exist without checking here. Takes no arguments.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export const DISCUSSION_PARTNERS_PROMPT_DOC = [
  'discussion_partners answers "who is in this chat that I could discuss with".',
  'The person will name a partner the way they see them — the bot name shown in the chat, not a slug.',
  'Look the name up here and pass the matching slug to discussion_start.',
].join(' ');

export const DISCUSSION_PROMPT_DOC = [
  'discussion_start opens a real, visible conversation between you and another agent in this chat.',
  'Both of you post under your own bot identities; there is no need to label who is speaking.',
  'It is bounded (at most seven contributions plus a summary) and can be stopped by an operator.',
  'Start one only when the person actually asked for two agents to talk — otherwise just answer.',
  'If you are unsure of the partner\'s slug, call discussion_partners first instead of guessing.',
  'If discussion_start returns a string beginning with "Error:", the discussion did NOT start:',
  'say what went wrong in one sentence. Never claim a discussion is running when it is not.',
].join(' ');

/**
 * The kernel seam. Note what is NOT in the signature: neither the conversation
 * nor the opening agent. A tool plugin is registered once per process and
 * cannot know which agent invoked it or where — so the kernel reads both off
 * the turn being answered instead of taking this plugin's word for them.
 */
export interface DiscussionPartner {
  slug: string;
  /** The bot's display name as people see it in the chat (e.g. 'Karen'). */
  name: string;
}

export interface DiscussionsCapability {
  startHere(input: {
    agentB: string;
    topic: string;
    guidingQuestion?: string;
  }): Promise<{ runId: string; workflowSlug: string; expiresAt: string }>;
  /** Who could take part in THIS chat — agents with their own bot present here. */
  partnersHere(): Promise<readonly DiscussionPartner[]>;
}

/** Resolved per call, never cached: `optional_requires` creates no activation
 *  edge, so the capability may appear after this plugin has activated. */
export type ResolveDiscussions = () => DiscussionsCapability | undefined;

const NOT_AVAILABLE =
  'Error: agent discussions are not available on this deployment (the kernel publishes no conductorDiscussions capability — it needs Postgres and a recent core).';

export function createDiscussionStartHandler(deps: {
  resolveDiscussions: ResolveDiscussions;
  log?: (msg: string) => void;
}): (raw: unknown) => Promise<string> {
  return async (raw: unknown): Promise<string> => {
    const parsed = DiscussionStartInputSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return `Error: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid input'}`;
    }
    const input = parsed.data;

    const discussions = deps.resolveDiscussions();
    if (!discussions) {
      deps.log?.('[discussion] start refused: capability unavailable');
      return NOT_AVAILABLE;
    }

    try {
      const handle = await discussions.startHere({
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
      // An unknown partner is the one refusal the model can fix by itself, so
      // it comes back WITH the candidates rather than as a bare no. Karen's
      // first live attempt failed exactly here: she guessed at the roster,
      // guessed wrong, and gave up without ever calling the tool.
      const partners = await discussions.partnersHere().catch(() => []);
      const list =
        partners.length > 0
          ? ` Available in this chat: ${partners.map((p) => `${p.slug} (${p.name})`).join(', ')}.`
          : '';
      return `Error: ${message}${list}`;
    }
  };
}

export function createDiscussionPartnersHandler(deps: {
  resolveDiscussions: ResolveDiscussions;
  log?: (msg: string) => void;
}): (raw: unknown) => Promise<string> {
  return async (): Promise<string> => {
    const discussions = deps.resolveDiscussions();
    if (!discussions) return NOT_AVAILABLE;
    try {
      const partners = await discussions.partnersHere();
      deps.log?.(`[discussion] partners here: ${partners.map((p) => p.slug).join(', ') || 'none'}`);
      return JSON.stringify({
        partners,
        note:
          partners.length > 0
            ? 'Pass one of these `slug` values as with_agent. The name is what people see in the chat.'
            : 'No other agent has its own bot in this chat, so no discussion can be held here. Say so plainly.',
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}
