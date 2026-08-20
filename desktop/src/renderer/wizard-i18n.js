/**
 * First-run wizard localization (F1 from the 2026-08-20 packaged-app retest).
 *
 * The wizard is the FIRST thing a customer sees, and the first field test
 * (OM-28: "Englische Texte in der deutschen Oberfläche") came from exactly the
 * audience this product targets — German Mittelstand users without deep
 * technical background. The web-ui has full next-intl support; the wizard is a
 * plain static renderer with a strict CSP, so it gets the smallest thing that
 * is correct: English source text in the markup, a German overlay applied at
 * boot when the OS locale is German.
 *
 * Mechanics:
 *  - Markup strings carry `data-i18n="<key>"` (or `data-i18n-placeholder`,
 *    `data-i18n-title` for attributes). `applyWizardLocale()` swaps them.
 *  - JS-side strings go through `wizardT('<key>')`, which returns the German
 *    text when active, else the English default passed by the caller.
 *  - Locale = `navigator.language` — the OS UI language of the machine the
 *    desktop app runs on, which for a desktop product is the user's actual
 *    preference (the in-app web-ui has its own switcher once the stack is up).
 *
 * Adding a language = adding one dictionary object here. Keys missing from a
 * dictionary fall back to the English markup text, so a partial translation
 * degrades to mixed language, never to broken UI.
 */
'use strict';

(function () {
  var DICTS = {
    de: {
      // rail
      'steps.welcome': 'Willkommen',
      'steps.provider': 'KI-Anbieter',
      'steps.capabilities': 'Funktionen',
      'steps.data': 'Datenablage',
      'steps.recovery': 'Wiederherstellung',
      'rail.foot': 'Eine Installation · eigener Schlüssel · deine Daten',
      // step 0
      'welcome.title': 'omadia auf deinem Rechner',
      'welcome.lead':
        'omadia installiert einen vollständigen lokalen Stack — den Kernel, die Verwaltungsoberfläche und eine eingebettete Postgres-Datenbank — und betreibt alles auf diesem Computer. Kein Docker, kein Cloud-Konto. Deine Daten und dein KI-Schlüssel verlassen den Rechner nicht.',
      'welcome.fact1': 'Eingebettete Datenbank mit Vektor-Suche, lokal gespeichert.',
      'welcome.fact2': 'Du bringst deinen eigenen KI-Anbieter-Schlüssel mit.',
      'welcome.fact3': 'Bei einer Deinstallation wird alles sauber entfernt.',
      // step 1
      'provider.title': 'KI-Anbieter verbinden',
      'provider.lead':
        'omadia nutzt deinen eigenen Schlüssel. Er wird verschlüsselt im Schlüsselbund deines Betriebssystems gespeichert.',
      'provider.label': 'Anbieter',
      'provider.keyLabel': 'API-Schlüssel',
      'provider.test': 'Schlüssel testen',
      // step 2
      'caps.title': 'Optionale Funktionen',
      'caps.lead':
        'Das lässt sich später jederzeit ändern. Der Kern (Chat, Gedächtnis, Protokoll) funktioniert immer.',
      'caps.attachments': 'Anhänge',
      'caps.attachmentsHint': 'Hochgeladene Dateien lokal auf der Festplatte speichern.',
      'caps.embeddings': 'Semantisches Gedächtnis',
      'caps.embeddingsBadge': 'Vorschau',
      'caps.embeddingsHint':
        'Lokale Einbettungen zur Themen-Erkennung. Lädt beim ersten Einsatz ein kleines Modell herunter.',
      'caps.diagrams': 'Diagramme',
      'caps.diagramsBadge': 'braucht Netzwerk',
      'caps.diagramsHint': 'Diagramme über den gehosteten omadia-Dienst rendern.',
      // step 3
      'data.title': 'Wo soll omadia Daten speichern?',
      'data.lead': 'Datenbank, verschlüsselte Geheimnisse und Uploads liegen hier.',
      'data.placeholder': 'Standard-Anwendungsdaten-Ordner',
      'data.choose': 'Auswählen…',
      'data.hint': 'Es wird der Standard-Anwendungsdaten-Ordner deines Benutzerkontos verwendet.',
      // step 4
      'recovery.title': 'Wiederherstellungsschlüssel sichern',
      'recovery.lead':
        'Dieser Schlüssel verschlüsselt deinen Geheimnis-Tresor. Wenn du omadia je auf einen neuen Rechner umziehst, brauchst du ihn. Geht er verloren, sind gespeicherte Geheimnisse nicht wiederherstellbar.',
      'recovery.reveal': 'Anzeigen',
      'recovery.hint': 'Er liegt zusätzlich sicher im Schlüsselbund dieses Rechners.',
      // provisioning
      'provision.title': 'omadia wird eingerichtet…',
      'provision.starting': 'Starte…',
      'provision.hint':
        'Der erste Start führt Datenbank-Migrationen aus — das kann bis zu einer Minute dauern.',
      // nav
      'nav.back': 'Zurück',
      'nav.continue': 'Weiter',
      'nav.finish': 'Abschließen & omadia starten',
      // JS-side strings
      'js.testing': 'Wird getestet…',
      'js.keyWorks': 'Schlüssel funktioniert.',
      'js.keyTooShort': 'Der Schlüssel sieht zu kurz aus.',
      'js.keyCheckFailed': 'Schlüsselprüfung fehlgeschlagen.',
      'js.keyCheckFailedInternal': 'Schlüsselprüfung fehlgeschlagen (interner Fehler).',
      'js.unverifiedHint':
        'Dieser Schlüssel wurde noch nicht geprüft. Klicke auf „Schlüssel testen" — oder noch einmal auf „Weiter", um ihn ungeprüft einzurichten.',
      'js.setupCrashed': 'Die Einrichtung ist unerwartet abgebrochen.',
      'js.setupFailed': 'Einrichtung fehlgeschlagen. Prüfe die Logs (Tray → Logs öffnen).',
      'js.pickerFailed':
        'Der Ordner-Dialog ließ sich nicht öffnen: {msg}. Es wird der Standard-Ordner verwendet.',
      'js.bridgeMissing':
        'Interner Fehler: Die App-Brücke wurde nicht geladen. Bitte neu installieren oder melden (Tray → Logs öffnen).',
    },
  };

  var active = null;
  var lang = (navigator.language || '').toLowerCase();
  if (lang.indexOf('de') === 0) active = DICTS.de;

  /** JS-string lookup: translated text when active, else the given default. */
  window.wizardT = function (key, fallback) {
    if (active && Object.prototype.hasOwnProperty.call(active, key)) {
      return active[key];
    }
    return fallback;
  };

  /** Swap all data-i18n-marked markup. Call once at boot, before first paint
   *  matters little — the wizard renders instantly from local files. */
  window.applyWizardLocale = function () {
    if (!active) return;
    document.documentElement.lang = 'de';
    document.title = 'Willkommen bei omadia';
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i += 1) {
      var key = nodes[i].getAttribute('data-i18n');
      if (Object.prototype.hasOwnProperty.call(active, key)) {
        nodes[i].textContent = active[key];
      }
    }
    var phNodes = document.querySelectorAll('[data-i18n-placeholder]');
    for (var j = 0; j < phNodes.length; j += 1) {
      var pk = phNodes[j].getAttribute('data-i18n-placeholder');
      if (Object.prototype.hasOwnProperty.call(active, pk)) {
        phNodes[j].setAttribute('placeholder', active[pk]);
      }
    }
  };
})();
