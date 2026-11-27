/**
 * #1959 — the page the MCP OAuth callback shows in the starter's browser tab,
 * in the browser's language (`Accept-Language`, de or en; English otherwise).
 * The web-ui catalog cannot serve it: the callback is a middleware route the
 * provider redirects to, outside the Next app.
 */

import { createHash } from 'node:crypto';

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

/** The Teams JavaScript SDK the hand-back page loads (same build the Teams plugin's tabs use). */
export const TEAMS_JS_SDK_URL = 'https://res.cdn.office.net/teams-js/2.34.0/js/MicrosoftTeams.min.js';
/** Subresource integrity of {@link TEAMS_JS_SDK_URL}: the page holds an authorization code. */
export const TEAMS_JS_SDK_INTEGRITY = 'sha384-brW9AazbKR2dYw2DucGgWCCcmrm2oBFV4HQidyuyZRI/TnAkmOOnTARSTdps3Hwt';

const HAND_BACK_TEXTS: Readonly<Record<McpOAuthCallbackLocale, { title: string; working: string; outside: string }>> = {
  en: {
    title: 'MCP authorization',
    working: 'Finishing the connection in Microsoft Teams…',
    outside:
      'This connection was started in Microsoft Teams and can only be finished there. Close this window and start Connect again in Teams.',
  },
  de: {
    title: 'MCP-Autorisierung',
    working: 'Die Verbindung wird in Microsoft Teams abgeschlossen…',
    outside:
      'Diese Verbindung wurde in Microsoft Teams gestartet und lässt sich nur dort abschließen. Schließe dieses Fenster und starte „Verbinden“ in Teams erneut.',
  },
};

/** What the provider sent back, handed to the Teams authentication window. */
export interface TeamsHandBackPayload {
  readonly state: string;
  readonly code: string;
  readonly iss: string | null;
  readonly error: string | null;
}

/**
 * #2312 / ADR-0301 — the callback page of a flow a directory person started
 * with their Teams SSO token. It exchanges nothing: it returns state, code and
 * iss to the Teams authentication window that opened the provider
 * (`authentication.notifySuccess`), whose page completes the flow with the
 * same person's SSO token. Outside Teams it only says to finish there. The
 * payload is JSON in a data block with `<` escaped, never interpolated into
 * script source.
 */
export function mcpOAuthTeamsHandBackPage(locale: McpOAuthCallbackLocale, payload: TeamsHandBackPayload): {
  readonly html: string;
  /** The page's own Content-Security-Policy: only the SDK and the one inline script run. */
  readonly csp: string;
} {
  const t = HAND_BACK_TEXTS[locale];
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  const script = handBackScript(escapeHtml(t.outside));
  const scriptHash = createHash('sha256').update(script).digest('base64');
  const html =
    `<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>${t.title}</title>` +
    `<body style="font-family:system-ui;padding:2rem;max-width:32rem">` +
    `<p id="msg">${escapeHtml(t.working)}</p>` +
    `<script type="application/json" id="payload">${data}</script>` +
    `<script src="${TEAMS_JS_SDK_URL}" integrity="${TEAMS_JS_SDK_INTEGRITY}" crossorigin="anonymous"></script>` +
    `<script>${script}</script></body></html>`;
  return {
    html,
    csp: `default-src 'none'; script-src 'sha256-${scriptHash}' https://res.cdn.office.net; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

/** The page's only inline script; hashed into its CSP. */
function handBackScript(outsideHtml: string): string {
  return (
    `(function(){var outside=${JSON.stringify(outsideHtml)};` +
    `function fail(){document.getElementById('msg').innerHTML=outside;}` +
    `var p=JSON.parse(document.getElementById('payload').textContent);` +
    `var t=window.microsoftTeams;if(!t||!t.app){fail();return;}` +
    `var done=false;setTimeout(function(){if(!done)fail();},5000);` +
    `t.app.initialize().then(function(){done=true;` +
    `if(p.error){t.authentication.notifyFailure(p.error);}else{t.authentication.notifySuccess(JSON.stringify(p));}` +
    `},fail);})();`
  );
}
