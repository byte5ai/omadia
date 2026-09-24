/**
 * #1094 — the user-facing wording for a DEGRADED turn: one where a tool call
 * committed a real side effect and a later step of the same turn threw.
 *
 * The orchestrator itself composes no prose. It puts a neutral, language-free
 * marker (`<turn-incomplete tools="…" ref="…"></turn-incomplete>`) in the
 * answer and persists THAT, so the session log and the KG turn node stay
 * language-free and no consumer is handed a fake success. The wording is
 * composed here, at the delivery boundary, through the same locale mechanism
 * that composes the AI-Act marking (`composeDisclosureText`) — so a German
 * deployment gets German, exactly like every other user-facing text.
 *
 * Why the sentence exists at all, rather than a bare flag plus a rich-client
 * warning: Teams, Telegram and email render `done.answer` and nothing else. A
 * flag is invisible there, and the raw marker is unreadable — both would leave
 * those users worse off than the (wrong-language, falsely-successful) sentence
 * this replaced. The web chat renders this text as well, under a UI-localized
 * warning heading it derives from the `degraded` / `committedTools` /
 * `correlationId` fields — so its body is in the operator's locale, which can
 * differ from the UI locale.
 */

import { normalizeDisclosureLocale } from './aiDisclosure.js';

/**
 * Compose the degraded-turn notice in DE or EN, plain text.
 *
 * `committedTools` are tool ids and are rendered verbatim — they are not
 * translatable, and naming them is the point: the user must know what already
 * ran before they repeat the request.
 */
export function composeTurnIncompleteText(
  locale: string | undefined,
  committedTools: readonly string[],
  correlationId?: string,
): string {
  const lang = normalizeDisclosureLocale(locale);
  const tools = committedTools.filter((t) => t.trim().length > 0);
  const ref =
    correlationId === undefined || correlationId.trim().length === 0
      ? undefined
      : correlationId.trim();

  if (lang === 'en') {
    return [
      'This turn did not finish.',
      tools.length > 0
        ? `These actions had already run and took effect: ${tools.join(', ')}.`
        : 'Actions in this turn had already run and took effect.',
      'Generating the answer failed afterwards, so your question is still unanswered. Ask it again — and check before repeating anything that changes data.',
      ...(ref ? [`Reference for support: ${ref}`] : []),
    ].join(' ');
  }
  return [
    'Dieser Turn wurde nicht abgeschlossen.',
    tools.length > 0
      ? `Diese Aktionen waren bereits ausgeführt und sind wirksam: ${tools.join(', ')}.`
      : 'Aktionen in diesem Turn waren bereits ausgeführt und sind wirksam.',
    'Danach ist die Antwort-Erzeugung fehlgeschlagen — deine Frage ist also noch offen. Stelle sie erneut; alles, was Daten verändert, vorher prüfen.',
    ...(ref ? [`Referenz für den Support: ${ref}`] : []),
  ].join(' ');
}
