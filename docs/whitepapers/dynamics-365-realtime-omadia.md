# Gemeinsam Wissen aufbauen, das bleibt: omadia auf Microsoft Dynamics 365

> **Untertitel:** Start imperfect, evolve together. Wie ein Team und ein KI-Agent eine Dynamics-365-Instanz Frage für Frage gemeinsam erschließen, und warum das Gelernte nicht mit der Sitzung verfällt.
>
> **Status:** Entwurf v2 (Deutsch). Quelle: Chatprotokolle der omadia-Testinstanz, Knowledge-Graph-Memory, Stand 07.06.2026.
> **Hinweis vor Veröffentlichung:** Die Zahlen stammen aus einer Testinstanz mit kundenähnlichem Datenbestand. Kundennamen sind in diesem Entwurf bereits anonymisiert. Vor einer öffentlichen Publikation prüfen, ob konkrete Umsatzwerte und Produktnamen freigegeben sind.

## TL;DR

Ein Schulungsanbieter führt seine Rechnungs- und Kursdaten in Microsoft Dynamics 365 (Dataverse). Niemand hat omadia vorab perfekt für diesen Mandanten konfiguriert. Am Anfang kannte der Agent das Schema nicht, traf auf eine zu enge API und lieferte teils falsche Zahlen. Die eigentliche Geschichte ist, was danach passierte: Mit jeder Frage hat das Team mit omadia ein Stück Wissen aufgebaut, ein Feld-Mapping, eine Abrechnungsregel, ein Datenmuster, und dieses Wissen bleibt. Es liegt im Knowledge Graph und im Prozess-Store, nicht im flüchtigen Chatverlauf. Deshalb öffnen frühe Turns mit „Memory ist leer" und späte mit „Memory ist extrem reichhaltig". Aus „Klartext-Frage gegen Live-Dataverse" wird so über die Zeit eine Instanz, die das eigene Geschäft kennt. Zwei Mechanismen tragen das: serverseitige Aggregation für richtige Zahlen und ein Verifier, der die eigenen Antworten auf Widersprüche prüft.

## Start imperfect, evolve together

Die eigentliche Geschichte dieser Testinstanz ist keine Liste fertiger Funktionen. Es ist eine Lernkurve, die omadia und das Team zusammen gegangen sind. Am Anfang wusste der Agent fast nichts über diesen Mandanten: das Schema unbekannt, das naheliegende Umsatzfeld leer, die API zu eng, das Memory nach jedem Neustart wieder blank. Die ersten Antworten waren unvollständig oder schlicht falsch. Das ist kein Makel, das ist der Startpunkt.

Entscheidend ist, was mit jeder Frage geschah. Jede Auswertung hinterließ ein Learning: ein Feld-Mapping, eine Abrechnungsregel, ein erkanntes Datenmuster. Diese Learnings landen nicht im Chatverlauf, der mit der Sitzung verfällt, sondern im Knowledge Graph und im Prozess-Store. Sie bleiben und sie verdichten sich. Deshalb liest sich der Anfang früher Turns wie „Memory ist leer (Reset)" und der Anfang späterer Turns wie „Memory ist top" oder „Memory ist extrem reichhaltig". Genau dieser Wechsel ist das Produkt.

Die folgenden Stationen sind dieser Aufbau, der Reihe nach. Jede beantwortet eine konkrete Frage, und jede macht die nächste schneller, weil das Gelernte schon bereitliegt. Man muss omadia nicht vorab perfekt konfigurieren. Man fängt unvollständig an und wird gemeinsam besser.

## Der Use-Case

Die Testinstanz spricht einen Dynamics-365-Mandanten an, in dem ein Anbieter sicherheitstechnischer Schulungen (GWO-Kurse, Höhenrettung, Sea Survival) seine Kurse, Buchungen und Rechnungen verwaltet. Kurse liegen als Custom-Entity, Umsätze als Rechnungspositionen. Die Auswertungsfragen sind alltäglich und genau deshalb interessant: Wochenumsatz, Top-Produkte, Jahresvergleich, „sind alle Teilnehmer im April schon abgerechnet?".

