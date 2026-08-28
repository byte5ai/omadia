/**
 * Localization for the Electron shell itself (OM-59).
 *
 * omadia had THREE language layers that did not know about each other: the
 * web-ui (next-intl, fully translated, with its own switcher), the first-run
 * wizard (`renderer/wizard-i18n.js`, keyed off `navigator.language`), and the
 * shell — native dialogs, the loading screen and the menu bar — which had no
 * language source at all and was English throughout. So a German user was
 * asked, in English, whether the program may close and touch their data.
 *
 * This module is the shell's dictionary. It deliberately does NOT import
 * `electron`: the locale is passed in, which keeps it a pure lookup that tests
 * can drive without an Electron runtime. `main.ts` supplies `app.getLocale()`.
 *
 * Scope split, so nothing is translated twice: the phase strings a *renderer*
 * shows (`boot.*`) stay in `wizard-i18n.js`, which both the wizard and the
 * loading screen read. This file owns only strings the MAIN process renders —
 * dialog copy and menu headings. The two key sets are disjoint.
 *
 * Adding a language = adding one dictionary. A missing key falls back to the
 * English default the caller passes, so a partial translation degrades to
 * mixed language and never to an empty dialog.
 */

/** A resolved translator: key plus the English source text as fallback. */
export type ShellTranslate = (key: string, fallback: string) => string;

type Dictionary = Readonly<Record<string, string>>;

const DE: Dictionary = {
  // --- Boot failure dialog (OM-56 rewrite) ---------------------------------
  'boot.failed.title': 'omadia konnte nicht starten',
  'boot.failed.message': 'omadia konnte seine lokalen Dienste nicht starten.',
  'boot.failed.detail':
    'Du kannst die Einrichtung erneut ausführen oder das Programm beenden.\n\nTechnische Details für den Support:\n{error}\n\nLogdatei: {logFile}',
  'boot.failed.rerunSetup': 'Einrichtung erneut ausführen',
  'boot.failed.quit': 'Beenden',

  // --- Superseded boot (OM-56): a state, not a failure --------------------
  'boot.superseded.title': 'Update wird angewendet',
  'boot.superseded.message': 'omadia wendet gerade ein Update an.',
  'boot.superseded.detail':
    'Bitte warte, bis der Vorgang abgeschlossen ist. Das Fenster aktualisiert sich von selbst.',
  'boot.superseded.ok': 'OK',

  // --- Renderer crash / load failure (OM-57) ------------------------------
  // No auto-reload is promised anywhere here: the shell deliberately does NOT
  // retry (see `recoverRenderer`), and the first version of this dictionary
  // told German users to wait for a reload that never came while the English
  // fallback said nothing of the sort. One live key, both variants saying the
  // same thing.
  'shell.loadFailed.uiGone':
    'Die Verbindung zur Oberfläche wurde unterbrochen. Über das Menüleisten-Symbol kannst du omadia neu starten.',
  'shell.loadFailed.exhausted.title': 'Oberfläche konnte nicht geladen werden',
  'shell.loadFailed.exhausted.message':
    'omadia konnte die Oberfläche nach mehreren Versuchen nicht laden.',
  'shell.loadFailed.exhausted.detail':
    'Weitere Versuche werden nicht unternommen, um eine Endlosschleife zu vermeiden.\n\nStarte omadia neu. Bleibt der Fehler, sende bitte die Logdatei an den Support:\n{logFile}',
  'shell.loadFailed.exhausted.ok': 'OK',

  // --- Restart refused while the wizard is open (OM-58 follow-up) ----------
  'shell.restartRefused.title': 'Neustart nicht möglich',
  'shell.restartRefused.message': 'Die Ersteinrichtung läuft noch.',
  'shell.restartRefused.detail':
    'omadia startet die lokalen Dienste nicht neu, solange die Ersteinrichtung offen ist — das würde deine Eingaben verwerfen. Schließe die Einrichtung ab und versuche es danach erneut.',
  'shell.restartRefused.ok': 'OK',

  // --- Recovery key (OM-58) ----------------------------------------------
  'recovery.menuItem': 'Wiederherstellungsschlüssel anzeigen…',
  'recovery.title': 'Wiederherstellungsschlüssel',
  'recovery.message': 'Bewahre diesen Schlüssel an einem sicheren Ort auf.',
  'recovery.detail':
    'Dieser Schlüssel verschlüsselt deinen Geheimnis-Tresor. Wenn du omadia auf einen neuen Rechner umziehst, brauchst du ihn. Geht er verloren, sind gespeicherte Geheimnisse nicht wiederherstellbar.\n\n{key}',
  'recovery.copy': 'In die Zwischenablage kopieren',
  'recovery.close': 'Schließen',
  'recovery.unavailableTitle': 'Wiederherstellungsschlüssel nicht verfügbar',
  'recovery.unavailableDetail':
    'Der Schlüssel konnte nicht gelesen werden: {error}\n\nLogdatei: {logFile}',
  'recovery.reminder.title': 'Wiederherstellungsschlüssel noch nicht gesichert',
  'recovery.reminder.message':
    'Du hast deinen Wiederherstellungsschlüssel noch nicht angezeigt.',
  'recovery.reminder.detail':
    'omadia betreibt eine lokale Datenbank. Ohne diesen Schlüssel sind gespeicherte Geheimnisse nach einem Rechnerwechsel nicht wiederherstellbar.\n\nDu findest ihn jederzeit unter „Hilfe" → „{menuItem}".',
  'recovery.reminder.show': 'Jetzt anzeigen',
  'recovery.reminder.later': 'Später',

  // --- Menu headings (OM-59) ---------------------------------------------
  // Electron localizes `role:` ENTRIES with the OS language for free, but not
  // the top-level headings, which are plain labels.
  'menu.file': 'Datei',
  'menu.edit': 'Bearbeiten',
  'menu.view': 'Ansicht',
  'menu.window': 'Fenster',
  'menu.help': 'Hilfe',
  'menu.checkForUpdates': 'Nach Updates suchen…',
};

const DICTIONARIES: Readonly<Record<string, Dictionary>> = { de: DE };

/**
 * The language subtag of a BCP-47 locale, lowercased.
 *
 * `app.getLocale()` returns things like `de`, `de-DE`, `de-AT`, `en-GB`. We key
 * on the language only: a German-speaking user in Austria wants German copy,
 * and maintaining region variants buys nothing for the string sets here.
 */
export function languageOf(locale: string | undefined): string {
  if (typeof locale !== 'string') return '';
  const [language] = locale.toLowerCase().split('-');
  return language ?? '';
}

/**
 * Build a translator for a locale. Unknown locales get the identity
 * translator, so callers always render their English source text.
 */
export function createShellTranslate(locale: string | undefined): ShellTranslate {
  const dictionary = DICTIONARIES[languageOf(locale)];
  if (!dictionary) return (_key, fallback) => fallback;
  return (key, fallback) =>
    Object.prototype.hasOwnProperty.call(dictionary, key) ? (dictionary[key] as string) : fallback;
}

/**
 * Substitute `{name}` placeholders.
 *
 * Kept separate from lookup so a translated string and its English fallback
 * interpolate identically — a dictionary that forgets a placeholder degrades to
 * a literal `{name}` in the dialog rather than throwing during an error path,
 * which is the worst possible moment to add a second failure.
 */
export function fillPlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] as string : whole,
  );
}
