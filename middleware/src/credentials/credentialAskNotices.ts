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
 * secret. The purpose is the agent's text, so it never goes into the chat
 * notice — a `system`-voiced message must not carry model-written links or
 * mentions (phishing); the owner reads the purpose in the inbox.
 *
 * Language: German unless the instance locale says English, like the routine
 * texts (`triggers/routineTexts.ts`, `ai_disclosure_locale`).
 */

import { SYSTEM_SPEAKER, type Speaker } from '@omadia/plugin-api';

import type { CredentialAsk } from './asks.js';

/** The web path of the owner's ask inbox (admin UI, #2320). */
export const CREDENTIAL_ASK_INBOX_PATH = '/admin/credentials/asks';

/** Channel kinds that are accounts or keys themselves, not a place to post to. */
const NON_MESSAGING_KINDS: ReadonlySet<string> = new Set(['web', 'http', 'api']);

export interface OwnerChannelIdentity {
  readonly channelType: string;
  readonly channelUserId: string;
}

/** A harness message: always spoken by `system` (stamped here, ADR-0012). */
export interface SystemNotice {
  readonly text: string;
  readonly speaker: Speaker;
}

export interface CredentialAskNoticeDeps {
  /** The channel identities in the owner's account cluster (`user:<id>` ref). */
  readonly ownerChannels: (ownerUserId: string) => Promise<readonly OwnerChannelIdentity[]>;
  /** Direct message; resolves true when delivered. */
  readonly sendToUser: (channelType: string, principal: string, message: SystemNotice) => Promise<boolean>;
  /** Post into the conversation the ask came from. */
  readonly sendToConversation: (channel: string, conversationRef: unknown, message: SystemNotice) => Promise<void>;
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

function isEnglish(language: string | undefined): boolean {
  return (language ?? '').trim().toLowerCase().startsWith('en');
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
  const name = oneLine(facts.credentialName, 120);
  const agent = oneLine(facts.agentName, 120);
  if (!isEnglish(language)) {
    const mode = ask.mode === 'once' ? 'einmalig' : 'dauerhaft';
    const where = link
      ? `Zweck ansehen, freigeben oder ablehnen: ${link}`
      : 'Zweck ansehen, freigeben oder ablehnen in omadia unter Zugangsdaten → Anfragen.';
    return `${agent} bittet darum, deine Zugangsdaten „${name}“ ${mode} zu nutzen. ${where}`;
  }
  const mode = ask.mode === 'once' ? 'once' : 'on a standing basis';
  const where = link ? `See the purpose, approve or deny: ${link}` : 'See the purpose, approve or deny in omadia under Credentials → Asks.';
  return `${agent} asks to use your credential "${name}" ${mode}. ${where}`;
}

export function decisionText(ask: CredentialAsk, facts: CredentialAskNoticeFacts, language: string | undefined): string {
  const name = oneLine(facts.credentialName, 120);
  const approved = ask.status === 'approved';
  if (!isEnglish(language)) {
    return approved
      ? `Die Nutzung von „${name}“ wurde freigegeben; die Berechtigung ist erfasst.`
      : `Die Nutzung von „${name}“ wurde abgelehnt.`;
  }
  return approved ? `The use of "${name}" was approved; the permission is recorded.` : `The use of "${name}" was denied.`;
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
      const message: SystemNotice = {
        text: ownerNoticeText(ask, facts, inboxLink(deps.publicBaseUrl?.(), ask.id), deps.language?.()),
        speaker: SYSTEM_SPEAKER,
      };
      for (const channel of channels) {
        if (NON_MESSAGING_KINDS.has(channel.channelType)) continue;
        try {
          const principal = `user:${channel.channelUserId.trim().toLowerCase()}`;
          if (await deps.sendToUser(channel.channelType, principal, message)) return true;
        } catch (err) {
          log(`[credential-broker] owner notice for ask ${ask.id} via ${channel.channelType} failed — ${errText(err)}`);
        }
      }
      log(`[credential-broker] ask ${ask.id}: owner has no reachable channel — the ask waits in the inbox`);
      return false;
    },

    async deliverDecision(ask, target, facts) {
      try {
        const message: SystemNotice = { text: decisionText(ask, facts, deps.language?.()), speaker: SYSTEM_SPEAKER };
        await deps.sendToConversation(target.channel, target.conversationRef, message);
      } catch (err) {
        log(`[credential-broker] decision on ask ${ask.id} not delivered to ${target.channel} — ${errText(err)}`);
      }
    },
  };
}