omadia bindet Dynamics als Capability-Plugin ein. Im Chat stehen dem Agenten lesende Werkzeuge zur Verfügung: `dynamics_describe` für Schema-Discovery, `dynamics_query` für gefilterte OData-Abfragen, dazu `dynamics_fetchxml` und `dynamics_aggregate` für serverseitige Aggregation. Alles read-only, alles gegen den Live-Mandanten.

## Station 1: Fachfragen brauchen sonst einen Umweg über IT

Die konkrete Frage „Umsatz mit Kursprodukten nächste Woche" lässt sich in Dynamics nicht eben mal klicken. Sie verlangt: das richtige Entity finden, das Datumsfeld kennen, Buchungen filtern, Preise verrechnen. In der Praxis heißt das: Ticket ans BI-Team, ein bis zwei Tage Wartezeit, ein Report, der dann doch die falsche Spalte nimmt.

Im Chatprotokoll löst der Agent das in einem Dialog. Er übersetzt die Frage in OData beziehungsweise FetchXML, prüft das Schema, rechnet und antwortet mit einer Tabelle. Die Fachperson formuliert nach, der Agent zieht nach. Kein Report-Ticket, kein Datenexport nach Excel.

## Station 2: das Schema kennt niemand auswendig

Dynamics-Mandanten sind voll mit Custom-Feldern, deren Namen niemand im Kopf hat. Die Protokolle zeigen das ungeschönt:

- Die Kurs-Tabelle heißt nicht „Kurs", sondern liegt als Custom-Entity (`ud_tutorials`). Der Agent findet sie erst über `dynamics_describe`, nicht über Raten.
- Das Startdatum heißt `ud_startdatetime`, nicht `ud_startdate`. Das Mapping wird einmal entdeckt und gespeichert.
- Die wichtigste Erkenntnis steckte tief: Das naheliegende Umsatzfeld `ud_totalsalesorderamount` ist systemweit null. Der Sales-Order-Pfad wird für die Kursabrechnung gar nicht genutzt. Die echten Umsätze liegen in den Rechnungspositionen (`invoicedetail`), verknüpft über das Produkt.

Wer diese drei Punkte nicht kennt, baut einen Report, der überzeugend aussieht und trotzdem null Euro Umsatz zeigt. omadia hat sie im Dialog herausgearbeitet und als wiederverwendbares Wissen abgelegt.

## Station 3: die Standard-API hat erst falsche Zahlen geliefert

Hier wird es ehrlich. Die erste Plugin-Version konnte pro Aufruf maximal 50 Datensätze lesen und kannte keine serverseitige Aggregation. Bei über 50 Rechnungspositionen pro Monat heißt das: Der Agent sah nur einen Ausschnitt und summierte ihn auf. Das Ergebnis war kein „ungefährer" Umsatz, es war ein systematisch zu niedriger.

Im Protokoll steht diese Grenze als Memory-Eintrag schwarz auf weiß: „Vollständige Umsatzberechnung ist über die verfügbare API nicht möglich. Maximal 50 Datensätze pro Call, keine serverseitige Aggregation." Eine schöne Demo hätte die Zahl trotzdem präsentiert. omadia hat die Grenze benannt und daraus die Lösung abgeleitet.

Der Agent hat selbst spezifiziert, was das Plugin können müsste: OData `$apply` für Aggregation, serverseitiges Paging über `@odata.nextLink`, ein höheres `$top`-Limit, `$count`-Support, optional FetchXML-Durchreichung. Genau diese Punkte wurden in der nächsten Plugin-Version umgesetzt. Seitdem läuft die Aggregation serverseitig über alle Rechnungspositionen, nicht über die ersten 50.

Das Ergebnis ist der Kern der Realtime-Lösung. Beispiele aus der Testinstanz, jetzt über den vollständigen Datenbestand gerechnet:

