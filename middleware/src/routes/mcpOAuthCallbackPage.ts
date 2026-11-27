/**
 * #1959 — the page the MCP OAuth callback shows in the starter's browser tab,
 * in the browser's language (`Accept-Language`, de or en; English otherwise).
 * The web-ui catalog cannot serve it: the callback is a middleware route the
 * provider redirects to, outside the Next app.
 */

export type McpOAuthCallbackLocale = 'de' | 'en';

export type McpOAuthCallbackMessage =
  | 'notConfigured'
  | 'malformedIssuer'
  | 'providerError'
  | 'missingCodeOrState'
  | 'connected'
  | 'completerMismatch'
  | 'issuerMismatch'
  | 'failed';

interface PageTexts {
  readonly title: string;
  readonly okHeading: string;
  readonly failHeading: string;
  readonly closeHint: string;
  readonly messages: Readonly<Record<McpOAuthCallbackMessage, string>>;
}

const TEXTS: Readonly<Record<McpOAuthCallbackLocale, PageTexts>> = {
  en: {
    title: 'MCP authorization',
    okHeading: '✅ Connected',
    failHeading: '⚠️ Authorization failed',
    closeHint: 'You can close this tab and return to the MCP Control Center.',
    messages: {
      notConfigured: 'MCP OAuth is not configured.',
      malformedIssuer: 'The authorization response carried a malformed issuer.',
      providerError: 'The provider returned an error:',
      missingCodeOrState: 'Missing code or state.',
      connected: 'The server is now authorized for you.',
      completerMismatch:
        'This authorization link was started by a different account (or you are not signed in). Nothing was stored. Sign in and click Connect yourself.',
      issuerMismatch:
        'The authorization response came from an unexpected issuer and was rejected. Nothing was stored. Please start the connection again.',
      failed: 'The authorization could not be completed. Nothing was stored. Details:',
    },
  },
  de: {
    title: 'MCP-Autorisierung',
    okHeading: '✅ Verbunden',
    failHeading: '⚠️ Autorisierung fehlgeschlagen',
    closeHint: 'Du kannst diesen Tab schließen und zum MCP Control Center zurückkehren.',
    messages: {
      notConfigured: 'MCP-OAuth ist nicht eingerichtet.',
      malformedIssuer: 'Die Antwort des Anbieters enthielt einen fehlerhaften Aussteller (issuer).',
      providerError: 'Der Anbieter hat einen Fehler gemeldet:',
      missingCodeOrState: 'Code oder State fehlt.',
      connected: 'Der Server ist jetzt für dich autorisiert.',
      completerMismatch:
        'Dieser Autorisierungslink wurde von einem anderen Konto gestartet (oder du bist nicht angemeldet). Es wurde nichts gespeichert. Melde dich an und klicke selbst auf „Verbinden“.',
      issuerMismatch:
        'Die Antwort kam von einem unerwarteten Aussteller und wurde abgewiesen. Es wurde nichts gespeichert. Starte die Verbindung bitte neu.',
      failed: 'Die Autorisierung konnte nicht abgeschlossen werden. Es wurde nichts gespeichert. Details:',
    },
  },
};

/** The slice of an Express request the locale choice reads. */
export interface AcceptsLanguages {
  acceptsLanguages(...langs: string[]): string | false;
}

/** The browser's preferred of de/en; English when it names neither. */
export function mcpOAuthCallbackLocale(req: AcceptsLanguages): McpOAuthCallbackLocale {
  return req.acceptsLanguages('en', 'de') === 'de' ? 'de' : 'en';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The page. `detail` is untrusted (provider error text, a redacted service
 * error) and is escaped; it follows the localized message, never replaces it.
 */
export function mcpOAuthCallbackPage(
  locale: McpOAuthCallbackLocale,
  ok: boolean,
  message: McpOAuthCallbackMessage,
  detail?: string,
): string {
  const t = TEXTS[locale];
  const detailHtml = detail !== undefined && detail.length > 0 ? ` <code>${escapeHtml(detail)}</code>` : '';
  return (
    `<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>${t.title}</title>` +
    `<body style="font-family:system-ui;padding:2rem;max-width:32rem">` +
    `<h2>${ok ? t.okHeading : t.failHeading}</h2><p>${escapeHtml(t.messages[message])}${detailHtml}</p>` +
    `<p>${t.closeHint}</p></body></html>`
  );
}
