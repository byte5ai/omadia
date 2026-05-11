/**
 * `routinesIntegration` — kernel-published service that bundles the
 * routines feature's channel-facing surface. Channel plugins consume it
 * via `ctx.services.get<RoutinesIntegration>(ROUTINES_INTEGRATION_SERVICE_NAME)`.
 *
 * Before this contract existed, the kernel passed five separate callbacks
 * into the Teams ChannelPlugin's constructor. Constructor-injection blocks
 * the dynamic-import path the plugin-store flow needs (the resolver loads
 * `dist/plugin.js` and calls `activate(ctx, core)` — it has no knowledge
 * of plugin-specific Deps shapes). Bundling the callbacks into a single
 * service object lets the channel plugin late-resolve them via ctx.
 *
 * Published by the kernel only when a `RoutinesHandle` is available
 * (requires Postgres). Channel plugins MUST treat the service as
 * optional — when it's `undefined`, routines features are simply off.
 *
 * The smart-card builders return `{ contentType, content }` shaped to
 * fit BotFramework's `Attachment` shape (Teams Adaptive Card). Other
 * channels are free to ignore them.
 */

export const ROUTINES_INTEGRATION_SERVICE_NAME = 'routinesIntegration';

export interface RoutineCardAttachment {
  contentType: string;
  content: unknown;
}

export interface RoutineListAttachmentInput {
  filter: 'all' | 'active' | 'paused';
  totals: { all: number; active: number; paused: number };
  routines: Array<{
    id: string;
    name: string;
    cron: string;
    prompt: string;
    status: 'active' | 'paused';
    lastRunAt: string | null;
    lastRunStatus: 'ok' | 'error' | 'timeout' | null;
  }>;
}

export interface RoutinesIntegration {
  /**
   * Open a per-turn AsyncLocalStorage scope so the `manage_routine` tool
   * can attribute `create` to the active user and capture the channel-
   * native delivery handle. Channel plugins call this at the start of
   * every inbound turn, BEFORE invoking the chatAgent.
   */
  captureRoutineTurn(info: {
    tenant: string;
    userId: string;
    channel: string;
    conversationRef: unknown;
  }): void;

  /**
   * Register a channel-specific proactive sender so the routines runner
   * can deliver scheduled answers. Called once at activation; the
   * registered closure outlives every individual turn.
   */
  publishProactiveSend(
    channel: string,
    send: (
      conversationRef: unknown,
      message: { text: string },
      routine?: { id: string; name: string; cron: string },
    ) => Promise<void>,
  ): void;

  /**
   * Handle a button-click from a routine smart-card (Pause / Resume /
   * Trigger-now / Delete). Returns a short German confirmation string
   * the channel renders back into the chat.
   */
  handleRoutineAction(input: {
    action: 'pause' | 'resume' | 'trigger_now' | 'delete';
    id: string;
  }): Promise<string>;

  /**
   * Build a single-routine Adaptive Card attachment used as the proactive
   * delivery wrapper around the agent's prose answer.
   */
  buildRoutineSmartCardAttachment(input: {
    routine: { id: string; name: string; cron: string };
    body: string;
  }): RoutineCardAttachment;

  /**
   * Build a routine-list Adaptive Card attachment used as the sidecar
   * payload for `manage_routine.list` responses.
   */
  buildRoutineListSmartCardAttachment(
    input: RoutineListAttachmentInput,
  ): RoutineCardAttachment;
}
