import type { Request, Response } from 'express';

/**
 * #1964 — what a signed file link answers when it cannot serve the file.
 *
 * A browser that opens the link (a click on a file chip or an image in a new
 * tab) gets a short, readable HTML page in German and English that says what
 * happened and how to get the file again. Every other client (an `<img>`
 * fetch, Teams, curl) keeps the plain-text body it always got, so nothing that
 * parses these answers changes. Shared by `/diagrams/dl` and `/documents/dl`.
 */
export type FileLinkError = 'expired' | 'not_found' | 'failed' | 'bad_request';

const PLAIN: Readonly<Record<FileLinkError, string>> = {
  expired: 'invalid or expired signature',
  not_found: 'not found',
  failed: 'internal error',
  bad_request: 'missing key',
};

const PAGES: Readonly<Record<FileLinkError, { title: string; de: string; en: string }>> = {
  expired: {
    title: 'Link abgelaufen · Link expired',
    de: 'Dieser Datei-Link ist abgelaufen oder ungültig. Download-Links gelten nur eine begrenzte Zeit. Bitte den Assistenten im Chat, die Datei oder das Diagramm neu zu erstellen — du bekommst dann einen frischen Link.',
    en: 'This file link has expired or is not valid. Download links only work for a limited time. Ask the assistant in the chat to create the file or diagram again; you will get a fresh link.',
  },
  not_found: {
    title: 'Datei nicht gefunden · File not found',
    de: 'Diese Datei gibt es nicht mehr. Bitte den Assistenten im Chat, sie neu zu erstellen.',
    en: 'This file no longer exists. Ask the assistant in the chat to create it again.',
  },
  failed: {
    title: 'Download fehlgeschlagen · Download failed',
    de: 'Die Datei konnte gerade nicht geladen werden. Versuche es gleich noch einmal; wenn es weiter fehlschlägt, sag dem Betreiber Bescheid.',
    en: 'The file could not be loaded right now. Try again in a moment; if it keeps failing, tell the operator.',
  },
  bad_request: {
    title: 'Ungültiger Link · Invalid link',
    de: 'Dieser Link ist unvollständig. Öffne den Link direkt aus dem Chat.',
    en: 'This link is incomplete. Open it directly from the chat.',
  },
};

const STATUS: Readonly<Record<FileLinkError, number>> = {
  expired: 403,
  not_found: 404,
  failed: 500,
  bad_request: 400,
};

/** Did a browser navigate here (HTML preferred over plain text)? */
function wantsHtml(req: Request): boolean {
  return req.accepts(['text/plain', 'text/html']) === 'text/html';
}

export function renderFileLinkErrorPage(kind: FileLinkError): string {
  const page = PAGES[kind];
  return (
    '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${page.title}</title>` +
    '<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#222}' +
    'h1{font-size:1.25rem}p{line-height:1.5}</style></head><body>' +
    `<h1>${page.title}</h1><p>${page.de}</p><p lang="en">${page.en}</p></body></html>`
  );
}

export function sendFileLinkError(req: Request, res: Response, kind: FileLinkError): void {
  res.status(STATUS[kind]);
  if (wantsHtml(req)) {
    res.setHeader('cache-control', 'no-store');
    res.type('text/html').send(renderFileLinkErrorPage(kind));
    return;
  }
  res.type('text/plain').send(PLAIN[kind]);
}
