---
id: scoring_rubric
kind: prompt_partial
shareable: true
---

# SEO-Score — Herleitung

Die Tools liefern einen deterministischen Score. Diese Rubrik erklärt, wie er zustande kommt, damit du ihn erklären (nicht: neu berechnen) kannst.

## Page-Score (max 100)

| Bereich | Max | Prüfung |
|---|---|---|
| Meta | 20 | Title 30–60 Zeichen (6), Description 70–160 (5), Canonical (3), Viewport (2), OG-Grundset (2), `robots` ohne `noindex` (2) |
| Headings | 20 | Genau eine H1 (10), mindestens eine H2 (5), mindestens eine H3 (3), erste Heading ist H1 (2) |
| Links | 20 | Interne Links vorhanden (10), externe Links vorhanden (3), <10% leere Anchors (5), insgesamt ≥ 3 Links (2) |
| Bilder | 20 | alt-Ratio (max 14), keine leeren `src` (3), mindestens ein lazy-loaded (3) — bei 0 Bildern: 15 geschenkt |
| Structured Data | 20 | Mindestens 1 JSON-LD (10), mindestens 2 (5), alle valide (5) |

**Grades:** A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, sonst F.

## Technical-Score (max 40)

| Bereich | Max | Prüfung |
|---|---|---|
| robots.txt | 10 | fetchbar (5), erlaubt unseren User-Agent (5) |
| Sitemap | 10 | ≥ 1 Sitemap erreichbar (5/10) + parst sauber (10 bei OK) |
| HTTPS | 10 | Root ist HTTPS (10) |
| Header | 10 | HSTS (5), CSP vorhanden (3), kein `noindex` im x-robots-tag (2) |

## Site-Audit-Score (max 100)

- 60% = Durchschnitt der Page-Scores der gecrawlten Seiten
- 40% = Issue-Dichte (40 Punkte minus Anzahl Issues, gedeckelt bei 40)

## Hinweise beim Erklären

- Der Score ist ein **Heuristik**-Score, kein Google-Ranking-Score.
- Wenn der Grade aus dem Tool-Output ein A ist, aber die Seite auffällige Issues hat, liegt das meist an einer stark bestandenen Bilder- oder Structured-Data-Prüfung, die andere Defizite überdeckt.
- Bei Diskrepanz: Issues vertrauen, Score als Kontext benutzen.
