// ADR-0225 / ADR-0280 — linking a channel account to an omadia account.
//
// The kernel owns the link. A channel plugin never names the omadia user a
// turn runs as: it asks the kernel, on an operator's behalf, to OFFER a link
// to an account the operator picked, and later REDEEMS that offer with the
// channel user id the platform attested (Telegram: the sender of
// `/start <token>`). The kernel checks the operator session, the account, and
// that the plugin serves the channel type; it records who linked whom.
//
// `channelUserId` is always the id the channel's turns carry as
// `ChatTurnInput.userId` (Telegram: `telegram:<from.id>`; Teams: the AAD object
// id). That id keys the sender's identity in the kernel; any other spelling
// links an identity no turn ever resolves.
//
// Operator acts take the raw `Cookie` header of the plugin's admin request.
// The kernel resolves the operator from it, so a plugin cannot act for an
// operator it has no session of, and cannot name a different actor.

/** An account an operator may link a channel account to (picker row). */
export interface LinkableAccount {
  /**
   * What `offerLink` takes: an account's `users.id`, or — ADR-0300 — a
   * directory person as `directory:<id>` (a colleague of the Entra tenant
   * without a web login). Pass it through unchanged.
   */
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  /** ADR-0300 — `person` for a directory person; absent or `account` for an account. */
  readonly kind?: 'account' | 'person';
}

/** ADR-0300 — the `userId` prefix of a directory person in {@link LinkableAccount} and {@link ChannelAccountLink}. */
export const DIRECTORY_PERSON_LINK_PREFIX = 'directory:';

/** The account a channel account is linked to. */
export interface ChannelAccountLink {
  readonly channelType: string;
  readonly channelUserId: string;
  /** `users.id` of the linked account, or `directory:<id>` for a directory person (ADR-0300). */
  readonly userId: string;
  /** The account's display name (from `users`), for texts like "connected as". */
  readonly displayName: string;
  /** ISO time the link was made. */
  readonly linkedAt?: string;
}

/** Why the kernel refused a link request. */
export type ChannelIdentityLinkRefusal =
  /** No valid operator session in the cookie header. */
  | 'no_session'
  /** The account does not exist or is not active. */
  | 'unknown_user'
  /** The plugin does not serve this channel type, or it cannot be linked. */
  | 'unsupported_channel'
  /** The offer is unknown, used, or expired. */
  | 'unknown_offer'
  /** `unlink` of a channel account that has no link. */
  | 'not_linked'
  /** The kernel cannot link right now (no knowledge graph, store failure). */
  | 'unavailable';

export type ChannelIdentityLinkOutcome<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: ChannelIdentityLinkRefusal };

export interface LinkOffer {
  /** Opaque, single-use. Carry it (or a token mapping to it) in the deep link. */
  readonly offerId: string;
  readonly account: { readonly userId: string; readonly displayName: string };
  /** ISO expiry; an offer lives at most {@link MAX_LINK_OFFER_TTL_MS}. */
  readonly expiresAt: string;
}

/** The longest an offer stays redeemable. */
export const MAX_LINK_OFFER_TTL_MS = 15 * 60 * 1000;

/**
 * `CoreApi.channelIdentityLinks` — present on kernels that ship ADR-0225.
 * Bound to the calling plugin: a `channelType` it does not serve is refused
 * (`unsupported_channel`).
 */
export interface ChannelIdentityLinks {
  /** Active accounts for the operator's picker; `null` without a valid operator session. */
  listLinkableAccounts(cookieHeader: string | undefined): Promise<readonly LinkableAccount[] | null>;
  /**
   * The operator offers to link a channel account of `channelType` to
   * `userId`. Nothing is linked yet: the person proves control of the channel
   * account by redeeming the offer.
   */
  offerLink(
    cookieHeader: string | undefined,
    request: { readonly channelType: string; readonly userId: string; readonly ttlMs?: number },
  ): Promise<ChannelIdentityLinkOutcome<LinkOffer>>;
  /**
   * Redeem an offer for the channel user the platform attested. Links the
   * channel identity to the offered account (replacing an earlier link) and
   * records the offering operator as the actor. Single-use.
   */
  redeemLink(request: {
    readonly channelType: string;
    readonly channelUserId: string;
    readonly offerId: string;
    readonly displayName?: string;
  }): Promise<ChannelIdentityLinkOutcome<{ readonly link: ChannelAccountLink }>>;
  /** The link of a channel account, or `null` when it has none. */
  linkOf(request: {
    readonly channelType: string;
    readonly channelUserId: string;
  }): Promise<ChannelAccountLink | null>;
  /** The operator removes a link; the channel account gets its own identity again. */
  unlink(
    cookieHeader: string | undefined,
    request: { readonly channelType: string; readonly channelUserId: string },
  ): Promise<ChannelIdentityLinkOutcome<Record<never, never>>>;
}
