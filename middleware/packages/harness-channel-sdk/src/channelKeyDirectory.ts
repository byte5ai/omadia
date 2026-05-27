/**
 * Channel-key directory contract — opt-in by each channel-kind plugin.
 *
 * The operator dashboard's `/operator/channels` page needs to know which
 * `(channel_type, channel_key)` pairs actually exist on the platform so it
 * can present them as pickable entries instead of asking the operator to
 * memorise cryptic strings ("28:bot-app-id:guid" for Teams,
 * "@bot_username" for Telegram, …).
 *
 * Each channel-kind plugin owns this knowledge: it knows its own bot
 * registration, its installed-app conversation references, its
 * Telegram-bot-token-derived username, etc. A plugin contributes a
 * `ChannelKeyDirectory` during activate(); the kernel's
 * `ChannelDirectoryRegistry` aggregates them and exposes the union to the
 * operator-channels REST surface.
 *
 * **No platform-level discovery via Graph / external APIs.** Discovery
 * lives inside the plugin that owns the channel — that keeps generic
 * platform code free of channel-specific permissions, and avoids the
 * "M365-only" cliff that would block Telegram / Slack / Email
 * integrations from ever using the same UX. A Teams plugin MAY use
 * Graph internally for label enrichment; that is its choice, not the
 * platform's.
 */

/** One concrete (channel_type, channel_key) entry the plugin recognises. */
export interface ChannelKeyEntry {
  /** The opaque key stored in `channel_bindings.channel_key`. Stable across
   *  registrations. Format is channel-specific:
   *   - Teams: `28:<bot-app-id>:<service-url-token>` or the conversation id
   *   - Telegram: `@bot_username` or the numeric chat id
   *   - Email: the bot-inbox address
   *
   *  The platform never parses this — it is treated as an opaque routing
   *  selector. The plugin that produced it is the only thing that knows
   *  how to dispatch on it. */
  readonly key: string;
  /** Operator-facing label for the picker. Should be self-describing
   *  enough that two adjacent rows are distinguishable without consulting
   *  the key (e.g. "Omadia Production Bot · Marketing team" rather than
   *  bare "Production Bot"). */
  readonly label: string;
  /** Free-form context shown beside the label — environment, tenant
   *  hint, conversation name. Optional. */
  readonly hint?: string;
}

export interface ChannelKeyDirectory {
  /** The channel-type string used in `channel_bindings.channel_type`. The
   *  plugin owns the canonical spelling — the platform never derives it
   *  from the plugin id. */
  readonly channelType: string;
  /** Display name of the contributing plugin, for the dashboard's
   *  per-row "via @omadia/channel-teams" hint. */
  readonly originPluginId: string;
  /** Returns the keys this plugin can route. Called once per
   *  `/operator/channels` page load — keep it synchronous-fast (read
   *  from in-memory state set at activate()), or memoise inside the
   *  plugin if a remote call is needed.
   *
   *  Errors are caught + logged by the registry; an offline plugin
   *  degrades to "no keys" without breaking the page. */
  listKeys(): Promise<readonly ChannelKeyEntry[]>;
}
