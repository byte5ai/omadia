# omadia auf Microsoft Dynamics 365: die Business-Sicht

> **Für wen:** Geschäftsführung, Vertrieb, Controlling, IT-Leitung. Diese Fassung schaut auf Probleme, Wirkung und Risiko, nicht auf Technik. Die technische Schwester liegt unter `dynamics-365-realtime-omadia.md`.
>
> **Status:** Entwurf v1 (Deutsch). Belege aus einer omadia-Testinstanz auf Dynamics 365, Stand 07.06.2026. Kundennamen anonymisiert. Konkrete Umsatzwerte vor externer Nutzung freigeben.

## Management Summary

Die Daten für jede wichtige Geschäftsfrage liegen längst in Dynamics 365. Trotzdem dauert die Antwort auf „Wie war der Umsatz im Mai?" oder „Welcher Kunde ist unser größter?" oft Tage, weil sie über IT oder ein BI-Team läuft. omadia macht aus diesen Fragen ein Gespräch: Eine Fachperson fragt in normaler Sprache, die Antwort kommt live aus dem System, mit Zahlen, die geprüft sind.

In der Testinstanz hat das in wenigen Stunden Dinge sichtbar gemacht, die sonst niemand sucht: einen Kunden, der durch eine Dublette im Ranking falsch einsortiert war (zusammengeführt rund 343.000 € Jahresumsatz), 49 von 74 Preislisten als Karteileichen, und einen scheinbaren Rechnungsrückstand von fast einer halben Million Euro, der sich zu 57 Prozent als Buchungsartefakt entpuppte. Kein neues Reporting-Projekt, kein Datenexport. Nur Fragen und Antworten.

Der eigentliche Hebel ist nicht die einzelne Antwort. Es ist, dass omadia das Geschäft mit jeder Frage besser kennt und dieses Wissen behält. Eine Instanz, die ein Team drei Monate nutzt, ist mehr wert als am ersten Tag. Und sie läuft auf eigener Infrastruktur, die Daten verlassen das Haus nicht.

## Das Problem, in Geschäftssprache

Vier Schmerzen, die fast jedes Unternehmen mit einem gewachsenen Dynamics-System kennt:

**Antworten hängen an der IT.** Jede nicht vorgefertigte Auswertung wird zum Ticket. Bis die Zahl da ist, ist die Entscheidung oft schon gefallen oder die Frage kalt. Fachbereiche bauen sich parallel Excel-Inseln, die niemand pflegt.

**Zahlen, denen man nicht traut.** Zwei Reports, beide „Umsatz 2025", liefern unterschiedliche Werte, weil sie verschiedene Datumsfelder oder Ebenen nehmen. Wer die Differenz nicht kennt, trifft Entscheidungen auf Sand. Im Zweifel glaubt man der Zahl, die ins eigene Bild passt.

**Geld, das liegen bleibt.** Durchgeführte Leistungen, die nicht fakturiert werden. Rabatte, die niemand mehr überblickt. Das fällt selten auf, weil es keinen Alarm gibt, nur fehlenden Umsatz.

**Stammdaten, die verrotten.** Doppelte Kunden, abgelaufene Preislisten, Test-Datensätze im Echtbetrieb. Jeder einzelne Fehler ist klein. In Summe verzerren sie Rankings, Forecasts und Rechnungen.

## Was omadia ändert

### Antworten in Minuten statt Tagen

Die Fachperson fragt direkt, ohne Abfragesprache, ohne Ticket. omadia übersetzt die Frage, holt die Daten live aus Dynamics und antwortet mit einer Tabelle. Nachfragen wie „und jetzt nur die gebuchten Rechnungen" laufen im selben Gespräch weiter. Das verschiebt Auswertung von einem Projekt zu einer Unterhaltung.

### Zahlen, die man verantworten kann

omadia prüft die eigenen Zwischenergebnisse auf Widersprüche. In der Testinstanz hat dieser Mechanismus über ein Dutzend Inkonsistenzen selbst aufgeworfen und korrigiert. Ein Beispiel: Ein Jahresvergleich zeigte zunächst minus 13,8 Prozent. Nach sauberer Bereinigung um Stornos waren es minus 10,0 Prozent. Ohne diese Korrektur wäre der Rückgang um ein Drittel überzeichnet gewesen, mit entsprechend falscher Reaktion. Kein klassisches Dashboard sagt von sich aus „meine letzte Zahl widerspricht der davor". omadia tut genau das.

### Geld und Fehler finden, nach denen niemand sucht

Das Wertvollste stand oft nicht in der Frage:

- Bei der Top-Kunden-Auswertung fiel ein **doppelt geführter Kunde** auf. Einzeln auf Platz 2 und Platz 15, zusammengeführt rund 343.000 € und damit klar der zweitgrößte Kunde. Ein Reporting hätte zwei Zeilen ausgegeben und geschwiegen.
- Eine **Preislisten-Analyse** zeigte: 74 aktive Listen, aber nur 25 gepflegt, 49 leer. Hinter neun separaten Listen stecken faktisch nur zwei echte Rabattstufen. Eine seit 2023 abgelaufene Liste hängt noch an einem Kunden. Aufräumpotenzial, das direkt auf Pflegeaufwand und Preisdisziplin einzahlt.
- Eine **Pipeline-Frage** nach noch nicht fakturierten Leistungen ergab zunächst rund 1.450 offene Teilnehmer, hochgerechnet fast eine halbe Million Euro. omadia hat die Zahl nicht geglaubt, nachgebohrt und gezeigt: 57 Prozent davon waren ein Abrechnungsartefakt eines Großkunden, der pauschal pro Woche fakturiert wird. Der echte Rückstand ist klein und benennbar. Wert hier: kein Fehlalarm, keine falsche Abschreibung, und die echten Lücken werden trotzdem sichtbar.

### Ein Wissensvorsprung, der bleibt und wächst

omadia startet bewusst unvollständig. Es kennt das eigene Geschäft am ersten Tag nicht. Aber jede Frage hinterlässt ein Stück dauerhaftes Wissen: welche Felder zählen, wie ein Großkunde abgerechnet wird, wo die Datenfallen liegen. Das macht jede weitere Frage schneller und sicherer. Aus einem allgemeinen Werkzeug wird über Wochen eine Instanz, die genau diesen Mandanten versteht. Dieses Wissen ist ein Vermögenswert, der mit der Nutzung steigt, kein Lizenzposten, der nur kostet.

### Kontrolle und Datenschutz als Grundlage

omadia läuft auf eigener Infrastruktur, mit oder ohne Container. Die Geschäftsdaten und das aufgebaute Wissen bleiben im Haus, nicht in einem fremden Modell. Schreibende Aktionen laufen grundsätzlich über Vorschlag und Freigabe. Für regulierte und datensensible Bereiche ist das die Voraussetzung, überhaupt anzufangen.

## Was es konkret gebracht hat

| Geschäftsfrage | Was omadia geliefert hat | Geschäftswert |
|---|---|---|
| Umsatz, Top-Produkte, Jahresvergleich | Live-Antwort im Chat, geprüft | Auswertung ohne IT-Ticket, in Minuten |
| Top-Kunden seit 2025 | Dublette erkannt, korrekt konsolidiert (rund 343.000 €) | Richtiges Ranking, sauberer CRM-Stamm |
| Rabatt- und Preisstruktur | 74 Listen auf 2 echte Tarife reduziert, 49 leere markiert | Weniger Pflegeaufwand, mehr Preisdisziplin |
| Offene, nicht fakturierte Leistungen | Phantom-Rückstand von 57 Prozent entlarvt, echte Lücken benannt | Kein Fehlalarm, gezieltes Nachfakturieren |
| Wiederkehrende Reports | Als Routine gespeichert | Einmal erarbeiten, beliebig oft abrufen |

## Wirtschaftlichkeit, ehrlich

Der erste Durchlauf einer Auswertung kostet Dialog. Man arbeitet eine Frage mit omadia heraus, korrigiert, präzisiert. Jeder weitere Abruf ist dann nahezu kostenlos, weil das Vorgehen als Routine bleibt. Der Nutzen liegt auf drei Ebenen: gesparte Zeit (Auswertung ohne IT-Schleife), bessere Entscheidungen (geprüfte Zahlen) und gefundenes Geld oder vermiedene Fehlentscheidungen (Pipeline, Stammdaten, Preise).

## Grenzen und offene Punkte

Ohne Beschönigung, sonst ist es Werbung:

- omadia ist am ersten Tag kein fertiger Experte für Ihr System. Der Wert entsteht über die ersten Wochen Nutzung. Wer eine schlüsselfertige Standardlösung erwartet, wird das missverstehen.
- Die gezeigten Zahlen stammen aus einer Testinstanz mit kundenähnlichen Daten. Für belastbare Aussagen im Echtbetrieb braucht es die eigene Instanz.
- Antworten sind so gut wie die Datenqualität. omadia macht Fehler sichtbar, behebt sie aber nicht von allein. Das ist eine Chance, kein Selbstläufer.

## Empfehlung für Entscheider

Der sinnvolle Einstieg ist ein begrenzter Pilot auf den eigenen Dynamics-Daten, lesend, mit zwei oder drei echten Geschäftsfragen aus Controlling oder Vertrieb. Erfolgskriterium ist nicht eine Demo, sondern ob in den ersten Sitzungen belastbare Antworten und mindestens ein konkreter Fund (Geld, Fehler, Risiko) herauskommen. Genau das ist in der Testinstanz passiert.

Mehr zu omadia: omadia.ai
