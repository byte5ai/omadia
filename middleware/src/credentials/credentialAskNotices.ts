/**
 * #2319 / ADR-0290 — the two messages around an agent's credential ask, both
 * spoken by `system` (ADR-0012: only agents and `system` speak to people; a
 * harness template is never an agent's words):
 *
 *  - **to the owner**, when an ask is created: in the owner's own channel (a
 *    channel identity in the owner's account cluster), with a link to the
 *    owner-only approve/deny surface. The decision itself never happens in
 *    chat (ADR-0102 D2).
 *  - **to the asking conversation**, when the owner decides: approved or
 *    denied, nothing else.
 *
 * Delivery is best effort and never throws: a missing channel leaves the ask
 * in the owner's inbox, a failed post is logged. Neither message carries the
 * secret; the purpose is the agent's text and is shortened to one line.
 */

import type { CredentialAsk } from './asks.js';

/** The web path of the owner's ask inbox (admin UI, #2320). */
export const CREDENTIAL_ASK_INBOX_PATH = '/admin/credentials/asks';

/** Channel kinds that are accounts or keys themselves, not a place to post to. */
const NON_MESSAGING_KINDS: ReadonlySet<string> = new Set(['web', 'http', 'api']);

const MAX_PURPOSE_CHARS = 300;

export interface OwnerChannelIdentity {
  readonly channelType: string;
  readonly channelUserId: string;
}

export interface CredentialAskNoticeDeps {
  /** The channel identities in the owner's account cluster (`user:<id>` ref). */
  readonly ownerChannels: (ownerUserId: string) => Promise<readonly OwnerChannelIdentity[]>;
  /** Direct message as `system`; resolves true when delivered. */
  readonly sendToUser: (channelType: string, principal: string, text: string) => Promise<boolean>;
  /** Post as `system` into the conversation the ask came from. */
  readonly sendToConversation: (channel: string, conversationRef: unknown, text: string) => Promise<void>;
  readonly publicBaseUrl?: () => string | undefined;
  readonly language?: () => string | undefined;
  readonly log?: (message: string) => void;
}

export interface CredentialAskNoticeFacts {
  readonly credentialName: string;
  readonly agentName: string;
}

export interface CredentialAskNotices {
  /** @returns whether the notice reached the owner in one of their channels. */
  notifyOwner(ask: CredentialAsk, facts: CredentialAskNoticeFacts): Promise<boolean>;
  deliverDecision(
    ask: CredentialAsk,
    target: { readonly channel: string; readonly conversationRef: unknown },
    facts: CredentialAskNoticeFacts,
  ): Promise<void>;
}

function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isGerman(language: string | undefined): boolean {
  return (language ?? '').trim().toLowerCase().startsWith('de');
}

export function inboxLink(baseUrl: string | undefined, askId: string): string | undefined {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  if (!base) return undefined;
  return `${base}${CREDENTIAL_ASK_INBOX_PATH}?ask=${encodeURIComponent(askId)}`;
}

export function ownerNoticeText(
  ask: CredentialAsk,
  facts: CredentialAskNoticeFacts,
  link: string | undefined,
  language: string | undefined,
): string {
  const purpose = oneLine(ask.purpose, MAX_PURPOSE_CHARS);
  const name = oneLine(facts.credentialName, 120);
  const agent = oneLine(facts.agentName, 120);
  if (isGerman(language)) {
    const mode = ask.mode === 'once' ? 'einmalig' : 'dauerhaft';
    const where = link ? `Freigeben oder ablehnen: ${link}` : 'Freigeben oder ablehnen in omadia unter Zugangsdaten → Anfragen.';
    return `${agent} bittet darum, deine Zugangsdaten „${name}“ ${mode} zu nutzen. Zweck: „${purpose}“. ${where}`;
  }
  const mode = ask.mode === 'once' ? 'once' : 'on a standing basis';
  const where = link ? `Approve or deny: ${link}` : 'Approve or deny in omadia under Credentials → Asks.';
  return `${agent} asks to use your credential "${name}" ${mode}. Purpose: "${purpose}". ${where}`;
}

export function decisionText(ask: CredentialAsk, facts: CredentialAskNoticeFacts, language: string | undefined): string {
  const name = oneLine(facts.credentialName, 120);
  const agent = oneLine(facts.agentName, 120);
  const approved = ask.status === 'approved';
  if (isGerman(language)) {
    return approved
      ? `Die Inhaberin oder der Inhaber hat die Nutzung von „${name}“ freigegeben. ${agent} kann die Anfrage jetzt ausführen.`
      : `Die Inhaberin oder der Inhaber hat die Nutzung von „${name}“ abgelehnt.`;
  }
  return approved
    ? `The owner approved the use of "${name}". ${agent} can carry out the request now.`
    : `The owner denied the use of "${name}".`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createCredentialAskNotices(deps: CredentialAskNoticeDeps): CredentialAskNotices {
  const log = deps.log ?? (() => undefined);

  return {
    async notifyOwner(ask, facts) {
      if (ask.owner.kind !== 'user') return false;
      let channels: readonly OwnerChannelIdentity[];
      try {
        channels = await deps.ownerChannels(ask.owner.userId);
      } catch (err) {
        log(`[credential-broker] owner channels for ask ${ask.id} unavailable — ${errText(err)}`);
        return false;
      }
      const text = ownerNoticeText(ask, facts, inboxLink(deps.publicBaseUrl?.(), ask.id), deps.language?.());
      for (const channel of channels) {
        if (NON_MESSAGING_KINDS.has(channel.channelType)) continue;
        try {
          const principal = `user:${channel.channelUserId.trim().toLowerCase()}`;
          if (await deps.sendToUser(channel.channelType, principal, text)) return true;
        } catch (err) {
          log(`[credential-broker] owner notice for ask ${ask.id} via ${channel.channelType} failed — ${errText(err)}`);
        }
      }
      log(`[credential-broker] ask ${ask.id}: owner has no reachable channel — the ask waits in the inbox`);
      return false;
    },

    async deliverDecision(ask, target, facts) {
      try {
        await deps.sendToConversation(target.channel, target.conversationRef, decisionText(ask, facts, deps.language?.()));
      } catch (err) {
        log(`[credential-broker] decision on ask ${ask.id} not delivered to ${target.channel} — ${errText(err)}`);
      }
    },
  };
}
