// An agent's own bot on a channel (spec 2042 §5.3, §8 item 20).
//
// "One identity per agent where the platform allows it": a Telegram bot from
// BotFather, a Discord application, a Slack app — each one IS one agent, with
// that agent's name and avatar in the client. A channel plugin that can run
// several bots side by side registers an {@link AgentIdentityProvider}; the
// kernel's operator surface hands it the credentials an operator entered for
// an agent; the plugin says which bot they are (`identify`, no side effect),
// the kernel checks that the bot is free, the plugin starts it (`provision`),
// and the kernel stores (agent, channel type, key).
//
// From then on the key is routed exactly like a provisioned Teams bot:
//
//   - inbound: the adapter resolves the turn on the bot's key as well as the
//     conversation's (`resolve(channelType, botKey)`), and an exclusive hit
//     wins — a message to the agent's bot goes to that agent and to nobody
//     else, without a model in between;
//   - outbound: the answer goes out through the bot that received the turn,
//     and kernel-initiated posts (`conversationSend@1`, facilitation, consulted
//     agents) carry `asChannelKey` = this key, which the provider honours or
//     refuses (`supports.asChannelKey`).
//
// The credentials cross the kernel exactly once, from the operator's request
// to {@link AgentIdentityProvider.identify} / `provision`. The plugin keeps them in its own
// vault; the kernel never stores or logs them.

/** One input the operator fills in for an agent's bot (a token, an app id). */
export interface AgentIdentityField {
  /** Key in {@link AgentIdentityProvisionInput.credentials}. `[a-z][a-z0-9_]*`. */
  readonly key: string;
  /** Label per locale; `en` is required, others fall back to it. */
  readonly label: Readonly<Record<string, string>> & { readonly en: string };
  /** Short help per locale (where to get the value). Optional. */
  readonly help?: Readonly<Record<string, string>> & { readonly en: string };
  /** A secret: never echoed back, rendered as a password input. */
  readonly secret: boolean;
  /** Default true. */
  readonly required?: boolean;
}

export interface AgentIdentityProvisionInput {
  /** The agent the bot is for. */
  readonly agentSlug: string;
  /** The agent's display name, for platforms where the bot's name can be set. */
  readonly agentDisplayName: string;
  /** The operator's input, keyed by {@link AgentIdentityField.key}. */
  readonly credentials: Readonly<Record<string, string>>;
}

/** Why a bot could not be registered. Returned, never thrown. */
export type AgentIdentityRefusalCode =
  /** The platform rejected the credentials (wrong token, revoked app). */
  | 'invalid_credentials'
  /** A required field is missing or malformed. */
  | 'invalid_input'
  /** The bot is the channel's own default bot. */
  | 'already_in_use'
  /** The platform could not be reached; trying again may work. */
  | 'unreachable';

/** Who a set of credentials is: the bot's routing key and public name. */
export interface AgentIdentityDescription {
  /**
   * The bot's routing key, the SAME string the adapter resolves inbound
   * turns on and honours as `asChannelKey`. Lowercase; it must not be a
   * conversation id. Telegram `tg:<botId>`, Discord `discord-app:<appId>`,
   * Slack `slack-bot:<botUserId>`.
   */
  readonly channelKey: string;
  /** The bot's public name on the platform (`@mira_bot`), for display. */
  readonly externalRef?: string;
  /** The name the bot shows in the client, when it differs from the agent's. */
  readonly displayName?: string;
}

/** Why credentials were refused. Never contains a credential. */
export interface AgentIdentityRefusal {
  readonly ok: false;
  readonly code: AgentIdentityRefusalCode;
  /** Operator-readable, no secret in it. */
  readonly message: string;
}

export type AgentIdentityIdentifyOutcome = ({ readonly ok: true } & AgentIdentityDescription) | AgentIdentityRefusal;

export type AgentIdentityProvisionOutcome = { readonly ok: true } | AgentIdentityRefusal;

/** What the provider can say about a registered bot right now. */
export interface AgentIdentityStatus {
  /** `running`: the plugin serves the bot. `stopped`: credentials missing or revoked. */
  readonly state: 'running' | 'stopped' | 'unknown';
  /** Operator-readable, no secret in it. */
  readonly detail?: string;
}

export interface AgentIdentityProvider {
  /** The channel type this provider serves (`telegram`). Never `teams`. */
  readonly channelType: string;
  /** What the operator enters for one agent's bot. */
  readonly fields: readonly AgentIdentityField[];
  /**
   * Check the credentials with the platform and say which bot they are.
   * MUST have no side effect: nothing is stored, started or renamed. The
   * kernel then refuses the channel's default bot and a bot that belongs to
   * another agent BEFORE anything happens to it, and only otherwise calls
   * {@link provision}.
   */
  identify(input: AgentIdentityProvisionInput): Promise<AgentIdentityIdentifyOutcome>;
  /**
   * Store the credentials in the plugin's vault and start serving the bot
   * `channelKey` (the key {@link identify} returned for the same input).
   * Called only for a bot no agent owns and that is not the default bot.
   */
  provision(input: AgentIdentityProvisionInput, channelKey: string): Promise<AgentIdentityProvisionOutcome>;
  /**
   * Stop serving the bot and forget its credentials. Idempotent; an unknown
   * key is not an error. The kernel deletes its row only after this resolved.
   */
  release(channelKey: string): Promise<void>;
  /** Optional: is the bot served right now (shown on the agent page). */
  status?(channelKey: string): Promise<AgentIdentityStatus>;
  /**
   * Optional: the routing key of the plugin's own default bot (the token in
   * its setup), when it has one. It is the bot every agent without its own
   * bot answers through, and the only unknown bot key the Conductor may route
   * to a binding or a default agent. Read per call.
   */
  defaultChannelKey?(): string | undefined;
  /**
   * Optional: the agent bots (routing keys) that are members of this
   * conversation, as far as the plugin has seen. Used for "who can be heard
   * here" — an agent whose bot is not in the group cannot post into it.
   */
  presentIn?(conversationId: string): Promise<readonly string[]>;
}

/** Routing keys are compared lowercase, like every bot key (`channelBotKey`). */
export function normalizeAgentIdentityKey(raw: string): string {
  return raw.trim().toLowerCase();
}
