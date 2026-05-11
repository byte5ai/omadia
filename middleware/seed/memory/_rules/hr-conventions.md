# HR-Konventionen (byte5) — harte Regeln

> Diese Datei wird beim Container-Start aus dem Repo geseedet. Ändere sie im
> Repo, nicht im Betrieb. Präfix `_rules/` = **nicht eigenständig
> überschreiben** — nur ergänzen, wenn der Nutzer ausdrücklich bestätigt.

## Standard-Filter

- Default `active=true`. Ehemalige Mitarbeiter (`active=false`) nur auf
  ausdrückliche Nutzer-Anfrage einbeziehen.
- Alle HR-Zahlen immer mit **Stand: YYYY-MM-DD** ausweisen — HR-Kennzahlen
  wandern wöchentlich (neue Einstellungen, Austritte, genehmigte Abwesenheiten).

## Geschäftsjahr & Zeiträume

- Geschäftsjahr = **Kalenderjahr** (identisch zu den Accounting-Konventionen).
- "Headcount zum Stichtag" = Anzahl aktiver Mitarbeiter an genau diesem Datum.
- "Ø Headcount <Jahr>" = `(Headcount 01.01. + Headcount 31.12.) / 2`, wenn
  der Nutzer nichts anderes anfragt. Für genauere Analysen Monatsdurchschnitt
  explizit bestätigen lassen.
- Relative Zeitbegriffe ("letztes Quartal", "dieses Jahr") immer in ISO-
  Datumsgrenzen auflösen und im Antworttext ausweisen.

## Company-Scope

- Bei Multi-Company-Odoo zuerst klären, welches Unternehmen gemeint ist,
  bevor firmenübergreifend aggregiert wird.

## Mitarbeiter-Typen (`hr.employee.employee_type`)

- `employee` → Festanstellung (Kernbelegschaft)
- `worker` → Arbeiter (Kernbelegschaft)
- `student` → Werkstudent
- `freelance`, `contractor` → externe Vertragspartner
- Konvention "Mitarbeiter" ohne weitere Qualifizierung = `employee` +
  `worker` (Kernbelegschaft). Externe und Werkstudenten nur, wenn der
  Nutzer es explizit adressiert.

## Urlaub

- Standard-Urlaubsanspruch (Vollzeit): **30 Tage / Kalenderjahr** — `TODO:
  BYTE5-WERT BESTÄTIGEN`. Bei Teilzeit anteilig.
- Genommener Urlaub = `hr.leave` mit `state='validate'` und
  `holiday_status_id` vom Typ Urlaub (nicht Krankheit/Sonder).
- Geplanter Urlaub = `hr.leave` mit `state='confirm'` (noch nicht
  genehmigt: `state='draft'`, diese i.d.R. NICHT in Reports aufnehmen).
- Offenes Kontingent pro Mitarbeiter = Summe
  `hr.leave.allocation(state='validate')` − Summe
  `hr.leave(state='validate')` für den jeweiligen `holiday_status_id`.

## Krankheit

- "Krankheitstag" = `hr.leave` mit `holiday_status_id` vom Typ Krankheit
  und `state='validate'`.
- Krankheitsquote (Firma/Abteilung) = `Krankheitstage / Soll-Arbeitstage`
  im Zeitraum × 100. Soll-Arbeitstage über `resource.calendar` des
  Mitarbeiters ableiten.
- Bei Einzelpersonen-Ebene nur Anzahl Tage nennen, **keine Diagnosen,
  keine Begründungstexte, keine konkreten Zeitfenster auf Abteilungs-
  Ebene sichtbar**.

## Arbeitszeitmodelle

- Vollzeit-Soll: **40 Std./Woche** — `TODO: BYTE5-WERT BESTÄTIGEN`
- Teilzeit: individuelles `resource_calendar_id` pro Mitarbeiter.
- FTE-Zählung = Summe `resource_calendar_id.hours_per_day ×
  arbeitstage_pro_woche / 40`. Für "Anzahl Personen" unabhängig von
  FTE-Anteil: `hr.employee.search_count([active=true])`.

## Betriebszugehörigkeit & Jubiläen

- Eintrittsdatum = `hr.contract` mit ältestem `date_start` pro Employee
  (nicht `create_date` vom Employee-Record, der kann nachträglich gesetzt
  worden sein).
- Für Jubiläumsreports `date_start` heute minus N Jahre filtern.

## Reporting-Kennzahlen

- **Fluktuation** (p.a.) = `Austritte im Zeitraum / Ø Headcount × 100`, in %.
  Austritte über `active=false` AND `hr.contract.date_end` im Zeitraum.
- **Fehlzeiten-Quote** = bezahlte Abwesenheitstage (Urlaub + Krank + Sonder)
  / Soll-Arbeitstage × 100.
- **Recruiting-Pipeline** = `hr.applicant` nicht in Endstadien
  (`stage_id` exklusive "Hired", "Refused", "Archived").

## Team- & Abteilungs-Glossar (aktueller Stand, bei Zweifel per
`hr.department` verifizieren)

- **Delivery-Teams:** T1 (.NET), T2 (PHP), T3 (JS), T3.1 (UX/UI)
- **Service-Bereiche:** S2 (Hosting), S3 (Extern)
- **Leitung/Geschäftsführung:** G7
- Diese Mapping-Tabelle korrespondiert mit den Kostenstellen-Codes im
  Accounting (siehe `/memories/conventions/kostenstellen.md`). Bei
  Mischfragen (z.B. "Umsatz pro Team") über diese Codes verknüpfen.

## Begriffs-Konventionen

- "Mitarbeiter" ohne Qualifizierung = **Kernbelegschaft aktiv**
  (`employee` + `worker`, `active=true`).
- "Team" / "Abteilung" = `hr.department`.
- "Manager eines Mitarbeiters" = `hr.employee.parent_id` (direkter
  Vorgesetzter), **nicht** `hr.department.manager_id`, außer der Nutzer
  fragt explizit nach dem Abteilungs-Leiter.
- "Abteilungsleiter" = `hr.department.manager_id`.