| Kennzahl | Wert (Testinstanz, 2026 YTD bis 07.06.) |
|---|---|
| Netto-Umsatz nach Leistungsdatum | 1.362.637,40 € |
| Brutto-Umsatz nach Leistungsdatum | 1.604.422,64 € |
| Rechnungspositionen | über 2.000 |
| Top-Produkt (WAHR, Höhenrettung-Refresher) | 210.110 € netto, 571 Anmeldungen |
| Zweitplatziert (GWO Sea Survival) | 109.020 € netto |

Diese Zahlen entstehen in einem Aufruf gegen Dataverse, nicht aus einem nächtlichen Export. Daher Realtime: Die Antwort ist so aktuell wie der Mandant.

## Station 4: selbstsicher falsch ist schlimmer als langsam

Das eigentlich interessante Stück. Über den Verlauf hat der Verifier von omadia zwölf Widersprüche in den eigenen Zwischenergebnissen markiert. Drei Beispiele, die zeigen, worum es geht:

- „209 Anmeldungen" gegen „209 Kurse". Der Agent hatte Kursinstanzen und Teilnehmerzahlen vermischt. Der Verifier hat den Konflikt aufgeworfen, der Agent hat beides getrennt nachgezogen: 209 geplante Kurstermine, 571 Anmeldungen darauf.
- Datumsdimension. Eine frühere Antwort rechnete über das Rechnungsdatum (`createdon`), eine spätere über das Leistungsdatum (`datedelivered`). Differenz: rund 180 Rechnungen und etwa 100.000 €. Der Verifier hat die beiden Stände als unvereinbar markiert, der Agent hat auf Leistungsdatum als saubere Dimension umgestellt.
- Stornos. Auf die Nachfrage „hast du Stornos ausgeschlossen?" kam die ehrliche Antwort: nein. Nach Bereinigung (Status ungleich storniert, nur echte Rechnungen) änderte sich der Jahresvergleich Januar bis Mai von minus 13,8 Prozent auf minus 10,0 Prozent. Ohne diese Korrektur wäre der Rückgang um ein Drittel überzeichnet gewesen.

Kein BI-Dashboard sagt von sich aus „meine letzte Zahl widerspricht der davor". omadia tut das, weil die Zwischenergebnisse im Knowledge Graph liegen und gegeneinander geprüft werden. Aus der Sicht eines Controllers ist das der Unterschied zwischen einer Zahl, der man glaubt, und einer, der man trauen kann.

## Station 5: dieselbe Maschine, andere Granularität

Die zuletzt gestellte Frage war „Top-Kunden seit Anfang 2025". Bemerkenswert ist, wie wenig omadia dafür neu lernen musste. Das Datums- und Bereinigungs-Pattern lag schon im Memory. Neu war nur die Ebene der Auswertung: Kunden-Aggregat statt Produkt-Aggregat. Also FetchXML auf die Rechnung (`invoice`, Summe `totalamount`, gruppiert nach `customerid`) statt auf die Rechnungsposition.

Genau hier hat der Verifier wieder zugeschlagen. Er hat markiert, dass die neue Kunden-Auswertung (Rechnungsebene, `totalamount`) und die frühere Produkt-Auswertung (Positionsebene, `extendedamount`) unterschiedliche Granularitäten messen und nicht direkt vergleichbar sind. Das ist der Klassiker, an dem Excel-Auswertungen kippen: zwei Zahlen, beide mit „Umsatz 2025" beschriftet, aus zwei Ebenen gezogen, und niemand merkt es. omadia merkt es.

Das Ergebnis kam als Top-15-Ranking, bereinigt um Stornos, auf Leistungsdatum mit Fallback. Anonymisiert sieht die Spitze so aus:

