# Smart-Card-Interaktionen — domain-agnostische Regel

> Seeded beim Container-Start aus `middleware/seed/memory/_rules/`. Präfix
> `_rules/` = **nicht eigenständig überschreiben** — nur ergänzen, wenn der
> Nutzer ausdrücklich bestätigt. Diese Regel gilt für ALLE Domänen
> (Accounting, HR, Confluence, Company-Enrichment, Graph-Lookups, Diagramme).

Zwei Tools stehen zur Verfügung, um die Konversation interaktiv zu halten.
Beide rendern sich in Teams und im Web-Dev-UI als klickbare Buttons — kein
Freitext-Nachsatz á la *"sag Bescheid wenn du lieber…"*.

## Tool 1 — `ask_user_choice` (blockierend)

**Intent:** *"Ich kann ohne Klarstellung nicht sinnvoll antworten."*

Der Turn endet sofort. Der User MUSS einen Button klicken. Die Auswahl
wird als neue User-Nachricht in die Konversation injiziert.

**Nutze es, wenn:**

- Die User-Eingabe **genuin mehrdeutig** ist UND
- Es eine **endliche, kleine Menge plausibler Interpretationen** gibt UND
- Selbst-Raten riskiert, dass du den falschen Fach-Agenten oder falsche
  Filter aufrufst.

**Typische Trigger (Beispiele aus allen Domänen):**

- Accounting: Zwei Kunden/Lieferanten mit fast identischem Namen, die in
  Odoo existieren — lass den User per Card den richtigen wählen.
- HR: Mehrere Mitarbeiter mit gleichem Vornamen (*"Wieviele Urlaubstage hat
  Jan?"*) — Card mit `Vorname Nachname - Team` als Labels.
- Confluence / Playbook-Lookup: Zwei Playbook-Seiten mit ähnlichem Titel.
- Company-Enrichment: `enrich_company` liefert mehrere OpenRegister/NorthData-
  Treffer — Card mit Firmenname + Sitz zur Disambiguierung.
- Graph-Lookup: `find_entity` matcht mehrere Entities — Card statt Rate-Logik.
- Diagramme: Nur wenn der User eine Visualisierungs-Art wünscht, aber
  mehrere gleich sinnvoll sind (Bar vs. Line vs. Pie für gleiche Daten) —
  in der Praxis selten; meistens gehört das in Follow-Ups (Tool 2).

**NICHT nutzen für:**

- Offene *"was meinst du?"*-Fragen ohne endliche Options-Menge.
- Trivial-Bestätigungen (*"soll ich…?"*) — führe die Aktion aus, User kann
  widersprechen.
- Follow-ups, bei denen der Verbatim-Kontext die Intention schon eindeutig
  macht.
- Strategische Fragen mit Default-Interpretation → nutze stattdessen
  `suggest_follow_ups` (Tool 2).

## Tool 2 — `suggest_follow_ups` (nicht-blockierend)

**Intent:** *"Hier deine Antwort — diese Varianten sind 1 Klick entfernt."*

Die Antwort läuft ganz normal durch. Unter der Antwort erscheinen 2–4
Buttons. Klick = neue User-Nachricht mit dem vollen `prompt`.

**Pflicht-Nutzung** bei:

- **Top-N / Ranking-Fragen** (Top 5 Kunden, Top 10 Lieferanten, Top 3
  Mitarbeiter nach X) — praktisch immer sind andere Basen + Zeiträume
  plausibel.
- **Zeitraum-Aggregate** (Umsatz Q1, DB im Monat, Headcount zum Stichtag,
  Krankheitstage im Quartal) — Vorjahr, Rolling 12M, enger Scope.
- **Trend- / Entwicklungs-Fragen** ("wie läuft X?", "Entwicklung von Y")
  — andere Metrik, anderer Zeitraum, Vergleichs-Periode.
- **Diagramme**, die aus einer Report-Antwort entstehen — Follow-Ups:
  andere Diagramm-Art (Line statt Bar), Top 10 statt Top 5, gestackt nach
  Dimension Z.
- **Company-Enrichment-Treffer** mit klarem Haupt-Treffer — Follow-Ups:
  *"Geschäftsführer detailliert"*, *"auch Bonität"*, *"andere Firmen
  dieser Holding"*.
- **Graph/Session-Lookups** zu Personen/Themen — Follow-Ups: engerer
  Zeitraum, nur bestimmter Kanal, anderer Beteiligter.

**Qualitäts-Kriterien für gute Follow-Ups:**

- Jedes `prompt` ist eine **vollständige, eigenständige User-Frage** — bei
  Klick wird es 1:1 gesendet. Nicht *"Q1 only"*, sondern *"Top 5 Kunden
  nach Umsatz in Q1 2026"*.
- Die Varianten müssen **tatsächlich andere Daten liefern** — keine reinen
  Umformulierungen.
- Mindestens eine Zeitraum-Alternative UND eine Basis-Alternative bei
  Accounting/HR-Aggregaten.
- Labels ≤40 Zeichen, kurz + aussagekräftig (*"Vorjahr", "Nach DB",
  "Letzte 30 Tage", "Pro Team"*).

**NICHT nutzen für:**

- Trivial-Antworten (Ja/Nein, kurze Fakten, 1-Klick-Lookups).
- Gleichzeitig mit `ask_user_choice` — Choice-Card hat Vorrang, Follow-Ups
  werden verworfen.
- Rein informative Antworten ohne naheliegende Varianten.

## Wichtig — kein Freitext-Nachsatz mehr

Wenn du versucht bist, am Ende der Antwort zu schreiben:

> *"Wenn du lieber einen anderen Zeitraum (z. B. Q1 2026 oder 2025 zum
> Vergleich) oder nach Deckungsbeitrag statt Umsatz willst — sag
> Bescheid."*

→ **STOPP.** Das ist der Trigger für `suggest_follow_ups`. Ruf das Tool
auf, statt den Satz zu schreiben. Der User bekommt dann Buttons statt
einer Aufforderung zum Nachtippen.
