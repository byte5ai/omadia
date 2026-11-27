// ADR-0225 / ADR-0280 — the kernel's link from a channel account to an omadia
// account (`CoreApi.channelIdentityLinks`).
//
// Two steps, both kernel-checked:
//   1. offer  — an operator (resolved from the session cookie of the plugin's
//               admin request) picks an active account; the kernel keeps a
//               single-use offer in memory (≤ 15 min, lost on restart like the
//               plugin's own pairing tokens).
//   2. redeem — the channel presents the offer with the channel user id the
//               platform attested. The kernel joins that channel identity to
//               the account's User-Cluster (`web:<users.id>`) in the knowledge
//               graph and writes `channel_identity.link` to the audit trail,
//               with the offering operator as actor.
// The link itself is a fact on the ChannelIdentity node (`linkedUserId`,
// `linkedBy`, `linkedAt`); turns read it in `resolveTurnOwnerIdentity`.

import { randomBytes } from 'node:crypto';

import {
  MAX_LINK_OFFER_TTL_MS,
  type ChannelAccountLink,
  type ChannelIdentityLinkRefusal,
  type ChannelIdentityLinks,
  type LinkableAccount,
} from '@omadia/channel-sdk';
import type { ChannelKind, KnowledgeGraph, OperatorPrincipal } from '@omadia/plugin-api';

import type { AuditEntryInput } from '../auth/adminAuditLog.js';
import type { UserRecord } from '../auth/userStore.js';

/** Channel types whose accounts can be linked. `web` and `api` are accounts or keys themselves. */
const LINKABLE_CHANNEL_KINDS: Readonly<Record<string, ChannelKind>> = {
  telegram: 'telegram',
  teams: 'teams',
  slack: 'slack',
  discord: 'discord',
  whatsapp: 'whatsapp',
  imessage: 'imessage',
};

/** Picker size cap; `users.list` caps at 500 per page anyway. */
const MAX_LINKABLE_ACCOUNTS = 500;