| # | Kunde (anonymisiert) | Umsatz (€) |
|---|---|---:|
| 1 | Offshore-Wind-Betreiber A | 401.064 |
| 2 | Windturbinen-Hersteller B | 279.521 |
| 3 | Rotorblatt-Service C | 252.610 |
| 4 | Offshore-Wind-Betreiber D | 211.060 |
| 5 | Offshore-Rettungsdienst E | 131.814 |

Die Top 5 ergeben rund 1,28 Mio €, etwa 35 Prozent des bereinigten Volumens. Die Top 15 sind fast vollständig Offshore-Wind und Offshore-Medizin. Eine Branchenkonzentration, die eine Geschäftsführung kennen will, bevor ein Großkunde wegbricht.

Nebenbei: nach der Antwort hat omadia von sich aus die Auswertungen vorgeschlagen, die für genau dieses Geschäftsmodell zählen. Unfakturierte Pipeline (durchgeführt, aber noch nicht abgerechnet), Refresh-Zyklen der Zertifikate, Auslastung pro Kurstyp, Wiederbuchungsrate. Nicht generisch, sondern aus dem erkannten Muster „Teilnehmer mal Kurse mal Preisliste mit nachgelagerter Abrechnung".

## Station 6: der Fund, nach dem niemand gefragt hat

Das Wertvollste an der Kundenauswertung stand nicht in der Frage. Beim Zusammenstellen ist omadia aufgefallen, dass ein Kunde doppelt in den Stammdaten liegt, einmal mit einem Standort-Suffix, einmal ohne. Einzeln landeten die beiden Datensätze auf Platz 2 und auf Platz 15. Zusammengeführt sind es 343.665 € und damit deutlich Platz 2, womit sich das halbe Ranking darunter verschiebt.

Das ist kein Reporting mehr, das ist ein Hinweis fürs CRM. Eine BI-Abfrage hätte zwei Zeilen ausgegeben und geschwiegen. omadia hat den Doppeleintrag benannt und die konsolidierte Zahl gleich mitgeliefert. Datenqualität fällt hier als Nebenprodukt der Auswertung an, nicht als separates Projekt.

## Station 7: durchgeführt, aber nicht abgerechnet

Die Frage „sind alle Teilnehmer für April und Mai schon abgerechnet?" ist die teuerste in der ganzen Liste, weil dahinter echtes Geld steht, das noch nicht in Rechnung ist. omadia hat sie nicht über den Umsatz beantwortet, sondern über die Teilnehmer-Tabelle (`ud_participant`). Dort stehen die entscheidenden Felder: `ud_invoiceid` (leer = nicht abgerechnet), `ud_billable` (soll überhaupt abgerechnet werden) und `ud_executionstatus` (durchgeführt oder abgesagt).

Die Auswertung über beide Monate:

| Monat | TN gesamt | mit Rechnung | offen | davon abrechenbar |
|---|---:|---:|---:|---:|
| April 2026 | 468 | 430 (91,9 %) | 38 | 7 |
| Mai 2026 | 335 | 319 (95,2 %) | 16 | 2 |
| Summe | 803 | 749 (93,3 %) | 54 | 9 |

Die ehrliche Antwort war: nein. Neun durchgeführte, abrechenbare Teilnehmer hatten keine Rechnung. Entscheidend ist die Trennung, die omadia gleich mitgeliefert hat: von 54 offenen Teilnehmern sind 45 korrekt offen (`ud_billable = false`, also Stornos, Nachholer, interne Plätze), nur 9 sind echtes Backlog. Ohne diese Unterscheidung hätte die Zahl nach 54 verlorenen Rechnungen ausgesehen, dem Sechsfachen.

Zwei Dinge fielen dabei nebenbei auf. Sechs der neun Lücken hängen an einem einzigen Sammelkurs, ein typisches Muster, wenn die Abrechnung über mehrere Kunden an einem Termin hakt. Und ein „offener" Teilnehmer entpuppte sich als Test-Datensatz mit einer Kursnummer aus 2021, also wieder ein Datenqualitäts-Fund statt eines echten Backlogs.

