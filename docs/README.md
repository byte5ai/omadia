# docs/ — Navigations-Index

Dieser Ordner ist das kollektive Gedächtnis des Omadia-Projekts. Mehrere Agents (Claude Code, teilweise parallel) arbeiten am Projekt — **verbindliche Regeln stehen in [`/AGENTS.md`](../AGENTS.md)**. Dieses README hilft dir, das richtige Dokument in Sekunden zu finden.

## Einstiegsreihenfolge (neue Session, neuer Agent)

1. [`/AGENTS.md`](../AGENTS.md) — Dokumentations-Policy, Kernregeln, Anti-Pattern
2. **dieses README** — Landkarte
3. [`architecture.md`](architecture.md): System-Überblick (Component-Map, Request-Flow), Einstieg vor dem Deep-Dive
4. [`middleware-agent-handoff.md`](middleware-agent-handoff.md) — Vollständige Tech-Übersicht
5. [`CHANGELOG.md`](CHANGELOG.md) — Was ist zuletzt passiert
6. [`security-architecture.md`](security-architecture.md) — Security-Design-Patterns

## Dokument-Verzeichnis

| Doc | Scope | Update-Frequenz | Wer pflegt |
|---|---|---|---|
| [`/AGENTS.md`](../AGENTS.md) | **Policy** für Multi-Agent-Arbeit | Nur bei Regelwechsel | Jeder, der die Regeln ändert — MIT CHANGELOG-Eintrag |
| [`architecture.md`](architecture.md) | System-Überblick: Component-Map, Request-Flow, Key-Decisions. Die **Landkarte** vor den Deep-Dive-Docs | Bei strukturellen Architektur-Änderungen | Feature-Agents |
| [`middleware-agent-handoff.md`](middleware-agent-handoff.md) | Architektur, Layout, Commands, Config, Roadmap — der **primäre** Tech-Einstieg | Bei jeder strukturellen Änderung | Feature-Agents |
| [`upgrading.md`](upgrading.md) | Upgrade- und Migrations-Pfade pro Minor-Version (Env-Vars, Schema, Plugin-API) | Bei jedem Release mit Breaking Changes | Release-Thread |
| [`rca/`](rca/) | Root-Cause-Analysen für operative Incidents (Template + Index) | Nach jedem Incident | Operator / betroffener Thread |
| [`CHANGELOG.md`](CHANGELOG.md) | Rolling chronologische Chronik aller signifikanten Änderungen | Nach jeder Aufgabe | Der Agent, der die Änderung macht |
| [`security-architecture.md`](security-architecture.md) | Security-Design-Patterns (Vault-Credentials, Proxy-Routes, Scope-Locked Sub-Agents, signed URLs) | Bei Security-Architektur-Änderungen | Security-Thread |
| [`creating-plugins.md`](creating-plugins.md) | HowTo: Plugin bauen (Scaffold → Manifest → ZIP) + Publish auf den Hub | Bei Änderungen am Package-Contract / Publish-Flow | Plugin-/Registry-Thread |

## Lebende Docs (öffentliche Untermenge)

Werden aktiv gepflegt, müssen stimmen:
- `AGENTS.md`
- `docs/README.md`
- `docs/middleware-agent-handoff.md`
- `docs/CHANGELOG.md`
- `docs/security-architecture.md`

> Hinweis: weitere interne Doku (Frontend-Handoff, Graph-Deployment, Day-One-Learnings, Plans) liegt im internen byte5-Repo. Was öffentlich ist, steht hier.

## Konventionen

- **Sprache**: Prosa auf Deutsch (byte5-Arbeitssprache), Code-Identifier + API-Namen englisch.
- **Datum in Doc-Namen**: `YYYY-MM-DD`-Suffix signalisiert eingefroren.
- **Dateinamen-Case**: lowercase mit Bindestrich, außer `README.md`, `CHANGELOG.md`, `AGENTS.md` (Konvention).
- **Headings**: H1 einmal pro File, H2 für Abschnitte, H3 sparsam.
- **Absolute Pfade in Commands** — keine `cd`-Verschachtelung, damit kopierbar.

## Wo ein Fakt NICHT steht

Wenn du einen Fakt dokumentieren willst und keinen passenden Ort findest:
1. Prüfe die Tabelle oben
2. Zweifel → `docs/CHANGELOG.md` + Hinweis „gehört eigentlich nach X"
3. Konsolidierung erfolgt später — wichtig ist, dass der Fakt persistiert ist

## Meta-Regel

Jede signifikante Änderung an diesem Repo erzeugt **mindestens** einen CHANGELOG-Eintrag. Viele erzeugen zusätzlich einen thematischen Doc-Update. **Kein CHANGELOG-Eintrag = Aufgabe nicht fertig.**

— byte5
