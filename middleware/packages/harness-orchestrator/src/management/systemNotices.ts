/**
 * Registered `system` notice templates (#2045, spec 2042 INV-6, INV-7).
 *
 * The management layer speaks only through these: deterministic, no model,
 * speaker `system`. A notice about an agent always names it (INV-7).
 */

import {
  SYSTEM_SPEAKER,
  type NoticeAgentRef,
  type SystemEmission,
  type SystemNotice,
  type SystemNoticeCode,
} from '@omadia/plugin-api';

export type NoticeLocale = 'de' | 'en';

type Template = (agent: string, items: readonly string[]) => string;

const TEMPLATES: Record<SystemNoticeCode, Record<NoticeLocale, Template>> = {
  agent_disabled: {
    de: (a) => `${a} ist derzeit deaktiviert und kann nicht antworten. Bitte wende dich an deinen Administrator.`,
    en: (a) => `${a} is currently disabled and cannot answer. Please contact your administrator.`,
  },
  agent_deleted: {
    de: (a) => `${a} wurde gelöscht. Bitte wähle einen anderen Agenten oder wende dich an deinen Administrator.`,
    en: (a) => `${a} was deleted. Please choose another agent or contact your administrator.`,
  },
  agent_unknown: {
    de: (a) => `Es gibt keinen Agenten „${a}“. Bitte wähle einen Agenten aus dem Verzeichnis.`,
    en: (a) => `There is no agent "${a}". Please choose an agent from the directory.`,
  },
  agent_not_available: {
    de: (a) => `${a} ist für dich in diesem Kanal nicht verfügbar.`,
    en: (a) => `${a} is not available to you in this channel.`,
  },
  no_agent: {
    de: () => 'Diese Nachricht ist an keinen Agenten gerichtet. Bitte wähle einen Agenten aus oder sprich ihn direkt an.',
    en: () => 'This message is not addressed to any agent. Please choose an agent or address one directly.',
  },
  agent_selected: {
    de: (a) => `Du schreibst jetzt mit ${a}.`,
    en: (a) => `You are now talking to ${a}.`,
  },
  agent_selection_cleared: {
    de: () => 'Deine Agentenauswahl für dieses Gespräch ist aufgehoben.',
    en: () => 'Your agent choice for this conversation was cleared.',
  },
  agent_directory: {
    de: (_a, items) =>
      items.length === 0
        ? 'Hier ist für dich gerade kein Agent verfügbar.'
        : `Verfügbare Agenten:\n${items.map((i) => `- ${i}`).join('\n')}\n\nWähle einen mit /agent <Name>.`,
    en: (_a, items) =>
      items.length === 0
        ? 'No agent is available to you here right now.'
        : `Available agents:\n${items.map((i) => `- ${i}`).join('\n')}\n\nChoose one with /agent <name>.`,
  },
  agent_error: {
    de: (a) => `${a} konnte diese Nachricht wegen eines Fehlers nicht beantworten. Bitte versuche es erneut.`,
    en: (a) => `${a} could not answer this message because of an error. Please try again.`,
  },
  missing_grant: {
    de: (a) => `${a} hat für diese Anfrage nicht die nötige Freigabe.`,
    en: (a) => `${a} does not have the permission this request needs.`,
  },
  quota_exceeded: {
    de: (a) => `${a} hat sein Kontingent erreicht und kann gerade nicht antworten.`,
    en: (a) => `${a} has reached its quota and cannot answer right now.`,
  },
  identity_guard_blocked: {
    de: (a) => `Die Antwort von ${a} wurde zurückgehalten, weil sie im Namen eines anderen Agenten oder einer Person sprach.`,
    en: (a) => `${a}'s answer was withheld because it spoke in the name of another agent or a person.`,
  },
  identity_guard_unavailable: {
    de: (a) => `Die Antwort von ${a} wurde zurückgehalten, weil die Identitätsprüfung nicht abgeschlossen werden konnte. Bitte versuche es erneut.`,
    en: (a) => `${a}'s answer was withheld because the identity check could not be completed. Please try again.`,
  },
};

/** A locale string (`de-DE`, `en`, …) reduced to a notice locale; German by default. */
export function noticeLocale(locale: string | undefined): NoticeLocale {
  return locale?.toLowerCase().startsWith('en') ? 'en' : 'de';
}

export function buildSystemNotice(
  code: SystemNoticeCode,
  options: {
    readonly agent?: NoticeAgentRef;
    readonly locale?: string;
    /** List items the template shows (`agent_directory`). */
    readonly items?: readonly string[];
  } = {},
): SystemNotice {
  const locale = noticeLocale(options.locale);
  const agentName = options.agent?.displayName ?? '';
  return {
    code,
    ...(options.agent ? { agent: options.agent } : {}),
    text: TEMPLATES[code][locale](agentName, options.items ?? []),
    locale,
  };
}

export function systemEmission(notice: SystemNotice): SystemEmission {
  return { type: 'system', speaker: SYSTEM_SPEAKER, notice };
}