omadia hat die Grenzen der eigenen Antwort dazugesagt: falls einzelne Teilnehmer über eine Sammelrechnung gedeckt sind, ohne dass das Lookup gesetzt wurde, erscheinen sie hier fälschlich als offen. Und die Status-Picklist war nicht vollständig dekodiert. Das ist die Sorte Vorbehalt, die ein Controller hören muss, bevor er auf eine Zahl reagiert.

Dass diese Auswertung überhaupt kam, ist kein Zufall. omadia hatte „durchgeführt, aber unfakturiert" selbst als wichtigste Kennzahl für dieses Geschäftsmodell vorgeschlagen, noch bevor die Frage gestellt wurde.

## Station 8: als die Pipeline nach einer halben Million aussah

Die Folgefrage war größer: nicht nur April und Mai, sondern die gesamte unfakturierte Pipeline. Der naheliegende Filter (Teilnehmer durchgeführt, abrechenbar, kein Rechnungs-Lookup) lieferte rund 1.450 offene Teilnehmer über 31 Kurs-Monate. Hochgerechnet auf den Durchschnittspreis sind das fast eine halbe Million Euro scheinbar offener Umsatz. Ein Dashboard hätte genau diese Zahl angezeigt, und im Controlling wäre der Alarm losgegangen.

omadia hat die Zahl nicht geglaubt. Sie passt nicht zu einem Jahresumsatz von 2,4 Mio, ein offener Posten dieser Größe wäre längst aufgefallen. Also hat der Agent in den schlimmsten Monat gebohrt, November 2025 mit 213 offenen Teilnehmern, und die entscheidende Frage gestellt: wurden die wirklich nie abgerechnet, oder fehlt nur das Lookup?

Die Antwort steckte im Abrechnungsmodell. Der größte Auftraggeber, ein Übertragungsnetzbetreiber, wird nicht pro Teilnehmer fakturiert, sondern über ein Wochen-Pauschalprodukt: eine Sammelrechnung von rund 28.000 € pro Kurswoche. Bei dieser Logik bleibt das Teilnehmer-Feld `ud_invoiceid` leer, weil es keine Eins-zu-eins-Beziehung zwischen Teilnehmer und Rechnungsposition gibt. 162 der 213 vermeintlich offenen Teilnehmer waren also längst bezahlt, nur eben als Pauschale. Nebenbei fiel auf, dass diese Sammelrechnungen kein Leistungsdatum gepflegt haben, weshalb sie auch in der früheren Kundenauswertung fehlten, und dass einige storniert und neu ausgestellt wurden, was einen Teil der Storno-Schwankung des Vorjahres erklärt.

Nach Bereinigung um diesen einen Kunden schrumpfte die Pipeline von rund 1.450 auf 622 Teilnehmer, ein Minus von 57 Prozent. Einzelne Monate fielen komplett zusammen: Oktober 2025 von 152 auf 0, September 2025 von 103 auf 0.

Das ist der Kern des Unterschieds. Ein Report zeigt eine Zahl. omadia hat das Datenmodell debuggt, den Grund für die falsche Zahl benannt und gleich die Korrektur geliefert. Übrig blieben zwei echte Verdachtsmonate (Januar und Februar 2025), die nichts mit dem Pauschalkunden zu tun haben und einen eigenen Blick verdienen. Auch das hat omadia offen als nächsten Schritt markiert, statt es unter den Tisch fallen zu lassen.

## Station 9: 74 Preislisten, dahinter zwei Tarife

Die nächste Frage zielte auf die Rabattstruktur. omadia hat dafür die Preislisten (`pricelevel`) ausgewertet und ein typisches Bild eines gewachsenen Systems gefunden.

74 Preislisten sind aktiv. Davon haben nur 25 überhaupt Produkte hinterlegt, 49 sind leer. Nur 17 sind einem aktiven Kunden als Standard zugewiesen, der Rest sind Karteileichen. Eine Liste ist seit 2023 abgelaufen, steht aber weiter auf aktiv und hängt an einem Kunden, der dadurch für jedes nicht gelistete Produkt den vollen Standardpreis zahlt.

