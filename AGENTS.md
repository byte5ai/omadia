# AGENTS.md — Mandatory Reading for Every LLM Agent Touching This Repo

Du bist ein Agent, der an diesem Repo arbeitet. Dieses Dokument ist **nicht optional**. Lies es vollständig, bevor du Code, Config, Secrets, Skills oder Docs änderst.

Das Projekt wird von **mehreren parallelen Agents** weiterentwickelt (Claude Code in verschiedenen Chats, manchmal mehrere gleichzeitig). Ohne disziplinierte Dokumentation verlieren wir innerhalb von Stunden den Überblick, welcher Zustand produktionswirksam ist. Das ist bereits passiert — siehe `docs/CHANGELOG.md` Eintrag `2026-04-19 — crashloop durch verpasste Schema-Sync`.

## Kernregel: Dokumentieren ist Teil der Aufgabe, nicht ein Nice-to-have

> **Jede Änderung an Code, Schema, Secrets, Skills, Agent-Configs, Dockerfile, fly.toml, Deploy-Pipeline oder Architektur muss im gleichen Arbeitsschritt dokumentiert werden — bevor die Aufgabe als erledigt gilt.**

Ohne Doku-Update ist eine Änderung **nicht fertig**, selbst wenn der Build grün und das Deploy live ist.

## Was wo dokumentiert wird (Entscheidungs-Baum)

| Art der Änderung | Ziel-Dokument | Granularität |
|---|---|---|
| Neue Feature / Architektur-Entscheidung | `docs/middleware-agent-handoff.md` aktualisieren | Abschnitts-Level |
| Bugfix / Ops-Vorfall / Build-Problem | `docs/CHANGELOG.md` Eintrag anhängen | Datum + ein Absatz |
| Security-Entscheidung / Credential-Verschiebung | `docs/security-migration-plan.md` Status-Update | Phase / Abschnitt |
| Neue ENV-Variable / Secret | `middleware/.env.example` + `docs/middleware-agent-handoff.md` §10 | Zeile + Erklärung |
| Neue Route / Tool / Sub-Agent | `docs/middleware-agent-handoff.md` §3 und §8 | Abschnitt |
| Neue SQL-Migration | Datei in `middleware/src/services/graph/migrations/` — **plus** CHANGELOG-Eintrag mit ID und Zweck | Migration-ID |
| Neue Skill-Version | `skills/<name>/SKILL.md` + CHANGELOG | Skill-Name + Kurzzusammenfassung |
| Offener Punkt / Backlog / TODO | `docs/middleware-agent-handoff.md` §13 Roadmap | Bullet |

Wenn die Zuordnung unklar ist: lieber in CHANGELOG notieren als gar nicht — später konsolidieren.

## Einstiegsreihenfolge für eine neue Session

1. `AGENTS.md` (dieses Dokument)
2. `docs/README.md` — Index aller Docs
3. `docs/middleware-agent-handoff.md` — Architektur + Tech-Stack + Commands
4. `docs/CHANGELOG.md` — zuletzt passierte Änderungen (bremst vor Fehlern, die andere schon hatten)
5. Spezifisches Doc für den aktuellen Task (Security, Graph, Frontend, …)

Ohne mindestens Punkte 1–3 darf kein Code geändert werden.

## Parallele Arbeit — Kollisionen vermeiden

- **Fly-Deploys sind nicht atomar.** Wenn ein anderer Agent gerade deployt, abwarten (30-60s), sonst trittst du ihm auf den Zeh.
- **Secrets-Rotation synchronisieren.** Nicht unangekündigt Secrets überschreiben — ein Agent deployt einen Proxy-Token-Rename, ein anderer Agent hält noch den alten im Skill. Kommuniziere solche Änderungen im CHANGELOG, bevor du die `fly secrets set`-Kommandos tippst.
- **Git gibt es aktuell nicht** — das Repo ist **nicht git-tracked** (Stand 2026-04-19). Dein einziger Rollback-Schutz ist saubere Dokumentation und kleine, verifizierbare Schritte. Niemals zwei große Änderungen mischen.

## Anti-Pattern, die wir schon bezahlt haben

- **Doc-less Schema-Änderung**: v20-Build hat `CLAUDE_AGENT_ID` aus dem Zod-Schema entfernt, das Deployment enthielt aber noch das alte Config-Verhalten — Crashloop. Fix: Schema-Änderungen ab jetzt immer zusammen mit CHANGELOG-Eintrag + `.env.example`-Update.
- **Token in Agent-Config-YAML**: `agent-config-confluence.yaml` enthielt den Atlassian-Token direkt im System-Prompt. Policy: Credentials gehören **ausschließlich** in Fly Secrets — siehe `docs/security-migration-plan.md` §3.
- **Build-Artefakt vergessen**: `tsc` kopiert keine `.sql`-Files. Fix via `middleware/scripts/copy-build-assets.mjs`. Generell: Non-TS-Assets brauchen immer einen expliziten Build-Schritt.

## Meta

Dieses Dokument wird selbst im CHANGELOG geführt, wenn sich die Regeln ändern. Kein stilles Ändern der Regeln ohne Doku.

— Stand 2026-04-19, byte5
