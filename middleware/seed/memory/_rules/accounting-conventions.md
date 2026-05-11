# Accounting-Konventionen (byte5) — harte Regeln

> Diese Datei wird beim Container-Start aus dem Repo geseedet. Ändere sie im
> Repo, nicht im Betrieb. Der Präfix `_rules/` signalisiert: **nicht eigenständig
> überschreiben** — nur ergänzen, wenn ausdrücklich vom Nutzer bestätigt.

## Umsatz-Zahlen

- **Nur gebuchte, nicht stornierte Rechnungen zählen.** In Odoo-Begriffen:
  `move_type='out_invoice'` UND `state='posted'`. Verwirf alles mit
  `state IN ('draft','cancel')`.
- **Gutschriften** (`move_type='out_refund'`) werden bei Umsatz-Fragen **nicht**
  mitgezählt. Wenn der Nutzer "Netto nach Gutschriften" oder "tatsächlicher
  Erlös" fragt, explizit nachfragen und ggf. `out_refund` gegenrechnen.
- **Währung:** Standard ist EUR. Wenn der Nutzer keinen Filter nennt, auf
  `currency_id.name='EUR'` filtern oder sonst Währungen getrennt ausweisen —
  **niemals über Währungen hinweg summieren**.
- **Netto vs. Brutto:** Bei "Umsatz" ohne weitere Qualifizierung = **Netto**
  (`amount_untaxed` bzw. `amount_untaxed_signed`). Bei "Brutto" oder "mit MwSt."
  = `amount_total`.
- **Firmen-Scope:** Wenn die Odoo-Instanz mehrere Firmen enthält und der Nutzer
  nicht klärt, welche gemeint ist, zuerst zurückfragen statt firmenübergreifend
  zu aggregieren.

## Zeiträume

- "Geschäftsjahr" bei byte5 = **Kalenderjahr** (Januar–Dezember), solange nicht
  anders bestätigt.
- "YTD" = 1. Januar bis heutiges Datum.
- Relative Begriffe ("letzter Monat", "Q1") immer in ISO-Datumsgrenzen auflösen
  und im Antworttext explizit machen.

## Offene Posten

- Offene Forderungen / Verbindlichkeiten werden über
  `payment_state IN ('not_paid','partial')` ermittelt, kombiniert mit
  `state='posted'`. Bei offenen Posten **immer `amount_residual` ausweisen**,
  nicht `amount_total`.

## Fälligkeitsanalyse (Aging)

- Buckets: 0–30, 31–60, 61–90, >90 Tage (Standard, falls Nutzer nichts anderes
  angibt).
- Basis: `date_maturity` vs. heutiges Datum.

## Antworten

- Sprache: **Deutsch**.
- Bei Zahlen immer Währung angeben. Tausenderpunkt, Dezimalkomma.
- Bei Top-N-Listen den Zeitraum ausweisen. Wenn mehrere Zeiträume relevant
  sind (Vorjahr + YTD), beide nebeneinander zeigen.
- Smart-Card-Nutzung (`ask_user_choice` / `suggest_follow_ups`): siehe
  `/memories/_rules/smart-cards.md` — domain-agnostische Regel für alle
  Bereiche.
