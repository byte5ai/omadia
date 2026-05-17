import type {
  ChannelNotificationHandler,
  NotificationDispatchResult,
  NotificationPayload,
  ResolvedNotificationPayload,
} from '@omadia/plugin-api';

/**
 * Kernel-side fan-out for plugin-emitted notifications.
 *
 * V1 contract: every registered channel handler receives every dispatched
 * payload (broadcast model). Per-user channel preference + handler
 * targeting lands when the operator-side channel-routing service ships.
 *
 * Handler errors are isolated: a throw in one channel does NOT abort the
 * fan-out; the failure surfaces in the returned `DispatchResult.failed`
 * list so the calling plugin can surface a partial-delivery state if it
 * cares. The router itself never throws on dispatch.
 *
 * Channel registration is keyed by channelId (`'teams'`, `'telegram'`,
 * etc.). Re-registering an already-active channelId throws — channel
 * plugins MUST dispose their previous handle in their `close()` before a
 * hot-swap re-activates them, mirroring the route registry contract.
 */
export class NotificationRouter {
  private readonly handlers = new Map<string, ChannelNotificationHandler>();

  registerChannel(
    channelId: string,
    handler: ChannelNotificationHandler,
  ): () => void {
    if (typeof channelId !== 'string' || channelId.length === 0) {
      throw new Error(
        `NotificationRouter.registerChannel: channelId must be a non-empty string`,
      );
    }
    if (typeof handler !== 'function') {
      throw new Error(
        `NotificationRouter.registerChannel: handler for '${channelId}' must be a function`,
      );
    }
    if (this.handlers.has(channelId)) {
      throw new Error(
        `NotificationRouter: channel '${channelId}' already has a notification handler — dispose the previous registration before re-registering (hot-swap leak)`,
      );
    }
    this.handlers.set(channelId, handler);
    return () => {
      // Idempotent dispose: only delete if still the same handler ref.
      // A later registration that replaces this entry must NOT be
      // dropped by a stale dispose closure from the previous owner.
      if (this.handlers.get(channelId) === handler) {
        this.handlers.delete(channelId);
      }
    };
  }

  /**
   * Dispatch a notification to every registered channel. The pluginId
   * is supplied by the caller (the kernel-side PluginContext accessor
   * injects it from `agentId`); plugins themselves never set it.
   */
  async dispatch(
    pluginId: string,
    payload: NotificationPayload,
  ): Promise<NotificationDispatchResult> {
    const resolved: ResolvedNotificationPayload = {
      pluginId,
      title: payload.title,
      body: payload.body,
      ...(payload.deepLink !== undefined ? { deepLink: payload.deepLink } : {}),
      recipients: payload.recipients ?? 'broadcast',
    };
    const delivered: string[] = [];
    const failed: { channelId: string; error: string }[] = [];
    // Snapshot entries so concurrent registrations during a dispatch
    // don't change the iteration set mid-flight.
    const entries = Array.from(this.handlers.entries());
    // Diagnostic — surfaces double-dispatch / double-handler patterns
    // in the log without requiring a debug-build. The format is greppable:
    //   [notification-router] dispatch plugin=<id> handlers=<n>(<ids>)
    console.log(
      `[notification-router] dispatch plugin=${pluginId} title=${JSON.stringify(payload.title)} handlers=${entries.length}(${entries.map(([id]) => id).join(',')})`,
    );
    for (const [channelId, handler] of entries) {
      try {
        await handler(resolved);
        delivered.push(channelId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ channelId, error: message });
      }
    }
    return {
      delivered,
      failed,
      anyHandlerPresent: entries.length > 0,
    };
  }

  /** Diagnostic: which channelIds have an active handler today. */
  list(): readonly string[] {
    return Array.from(this.handlers.keys());
  }
}
