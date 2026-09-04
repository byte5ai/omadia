import type { PluginContext } from '@omadia/plugin-api';

import {
  DISCUSSION_PARTNERS_PROMPT_DOC,
  DISCUSSION_PROMPT_DOC,
  createDiscussionPartnersHandler,
  createDiscussionStartHandler,
  discussionPartnersToolSpec,
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

  // RESOLVE LAZILY, PER CALL — NOT ONCE AT ACTIVATION.
  //
  // `optional_requires` contributes no activation edge, so the kernel may not
  // have published `conductorDiscussions` yet when this activate() runs. Caching
  // that first lookup froze `undefined` into the handler for the process's whole
  // life: the tool then answered "discussions are not available on this
  // deployment" forever, on a kernel that published the capability seconds
  // later. Observed in production on the very first live attempt. The
  // ServicesAccessor doc calls this out explicitly — resolve at first use.
  const resolveDiscussions = (): DiscussionsCapability | undefined =>
    ctx.services.getOptional<DiscussionsCapability>(CONDUCTOR_DISCUSSIONS_SERVICE_NAME);

  const disposeTool = ctx.tools.register(
    discussionStartToolSpec,
    createDiscussionStartHandler({
      resolveDiscussions,
      log: (msg) => ctx.log(msg),
    }),
    { promptDoc: DISCUSSION_PROMPT_DOC },
  );

  const disposePartners = ctx.tools.register(
    discussionPartnersToolSpec,
    createDiscussionPartnersHandler({ resolveDiscussions, log: (msg) => ctx.log(msg) }),
    { promptDoc: DISCUSSION_PARTNERS_PROMPT_DOC },
  );

  // Seam state is reported as "checked at call time" rather than a boot-time
  // verdict, precisely because a boot-time verdict is what went wrong.
  ctx.log('[discussion] ready (capability resolved per call)');

  return {
    async close(): Promise<void> {
      ctx.log('[discussion] deactivating');
      disposeTool();
      disposePartners();
    },
  };
}
