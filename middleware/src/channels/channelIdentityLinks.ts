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
  DIRECTORY_PERSON_LINK_PREFIX,
  MAX_LINK_OFFER_TTL_MS,
  type ChannelAccountLink,
  type ChannelIdentityLinkRefusal,
  type ChannelIdentityLinks,
  type LinkableAccount,
} from '@omadia/channel-sdk';
import type { ChannelKind, KnowledgeGraph, OperatorPrincipal } from '@omadia/plugin-api';

import type { AuditEntryInput } from '../auth/adminAuditLog.js';
import { ENTRA_PROVIDER_ID } from '../auth/providers/EntraProvider.js';
import type { UserRecord } from '../auth/userStore.js';
import { personClusterOf } from '../directory/directoryLinks.js';
import type { DirectoryPerson, DirectoryStore } from '../directory/directoryStore.js';

/** Channel types whose accounts can be linked. `web` and `api` are accounts or keys themselves. */
const LINKABLE_CHANNEL_KINDS: Readonly<Record<string, ChannelKind>> = {
  telegram: 'telegram',
  teams: 'teams',
  slack: 'slack',
  discord: 'discord',
  whatsapp: 'whatsapp',
  imessage: 'imessage',
};

/** A usable channel user id: a non-blank string (plugins may be plain JS). */
function isChannelUserId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

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
  /** ADR-0300 — the directory of people; absent without a database. */
  readonly directory?: () => Pick<DirectoryStore, 'findById' | 'list'> | undefined;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

interface UserRecordSource {
  findById(id: string): Promise<UserRecord | null>;
  list(opts?: { limit?: number; offset?: number }): Promise<UserRecord[]>;
}

