import type { PluginContext } from '@omadia/plugin-api';

import {
  DISCUSSION_PROMPT_DOC,
  createDiscussionStartHandler,
  discussionStartToolSpec,
} from './discussionTool.js';
import type { DiscussionsCapability } from './discussionTool.js';

/**
 * @omadia/plugin-discussion — plugin entry point.
 *
 * Grant this to every agent that should be able to OPEN a topic discussion
 * from a chat. Granting is the whole permission model: the tool exists for
 * exactly the agents an operator gave it to, and the discussion it opens is
 * bounded, visible and stoppable.
 *
 * Activation is unconditional and configuration-free. When the kernel seam is
 * missing — an older core, or a Postgres-less deployment where the ephemeral
 * machinery is inert — the tool still registers and answers with a plain
 * sentence saying discussions are unavailable. That is deliberately louder
 * than not registering: the model would otherwise silently ignore a request
 * the person can see it received.
 */

export const CONDUCTOR_DISCUSSIONS_SERVICE_NAME = 'conductorDiscussions';

export interface DiscussionPluginHandle {
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<DiscussionPluginHandle> {
  ctx.log('[discussion] activating');

  // `optional_requires` in the manifest is what grants this lookup; a kernel
  // that does not publish the capability yields undefined rather than throwing.
  const discussions = ctx.services.getOptional?.<DiscussionsCapability>(
    CONDUCTOR_DISCUSSIONS_SERVICE_NAME,
  );
  if (!discussions) {
    ctx.log(
      '[discussion] kernel publishes no conductorDiscussions capability — the tool is registered but will explain that discussions are unavailable',
    );
  }

  const disposeTool = ctx.tools.register(
    discussionStartToolSpec,
    createDiscussionStartHandler({
      discussions,
      log: (msg) => ctx.log(msg),
    }),
    { promptDoc: DISCUSSION_PROMPT_DOC },
  );

  ctx.log(`[discussion] ready (seam=${discussions ? 'on' : 'absent'})`);

  return {
    async close(): Promise<void> {
      ctx.log('[discussion] deactivating');
      disposeTool();
    },
  };
}
