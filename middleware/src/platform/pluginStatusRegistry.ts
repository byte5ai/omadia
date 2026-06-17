import type { PluginActionStatus } from '@omadia/plugin-api';

/**
 * Kernel-held, in-memory store of each plugin's operator-facing action status
 * (spec 004). Plugins push via `ctx.status.report(...)`; the admin API reads
 * it to surface a badge on the plugin card + a banner on the detail page.
 *
 * In-memory by design (like `pendingFlows`): a status is ephemeral runtime
 * health, not durable state. It is re-reported on each `activate()`, so a
 * restart self-heals once the plugin's discovery runs again. Cleared when a
 * plugin deactivates so an uninstalled plugin leaves no stale signal.
 */
export class PluginStatusRegistry {
  private readonly statuses = new Map<string, PluginActionStatus>();

  /** Replace the plugin's status. `state: 'ok'` is stored but renders nothing
   *  (the UI only badges `needs_action` / `error`). */
  set(pluginId: string, status: PluginActionStatus): void {
    this.statuses.set(pluginId, status);
  }

  /** Drop the plugin's status entirely (equivalent to `ok` for the UI). */
  clear(pluginId: string): void {
    this.statuses.delete(pluginId);
  }

  get(pluginId: string): PluginActionStatus | undefined {
    return this.statuses.get(pluginId);
  }
}