interface PendingOffer {
  readonly channelKind: ChannelKind;
  /** `users.id`, or — with `personId` — the picker value `directory:<id>`. */
  readonly userId: string;
  /** ADR-0300 — the offer names a directory person, not an account. */
  readonly personId?: string;
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

/** The directory person id of a picker value `directory:<id>`, else `undefined`. */
function personIdOf(userId: string): string | undefined {
  return typeof userId === 'string' && userId.startsWith(DIRECTORY_PERSON_LINK_PREFIX)
    ? userId.slice(DIRECTORY_PERSON_LINK_PREFIX.length)
    : undefined;
}

function isActivePerson(person: DirectoryPerson | null | undefined): person is DirectoryPerson {
  return person !== null && person !== undefined && person.status === 'active';
}

const personLinkId = (person: DirectoryPerson): string => `${DIRECTORY_PERSON_LINK_PREFIX}${person.id}`;

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
      // As the Entra login does: its provider subject IS the AAD object id, so
      // an account linked before its first sign-in still joins its Teams cluster.
      ...(account.provider === ENTRA_PROVIDER_ID ? { aadObjectId: account.providerUserId } : {}),
    });
    await kg.linkChannelIdentity({
      channelKind,
      channelUserId,
      target: { omadiaUserId: web.omadiaUserId, userId: account.id, ...(linkedBy ? { linkedBy } : {}) },
      ...(displayName ? { displayName } : {}),
    });
  }

  /** An active account, or (ADR-0300) an active directory person, by picker value. */
  async function offerTarget(
    userId: string,
  ): Promise<{ userId: string; personId?: string; displayName: string } | null> {
    const personId = personIdOf(userId);
    if (personId !== undefined) {
      const person = await deps.directory?.()?.findById(personId);
      if (!isActivePerson(person)) return null;
      return { userId: personLinkId(person), personId: person.id, displayName: person.displayName || person.externalId };
    }
    const account = (await deps.users()?.findById(userId)) ?? null;
    return isActive(account) ? { userId: account.id, displayName: account.displayName } : null;
  }

  /** ADR-0300 — joins the channel identity to the cluster of the person's Teams identity. */
  async function joinPersonCluster(
    kg: KnowledgeGraph,
    channelKind: ChannelKind,
    channelUserId: string,
    person: DirectoryPerson,
    linkedBy: string | undefined,
    displayName: string | undefined,
  ): Promise<void> {
    if (!kg.linkChannelIdentity) throw new Error('knowledge graph cannot link identities');
    const cluster = await personClusterOf(kg, person);
    await kg.linkChannelIdentity({
      channelKind,
      channelUserId,
      target: { omadiaUserId: cluster, directoryPersonId: person.id, ...(linkedBy ? { linkedBy } : {}) },
      ...(displayName ? { displayName } : {}),
    });
  }

  return {
    async listLinkableAccounts(cookieHeader) {
      if (!(await deps.operatorOf(cookieHeader))) return null;
      const users = deps.users();
      if (!users) return [];
      const rows = await users.list({ limit: MAX_LINKABLE_ACCOUNTS });
      const active = rows.filter((u) => u.status === 'active');
      const accounts = active.map(
        (u): LinkableAccount => ({ userId: u.id, displayName: u.displayName, email: u.email, kind: 'account' }),
      );
      // ADR-0300 — colleagues without a web login. A person who has an Entra
      // account is offered as that account only.
      const entraAccounts = new Set(
        active.filter((u) => u.provider === ENTRA_PROVIDER_ID).map((u) => u.providerUserId.toLowerCase()),
      );
      const room = MAX_LINKABLE_ACCOUNTS - accounts.length;
      const directory = deps.directory?.();
      if (!directory || room <= 0) return accounts;
      const { people } = await directory.list({ status: 'active', limit: room });
      const persons = people
        .filter((p) => !entraAccounts.has(p.externalId.toLowerCase()))
        .map(
          (p): LinkableAccount => ({
            userId: personLinkId(p),
            displayName: p.displayName || p.upn || p.externalId,
            email: p.mail ?? p.upn ?? '',
            kind: 'person',
          }),
        );
      return [...accounts, ...persons];
    },

    async offerLink(cookieHeader, request) {
      const channelKind = linkableChannelKind(request.channelType);
      if (!channelKind) return refused('unsupported_channel');
      const operator = await deps.operatorOf(cookieHeader);
      if (!operator) return refused('no_session');
      const users = deps.users();
      if (!users || !deps.audit() || !deps.knowledgeGraph()?.linkChannelIdentity) return refused('unavailable');
      const target = await offerTarget(request.userId);
      if (!target) return refused('unknown_user');
      prune();
      const ttl = Math.min(Math.max(request.ttlMs ?? MAX_LINK_OFFER_TTL_MS, 1), MAX_LINK_OFFER_TTL_MS);
      const offerId = randomBytes(18).toString('base64url');
      const expiresAt = now() + ttl;
      offers.set(offerId, {
        channelKind,
        userId: target.userId,
        ...(target.personId ? { personId: target.personId } : {}),
        offeredBy: operator,
        expiresAt,
      });
      return {
        ok: true,
        offerId,
        account: { userId: target.userId, displayName: target.displayName },
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
      if (!offer || offer.channelKind !== channelKind || !isChannelUserId(request.channelUserId)) {
        return refused('unknown_offer');
      }
      const kg = deps.knowledgeGraph();
      const audit = deps.audit();
      if (!kg || !audit) return refused('unavailable');
      const target = await offerTarget(offer.userId);
      if (!target) return refused('unknown_user');
      const person = target.personId ? await deps.directory?.()?.findById(target.personId) : undefined;
      const account = target.personId ? undefined : await deps.users()?.findById(target.userId);
      if (target.personId ? !isActivePerson(person) : !isActive(account ?? null)) return refused('unknown_user');
      const linkedFact = person ? { linkedDirectoryPersonId: person.id } : { linkedUserId: target.userId };
      try {
        const before = await kg.resolveOrCreateChannelIdentity({
          channelKind,
          channelUserId: request.channelUserId,
          ...(request.displayName ? { displayName: request.displayName } : {}),
        });
        const previous = before.linkedUserId
          ? { linkedUserId: before.linkedUserId }
          : before.linkedDirectoryPersonId
            ? { linkedDirectoryPersonId: before.linkedDirectoryPersonId }
            : null;
        // Recorded first: a link nobody can trace is not made.
        await audit.record({
          actor: { ...(offer.offeredBy.userId ? { id: offer.offeredBy.userId } : {}), email: offer.offeredBy.email },
          action: 'channel_identity.link',
          target: `channel_identity:${channelKind}:${request.channelUserId}`,
          before: previous,
          after: linkedFact,
        });
        if (person) {
          await joinPersonCluster(kg, channelKind, request.channelUserId, person, offer.offeredBy.userId, request.displayName);
        } else {
          await joinAccountCluster(
            kg,
            channelKind,
            request.channelUserId,
            account!,
            offer.offeredBy.userId,
            request.displayName,
          );
        }
      } catch (err) {
        log(
          `[channel-identity-links] link ${channelKind}:${request.channelUserId} → ${target.userId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return refused('unavailable');
      }
      log(`[channel-identity-links] linked ${channelKind}:${request.channelUserId} → ${target.userId}`);
      const link: ChannelAccountLink = {
        channelType: request.channelType,
        channelUserId: request.channelUserId,
        userId: target.userId,
        displayName: target.displayName,
        linkedAt: new Date(now()).toISOString(),
      };
      return { ok: true, link };
    },

    async linkOf(request) {
      const channelKind = linkableChannelKind(request.channelType);
      const kg = deps.knowledgeGraph();
      const users = deps.users();
      if (!channelKind || !kg || !users || !isChannelUserId(request.channelUserId)) return null;
      try {
        const resolved = await kg.resolveOrCreateChannelIdentity({
          channelKind,
          channelUserId: request.channelUserId,
        });
        if (resolved.linkedDirectoryPersonId) {
          // ADR-0300 — a link to a deprovisioned person names nobody.
          const person = await deps.directory?.()?.findById(resolved.linkedDirectoryPersonId);
          if (!isActivePerson(person)) return null;
          return {
            channelType: request.channelType,
            channelUserId: request.channelUserId,
            userId: personLinkId(person),
            displayName: person.displayName || person.externalId,
          };
        }
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
      if (!isChannelUserId(request.channelUserId)) return refused('not_linked');
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
        if (!current.linkedUserId && !current.linkedDirectoryPersonId) return refused('not_linked');
        await audit.record({
          actor: { ...(operator.userId ? { id: operator.userId } : {}), email: operator.email },
          action: 'channel_identity.unlink',
          target: `channel_identity:${channelKind}:${request.channelUserId}`,
          before: current.linkedUserId
            ? { linkedUserId: current.linkedUserId }
            : { linkedDirectoryPersonId: current.linkedDirectoryPersonId },
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