Der eigentliche Befund liegt eine Ebene tiefer. Hinter neun separat gepflegten Listen stecken faktisch nur zwei echte Tarifprofile: ein Volumen-Tarif rund 30 Prozent unter Standard und ein Premium-Tarif rund 15 Prozent darunter. Viele Listen teilen sich dasselbe Preisraster, sind also Kopien ohne kundenindividuelle Anpassung. Zwei Listen waren bis auf die Position identisch, ein klares Duplikat. Eine dritte fiel als echter Sonderfall auf, mit eigener Kalkulation und Aufschlagspositionen, die nicht in die Standardstaffel passt.

Die Schlussfolgerung war konkret und aufräumbar: 49 leere Listen deaktivieren, die neun Pseudo-Tarife auf zwei echte Stufen konsolidieren, das Duplikat zusammenführen, die abgelaufene Liste klären. Das ist weniger Reporting als ein Stammdaten-Audit, das nebenbei abfällt.

Und wieder die ehrliche Grenze: wie viel Rabatt 2026 tatsächlich in Euro vergeben wurde, lässt sich aus den Preislisten allein nicht sagen. Dafür braucht es den Join auf die Rechnungspositionen mit der jeweils verwendeten Preisliste. omadia hat diesen nächsten Schritt benannt, statt eine Scheingenauigkeit zu liefern.

## Station 10: das Gelernte bleibt, auch wenn die Sitzung endet

Die Testinstanz hatte über mehrere Tage immer wieder Memory-Resets. Im Protokoll taucht „Memory ist leer (Reset)" auffällig oft auf. Statt das zu kaschieren, zeigt es die Architektur: omadia trennt flüchtigen Sitzungskontext vom dauerhaften Knowledge Graph.

Die einmal entdeckten Mappings (Kurs-Entity, Datumsfeld, `invoicedetail` als Umsatzquelle) liegen als dauerhaftes Wissen vor. Der wiederkehrende Auftrag „Umsatz Kurse nächste Woche" wurde als gespeicherter Prozess mit Feld-Mapping abgelegt. In einer späteren Sitzung lädt der Agent diesen Prozess und rechnet sofort, statt das Schema erneut zu erkunden. Was einmal verstanden wurde, bleibt verfügbar.

## Station 11: vom Einmal-Query zur wiederholbaren Auswertung

Die meisten Controlling-Fragen sind keine Einmalfragen. Wochenumsatz, Monatsabschluss, Jahresvergleich kommen wieder. omadia hält für diesen Schritt den Prozess-Store bereit: Eine erarbeitete Auswertung wird zur benannten Routine, inklusive der Felder, Filter und der Logik (Listenpreis am Produkt mal gebuchte Teilnehmer, Sonderpreislisten pro Firma berücksichtigt).

Damit verschiebt sich der Wert. Der erste Durchlauf kostet Dialog. Jeder weitere ist ein Aufruf. Die Auswertung gehört dann nicht mehr in einen Kopf oder ein Excel-Makro, sondern liegt versioniert in der Plattform.

## Was „Realtime" hier konkret heißt

Drei Eigenschaften zusammen ergeben die Realtime-Lösung, nicht eine allein:

Erstens: live gegen Dataverse. Keine Kopie, kein Data Warehouse, kein nächtlicher ETL-Lauf. Die Zahl entsteht im Moment der Frage.

Zweitens: serverseitige Aggregation. Die Plattform rechnet die Summe dort, wo die Daten liegen, über den vollständigen Bestand. Das war die Bedingung dafür, dass „Realtime" auch „richtig" bedeutet.

Drittens: geprüfte Antwort. Der Verifier hält die Zwischenstände konsistent. Eine schnelle falsche Zahl ist kein Fortschritt gegenüber einem langsamen richtigen Report.

