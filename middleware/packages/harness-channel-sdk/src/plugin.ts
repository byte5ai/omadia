import type { PluginContext } from '@omadia/plugin-api';

import type { CoreApi } from './coreApi.js';

/**
 * Runtime contract for channel plugins.
 *
 * Channels are user-facing inbound/outbound surfaces (Teams, Slack, Telegram,
 * WhatsApp, Discord, custom webhooks, …). Each channel package implements
 * `ChannelPlugin`; the core hands it a `PluginContext` (secrets + config via
 * dependency-chain resolution) and a `CoreApi` (the handle the channel uses
 * to drive orchestrator turns + register routes).
 *
 * Agents stay channel-agnostic: they never see the `ChannelUserRef` or the
 * native event payload. Channel-native rendering (Adaptive Card, Block Kit,
 * Telegram keyboard, …) is translated inside the channel plugin's adapter.
 */
export interface ChannelPlugin {
  /**
   * Called once at middleware startup (for installed channel packages) OR on
   * demand when a channel is installed at runtime. Mounts webhook routes,
   * opens long-lived connections, or starts polling loops — all via the
   * supplied CoreApi so the core can tear them down cleanly at deactivation.
   */
  activate(ctx: PluginContext, core: CoreApi): Promise<ChannelHandle>;
}

/**
 * Opaque handle returned by `activate`. The core retains it and calls
 * `close()` on deactivate / uninstall / middleware shutdown.
 */
export interface ChannelHandle {
  /** Release all runtime resources (close sockets, stop polling, etc.). */
  close(): Promise<void>;
}

/**
 * Runtime registry for installed channel packages. Walks the installed
 * registry at startup, picks every entry whose catalog-manifest declares
 * `kind: channel`, and calls `activate()` on the resolved `ChannelPlugin`.
 */
export interface ChannelRegistry {
  /** Activates every installed plugin whose kind is 'channel'. Idempotent. */
  activateAllInstalled(): Promise<void>;

  /** Activate a single channel by its plugin identity.id. */
  activate(agentId: string): Promise<void>;

  /** Deactivate and remove the handle. Cleans up routes too. */
  deactivate(agentId: string): Promise<void>;

  /** Is the channel currently active (runtime running)? */
  isActive(agentId: string): boolean;

  /** List currently active channel ids. */
  activeIds(): string[];
}

/**
 * Resolves a channel package id to its ChannelPlugin implementation.
 *
 * Phase 5B: the resolver may resolve synchronously (legacy fixed-imports
 * path retained during transition) or asynchronously (plugin-store flow
 * that dynamic-imports the channel's `dist/plugin.js` at activation
 * time). The registry always `await`s the result so both shapes are
 * supported by the same call site.
 */
export interface ChannelPluginResolver {
  resolve(
    agentId: string,
  ): Promise<ChannelPlugin | undefined> | ChannelPlugin | undefined;
}