export interface ChannelIdentityLinkDeps {
  /** The operator behind a cookie header (`ctx.operatorAuth.sessionPrincipal`). */
  readonly operatorOf: (cookieHeader: string | undefined) => Promise<OperatorPrincipal | null>;
  /** The users table; absent without a database. */
  readonly users: () => Pick<UserRecordSource, 'findById' | 'list'> | undefined;
  readonly knowledgeGraph: () => KnowledgeGraph | undefined;
  /** Audit writer; absent without a database. A link is refused when it cannot be recorded. */
  readonly audit: () => { record(entry: AuditEntryInput): Promise<void> } | undefined;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

interface UserRecordSource {
  findById(id: string): Promise<UserRecord | null>;
  list(opts?: { limit?: number; offset?: number }): Promise<UserRecord[]>;
}

interface PendingOffer {
  readonly channelKind: ChannelKind;
  readonly userId: string;
  readonly offeredBy: OperatorPrincipal;
  readonly expiresAt: number;
}

const refused = (reason: ChannelIdentityLinkRefusal): { readonly ok: false; readonly reason: ChannelIdentityLinkRefusal } => ({
  ok: false,
  reason,
});

function isActive(user: UserRecord | null): user is UserRecord {
  return user !== null && user.status === 'active';
}

export function linkableChannelKind(channelType: string): ChannelKind | undefined {
  return Object.prototype.hasOwnProperty.call(LINKABLE_CHANNEL_KINDS, channelType)
    ? LINKABLE_CHANNEL_KINDS[channelType]
    : undefined;
}

/**
 * The kernel implementation, not yet bound to a plugin: it trusts the
 * `channelType` it is given. `scopeCoreApiToChannel` refuses a type the
 * calling plugin does not serve before a call reaches it.
 */
export function createChannelIdentityLinks(deps: ChannelIdentityLinkDeps): ChannelIdentityLinks {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const offers = new Map<string, PendingOffer>();

  const prune = (): void => {
    const t = now();
    for (const [id, offer] of offers) if (offer.expiresAt <= t) offers.delete(id);
  };

  /** Joins the channel identity to the account's cluster, creating the web identity if needed. */
  async function joinAccountCluster(
    kg: KnowledgeGraph,
    channelKind: ChannelKind,
    channelUserId: string,
    account: UserRecord,
    linkedBy: string | undefined,
    displayName: string | undefined,
  ): Promise<void> {
    if (!kg.linkChannelIdentity) throw new Error('knowledge graph cannot link identities');
    // The account's cluster — the same call (minus the IdP subject, which only
    // a completed sign-in may record) the login makes.
    const web = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: account.id,
      displayName: account.displayName,
      ...(account.email ? { email: account.email } : {}),
      emailVerified: true,
    });
    await kg.linkChannelIdentity({
      channelKind,
      channelUserId,
      target: { omadiaUserId: web.omadiaUserId, userId: account.id, ...(linkedBy ? { linkedBy } : {}) },
      ...(displayName ? { displayName } : {}),
    });
  }

  return {
    async listLinkableAccounts(cookieHeader) {
      if (!(await deps.operatorOf(cookieHeader))) return null;
      const users = deps.users();
      if (!users) return [];
      const rows = await users.list({ limit: MAX_LINKABLE_ACCOUNTS });
      return rows
        .filter((u) => u.status === 'active')
        .map((u): LinkableAccount => ({ userId: u.id, displayName: u.displayName, email: u.email }));
    },

    async offerLink(cookieHeader, request) {
      const channelKind = linkableChannelKind(request.channelType);
      if (!channelKind) return refused('unsupported_channel');
      const operator = await deps.operatorOf(cookieHeader);
      if (!operator) return refused('no_session');
      const users = deps.users();
      if (!users || !deps.audit() || !deps.knowledgeGraph()?.linkChannelIdentity) return refused('unavailable');
      const account = await users.findById(request.userId);
      if (!isActive(account)) return refused('unknown_user');
      prune();
      const ttl = Math.min(Math.max(request.ttlMs ?? MAX_LINK_OFFER_TTL_MS, 1), MAX_LINK_OFFER_TTL_MS);
      const offerId = randomBytes(18).toString('base64url');
      const expiresAt = now() + ttl;
      offers.set(offerId, { channelKind, userId: account.id, offeredBy: operator, expiresAt });
      return {
        ok: true,
        offerId,
        account: { userId: account.id, displayName: account.displayName },
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    async redeemLink(request) {
      const channelKind = linkableChannelKind(request.channelType);
      if (!channelKind) return refused('unsupported_channel');
      prune();
      const offer = offers.get(request.offerId);
      // Single-use, whatever the outcome below.
      offers.delete(request.offerId);
      if (!offer || offer.channelKind !== channelKind || !request.channelUserId.trim()) {
        return refused('unknown_offer');
      }
      const users = deps.users();
      const kg = deps.knowledgeGraph();
      const audit = deps.audit();
      if (!users || !kg || !audit) return refused('unavailable');
      const account = await users.findById(offer.userId);
      if (!isActive(account)) return refused('unknown_user');
      try {
        const before = await kg.resolveOrCreateChannelIdentity({
          channelKind,
          channelUserId: request.channelUserId,
          ...(request.displayName ? { displayName: request.displayName } : {}),
        });
        // Recorded first: a link nobody can trace is not made.
        await audit.record({
          actor: { ...(offer.offeredBy.userId ? { id: offer.offeredBy.userId } : {}), email: offer.offeredBy.email },
          action: 'channel_identity.link',
          target: `channel_identity:${channelKind}:${request.channelUserId}`,
          before: before.linkedUserId ? { linkedUserId: before.linkedUserId } : null,
          after: { linkedUserId: account.id },
        });
        await joinAccountCluster(
          kg,
          channelKind,
          request.channelUserId,
          account,
          offer.offeredBy.userId,
          request.displayName,
        );
      } catch (err) {
        log(
          `[channel-identity-links] link ${channelKind}:${request.channelUserId} → ${account.id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return refused('unavailable');
      }
      log(`[channel-identity-links] linked ${channelKind}:${request.channelUserId} → user ${account.id}`);
      const link: ChannelAccountLink = {
        channelType: request.channelType,
        channelUserId: request.channelUserId,
        userId: account.id,
        displayName: account.displayName,
        linkedAt: new Date(now()).toISOString(),
      };
      return { ok: true, link };
    },

    async linkOf(request) {
      const channelKind = linkableChannelKind(request.channelType);
      const kg = deps.knowledgeGraph();
      const users = deps.users();
      if (!channelKind || !kg || !users || !request.channelUserId.trim()) return null;
      try {
        const resolved = await kg.resolveOrCreateChannelIdentity({
          channelKind,
          channelUserId: request.channelUserId,
        });
        if (!resolved.linkedUserId) return null;
        const account = await users.findById(resolved.linkedUserId);
        // A link to a deleted or disabled account names nobody.
        if (!isActive(account)) return null;
        return {
          channelType: request.channelType,
          channelUserId: request.channelUserId,
          userId: account.id,
          displayName: account.displayName,
        };
      } catch (err) {
        log(`[channel-identity-links] linkOf failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },

    async unlink(cookieHeader, request) {
      const channelKind = linkableChannelKind(request.channelType);
      if (!channelKind) return refused('unsupported_channel');
      const operator = await deps.operatorOf(cookieHeader);
      if (!operator) return refused('no_session');
      const kg = deps.knowledgeGraph();
      const audit = deps.audit();
      if (!kg?.linkChannelIdentity || !audit) return refused('unavailable');
      try {
        const current = await kg.resolveOrCreateChannelIdentity({
          channelKind,
          channelUserId: request.channelUserId,
        });
        if (!current.linkedUserId) return refused('not_linked');
        await audit.record({
          actor: { ...(operator.userId ? { id: operator.userId } : {}), email: operator.email },
          action: 'channel_identity.unlink',
          target: `channel_identity:${channelKind}:${request.channelUserId}`,
          before: { linkedUserId: current.linkedUserId },
          after: null,
        });
        await kg.linkChannelIdentity({ channelKind, channelUserId: request.channelUserId, target: null });
        return { ok: true };
      } catch (err) {
        if ((err as { code?: string }).code === 'not_linked') return refused('not_linked');
        log(`[channel-identity-links] unlink failed: ${err instanceof Error ? err.message : String(err)}`);
        return refused('unavailable');
      }
    },
  };
}