## Einordnung in die omadia-Architektur

Der Dynamics-Fall ist ein Anwendungsbeispiel für vier Bausteine, die in jedem omadia-Setup greifen:

- **Capability-basiertes Multi-Provider-Modell.** Dynamics ist ein Plugin neben Odoo, Confluence und Microsoft 365. Der Agent spricht Capabilities an, nicht ein fest verdrahtetes System.
- **Knowledge Graph als Memory-Substrat.** Turns, Tool-Calls, gelernte Mappings und Widersprüche liegen als Knoten und Kanten, nicht als loser Chatverlauf. Das ist der Speicher, in dem sich die Learnings über Sitzungen hinweg sammeln, und gleichzeitig die Grundlage, auf der die Verifikation überhaupt erst funktioniert.
- **Zwei-Phasen-Bestätigung für Schreibzugriffe.** Im Dynamics-Fall lesend, aber die Plattform behandelt Schreibaktionen grundsätzlich mit Vorschlag und Freigabe.
- **Verifier.** Der Mechanismus, der die zwölf Widersprüche gefunden hat, ist kein Dynamics-Feature, sondern Teil der Plattform.

Das ist das Versprechen von omadia in einem Satz: der Komfort moderner KI-Workflows, mit der Kontroll- und Auditierschicht darunter, die Controlling und datensensible Bereiche brauchen. Auf eigener Infrastruktur betreibbar, mit oder ohne Container.

## Worum es eigentlich geht

Wer die elf Stationen am Stück liest, sieht das Muster. Keine einzelne Antwort ist der Punkt. Der Punkt ist, dass jede Antwort die nächste besser gemacht hat. Das Feld-Mapping aus Station 2 trägt die Top-Kunden-Auswertung in Station 5. Die Sammelrechnungs-Regel aus Station 8 macht jede künftige Pipeline-Frage auf einen Schlag belastbar. Das ist kein Zufall, sondern die Bauweise: Gelerntes wird persistiert und steht beim nächsten Mal bereit.

Daraus folgt ein anderer Erwartungshorizont an so ein System. Man kauft nicht einen fertig trainierten Dynamics-Experten von der Stange. Man fängt mit einem Agenten an, der das eigene Geschäft noch nicht kennt, stellt echte Fragen, korrigiert, und genau dieser Austausch wird zum dauerhaften Wissen der Instanz. Start imperfect, evolve together ist hier keine Pose, sondern beschreibt den Mechanismus wörtlich. Eine omadia-Instanz, die ein Team drei Monate lang benutzt hat, ist eine andere als am ersten Tag, weil sie die Eigenheiten genau dieses Mandanten kennt. Und weil dieses Wissen auf der eigenen Infrastruktur liegt, nicht in einem fremden Modell, bleibt es dem Team auch erhalten.

## Grenzen und offene Punkte

Ehrlichkeit gehört dazu, sonst ist es Marketing:

- Die anfängliche API-Grenze war real. Erst die erweiterte Plugin-Version macht die Aggregation belastbar. Wer omadia gegen Dynamics fährt, braucht diese Version.
- Die Memory-Resets in der Testinstanz waren ein Konfigurationsthema, kein Feature. Sie haben den Wert des dauerhaften Prozess-Stores zufällig gut sichtbar gemacht, sollten im Produktivbetrieb aber nicht auftreten.
- Die hier gezeigten Zahlen kommen aus einer Testinstanz. Für ein öffentliches Whitepaper müssen Produktnamen und Umsatzwerte freigegeben oder anonymisiert werden.

## Nächste Schritte

Dieser Entwurf ist die Grundlage für das erste omadia-Whitepaper zur Dynamics-Realtime-Lösung. Offen: Screenshots der Chatverläufe einbauen, ein Architekturdiagramm ergänzen, die Zahlen für die externe Fassung freigeben oder anonymisieren.

Mehr zu omadia: omadia.ai
