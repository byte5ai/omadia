# AGENTS.md — Mandatory Reading for Every LLM Agent Touching This Repo

Du bist ein Agent, der an diesem Repo arbeitet. Dieses Dokument ist **nicht optional**. Lies es vollständig, bevor du Code, Config, Secrets, Skills oder Docs änderst.

Das Projekt wird von **mehreren parallelen Agents** weiterentwickelt (Claude Code in verschiedenen Chats, manchmal mehrere gleichzeitig). Ohne disziplinierte Dokumentation verlieren wir innerhalb von Stunden den Überblick, welcher Zustand produktionswirksam ist.

## Kernregel: Dokumentieren ist Teil der Aufgabe, nicht ein Nice-to-have

> **Jede Änderung an Code, Schema, Secrets, Skills, Agent-Configs, Dockerfile, fly.toml, Deploy-Pipeline oder Architektur muss im gleichen Arbeitsschritt dokumentiert werden — bevor die Aufgabe als erledigt gilt.**

Ohne Doku-Update ist eine Änderung **nicht fertig**, selbst wenn der Build grün und das Deploy live ist.

## Was wo dokumentiert wird (Entscheidungs-Baum)

| Art der Änderung | Ziel-Dokument | Granularität |
|---|---|---|
| Neue Feature / Architektur-Entscheidung | `docs/middleware-agent-handoff.md` aktualisieren | Abschnitts-Level |
| Architektur-Entscheidung (Regel, Vertrag, Default, bewusst akzeptiertes Restrisiko) | neues ADR in `docs/adr/` + Zeile im Index und in der Themenlandkarte von `docs/adr/README.md` — siehe „ADR-Abgleich“ unten | ein ADR pro Entscheidung |
| Bugfix / Ops-Vorfall / Build-Problem | `docs/CHANGELOG.md` Eintrag anhängen | Datum + ein Absatz |
| Security-Entscheidung / Credential-Verschiebung | `docs/security-architecture.md` aktualisieren | Abschnitt |
| Neue ENV-Variable / Secret | `middleware/.env.example` + `docs/middleware-agent-handoff.md` §10 | Zeile + Erklärung |
| Neue Route / Tool / Sub-Agent | `docs/middleware-agent-handoff.md` §3 (Execution-Layer; Routen beim jeweiligen Feature-Abschnitt). §8 ist „Skills“, nur für neue Skills | Abschnitt |
| Neue SQL-Migration | Datei in `middleware/migrations/` (Core-Serie; Subsystem-Serien wie `packages/harness-knowledge-graph-neon/src/migrations/` oder `src/conductor/migrations/` nur für deren eigene Tabellen — **nie** `src/services/graph/migrations/`, das liest kein Runner) — **plus** CHANGELOG-Eintrag mit ID und Zweck | Migration-ID |
| Neue Skill-Version | `skills/<name>/SKILL.md` + CHANGELOG | Skill-Name + Kurzzusammenfassung |
| Offener Punkt / Backlog / TODO | `docs/middleware-agent-handoff.md` §13 Roadmap | Bullet |

Wenn die Zuordnung unklar ist: lieber in CHANGELOG notieren als gar nicht — später konsolidieren.

## Einstiegsreihenfolge für eine neue Session

1. `AGENTS.md` (dieses Dokument)
2. `docs/README.md` — Index aller Docs
3. `docs/middleware-agent-handoff.md` — Architektur + Tech-Stack + Commands
4. `docs/CHANGELOG.md` — zuletzt passierte Änderungen (bremst vor Fehlern, die andere schon hatten)
5. `docs/adr/README.md` — Themenlandkarte der ADRs; die ADRs zum Thema des Tasks lesen (siehe „ADR-Abgleich“)
6. Spezifisches Doc für den aktuellen Task (Security, Graph, Frontend, …)

Ohne mindestens Punkte 1–3 darf kein Code geändert werden.

## ADR-Abgleich (verbindlich, bei jeder Anfrage)

Seit dem 2026-11-25 (Owner-Entscheidung) deckt `docs/adr/` jeden Themenkomplex des Repos ab.
Die Themenlandkarte in [`docs/adr/README.md`](docs/adr/README.md) ordnet jedem Bereich
(Plugins, Builder, Orchestrator, Modelle, Privacy, Auth, Memory, Conductor, Kanäle, MCP,
Web-UI, Desktop, Betrieb, CI) seine ADRs zu. Jede Aufgabe — Feature, Bugfix, Refactoring,
Review, Plan, auch eine reine Analyse — wird gegen diese ADRs abgeglichen:

1. **Vor der Arbeit:** in der Themenlandkarte den betroffenen Bereich suchen und die dort
   genannten ADRs lesen (mindestens Titel und „Decision Outcome“). Zusätzlich nach dem Konzept
   *und* seinen Bezeichnern greppen: `rg -il '<begriff>' docs/adr/`.
2. **Während der Arbeit:** die Änderung hält die ADRs ein. Verlangt die Aufgabe etwas, das ein
   ADR ausschließt: stoppen und den Widerspruch benennen, nicht still dagegen bauen. Die
   andere Richtung braucht ein **neues** ADR, das das alte ablöst (`Superseded by …`);
   akzeptierte ADRs werden nie inhaltlich umgeschrieben.
3. **Neue Entscheidung:** trifft die Änderung eine Architektur-Entscheidung, die kein ADR
   festhält, gehört das ADR in **denselben** PR (Status `Proposed`, bei Merge `Accepted`).
   Kriterien: echte Alternativen; bindet künftigen Code (Regel, Vertrag, Invariante,
   Konvention); außen sichtbarer Vertrag oder Default (plugin-api, channel-sdk, HTTP-Status,
   Payloads, Privacy-Regeln); bewusst akzeptiertes Restrisiko; Abweichung von einem
   Präzedenzfall. Reine Bugfixes mit nur einer sinnvollen Lösung brauchen kein ADR.
4. **Im Ergebnis ausweisen:** PR-Beschreibung (Abschnitt „ADR check“ im Template) und
   Abschlussbericht nennen die geprüften ADRs und eines von: „konform“, „neues ADR NNNN“,
   „ADR NNNN abgelöst durch MMMM“, „kein ADR nötig, weil …“. Fehlt die Angabe, ist die
   Aufgabe nicht fertig.
5. **Drift melden:** fällt beim Lesen auf, dass Code und ein ADR auseinanderlaufen, das als
   Issue oder im Bericht festhalten — auch wenn es nicht zur Aufgabe gehört.

Neues ADR: `docs/adr/0000-template.md` kopieren, nächste freie Nummer, Englisch, Zeile im
Index **und** in der Themenlandkarte. `middleware/test/adrIndexGuard.test.ts` prüft, dass
jede ADR-Datei in beiden steht. Der `adr-check`-Sweep im pr-flow bleibt das Netz für alles,
was trotzdem durchrutscht; er ersetzt den Abgleich pro Aufgabe nicht.

**Agentenmodell (verbindlich):** Wer Agenten, Plugins, Kanäle, Modelle, Routing, Memory,
Trigger oder Antwortdarstellung anfasst, liest vorher `docs/terminology.md` und die ADRs
0012–0022 in `docs/adr/` (virtuelle Mitarbeiter, kein Orchestrator-Agent, Plugins nur als
Lieferform, Archetypen, Model-Gateway, Konsultation, Diskretion, Trigger, Deterministic
first, native Facilitators). Wer Facilitator-Sitzungen anfasst, liest zusätzlich ADR-0026
(Lesetabelle und Link-Anfrage liegen im Kernel, Sprechererkennung setzt nie Autorschaft). Änderungen zahlen auf diese Konzepte ein; wer eine andere
Richtung braucht, schreibt ein neues ADR, das das betroffene ablöst, statt dagegen zu bauen.

**Facilitator-Entscheidungen (ADR 0023, #2060/#2066):** Facilitators dürfen Arbeitsmodi als
Moderationsmethoden haben; Route und Build lehnen für jeden Nicht-`standard`-Archetyp
Identitätsersatz ab (`workingModeIdentity.ts`, `services/workingModeContract.ts`), dazu
Neutralitätsvertrag und `requires_tools`. Einstellungen pro Agent deklariert der Archetyp
(`archetype.agent_settings`); der Kernel validiert, speichert (`agents.archetype_settings`)
und gibt sie als `AgentProfile.archetypeSettings` ans Plugin; nicht gesetzt = Instanz-
Einstellung des Plugins. Readiness ist pro Kanal-Identität (`own_identity_channels`), Teams
wird nur für Teams geprüft. Persona-Grenzen bleiben im Kernel (`services/facilitatorContract.ts`).

**Kanal-getriggerte Workflows (ADR 0028):** Eine Nachricht an einen Bot startet nur Workflows,
deren Agent-Schritte alle als der Agent dieses Bots laufen (`ConductorEventRouter` mit
`addressedAgentForEvent`, `channelBotOwnership.ts`). Andere werden übersprungen und geloggt,
statt einen Lauf zu starten, den `assertChannelOriginAllows` am Agent-Schritt ohnehin ablehnt.
Die Schritt-Regel bleibt als zweite Linie.

**Facilitator-Abnahme und Audio (ADR 0029, ADR 0031, #2068):** Die Abnahmematrix für Spec B §9
(Kriterien 1–64) liegt in `omadia-agent-facilitator` (`docs/acceptance-matrix.md`, geprüft von
`scripts/check-acceptance-matrix.mjs` in dessen CI). Wer ein Kriterium ändert oder einen
Kernel-Test aus der Matrix umbenennt, passt die Matrix an. #584 (Audio-Meeting-Source: Sidecar
als Tenant-User mit eigener Lizenz pro Agent, GPT-Live-Transcribe) gehört seit der Owner-
Entscheidung vom 2026-11-22 nicht mehr zum Epic #2043, sondern ist ein eigenes Folge-Vorhaben.

**Aufrufer eines Tools (ADR 0032):** `NativeToolCallContext.callerPrincipalId` ist die
Gesprächs-Form `user:<Kanal-User-Id>`, dieselbe wie `author.principalId` gespeicherter
Nachrichten und die Teilnehmer der Mitgliederliste. Beide Wege nutzen den einen Helfer
`conversationPrincipal` (`@omadia/orchestrator`); `buildToolCallContext` wendet ihn auf Sprecher bzw.
Kanal-Identität an. `TurnOrigin.principal` ist bei Discord, Slack und Telegram die
Routing-Form aus Spec 2042 §5.3 (`user:discord-user:<id>`, `user:<e-mail>`) und zählt nur ohne
Kanal-User (Web-Chat). Wer die Routing-Form im Tool braucht, bildet sie mit
`channelUserPrincipal` aus `callerUserRef`.
`transcription@1` und der Capability-Snapshot pro Sitzung (#2077) stehen bereits. Eine Audio-
Quelle deklariert nur `transcribed_speech`; Facilitator und Engine ändern sich dafür nicht.

**Execution-Scopes (ADR 0030, #2090):** Der Kernel begrenzt `closing`-Scopes selbst: 30 Tage ab
dem Ereignis (`eventAt` beim Öffnen, nicht ab dem Öffnen), nur `CLOSING_SCOPE_PURPOSES` (nie
Moderation). Der Deadline-Wait eines `active`-Scopes braucht einen offenen `closing`-Scope
desselben Prozesses und endet spätestens mit dessen absolutem Limit. Die Teile eines Closings
(Zustellung, Bestätigung, Versand) und ihre 7-Tage-Limits bleiben im Plugin. Private Antworten
tragen `replyToMessageId` (TurnOrigin → `PrivateMessageRequest`), damit „erledigt“/„stop“ an die
Erinnerung gebunden werden; Kanal-Adapter müssen das Feld füllen.

## Task-Routing: welches Werkzeug für welche Aufgabengröße

Bevor eine Aufgabe begonnen wird: welche Größenordnung hat sie, und passt eines der vorhandenen `scripts/*.workflow.mjs`-Pipelines besser als Ad-hoc-Arbeit in der aktuellen Session?

| Umfang | Beispiel | Werkzeug |
|---|---|---|
| Einzeldatei / triviale Änderung | Typo-Fix, eine Funktion anpassen | Inline in der aktuellen Session — kein Workflow nötig |
| Ein Issue, wenige Dateien, ein Package | Bugfix in einem `middleware/packages/@omadia/*`-Package | `issue-triage.workflow.mjs` (Plan/Checklist) → `issue-implement.workflow.mjs` (Umsetzung, worktree-isoliert, zwei unabhängige Reviewer) |
| Mehrere zusammenhängende Issues / Epic | Cross-Package-Feature | `issue-cluster.workflow.mjs` (Gruppierung nach Datei-Overlap) → `wave-decompose.workflow.mjs` → `wave-implement.workflow.mjs` (cross-family adversarial review, Cato für Security) → `wave-verify.workflow.mjs` |
| Feature von woanders adaptieren | Existierendes Muster aus anderem Projekt übernehmen | `issue-adapt-plan.workflow.mjs` → `issue-adapt-build.workflow.mjs` |

Alle Skripte in `scripts/*.workflow.mjs` laufen über das `Workflow`-Tool (`Workflow({ scriptPath: "scripts/<name>.workflow.mjs", args: {...} })`), nicht als eigenständige Node-Prozesse. Keines von ihnen pusht oder merged selbstständig nach GitHub — "PR erstellen" bzw. "mergen" bleibt immer ein expliziter, von einer Top-Level-Session oder einem Menschen ausgelöster Schritt.

**Review-Kriterien referenzieren statt duplizieren:**
- Plugin-Contract (PluginContext, 10-Punkte-Package-Checklist): `middleware/assets/boilerplate/{integration,tool}/CLAUDE.md` — das ist die kanonische Quelle; `docs/harness-platform/` ist nur lokales, gitignored Scratch und darf nicht als Referenz zitiert werden.
- i18n-Regeln für Frontend-Komponenten: `web-ui/CLAUDE.md`.

**Bekannte offene Baustelle beim Testen:** In der Middleware-Suite gibt es Cross-File-Test-Pollution (ein Test ist isoliert grün und scheitert im vollen `npm run test`-Lauf wegen State-Leak aus einer anderen Testdatei). Bevor Build-/Test-Caching (z. B. Turborepo) für die `middleware/packages/*`-Packages eingeführt wird, sollte diese Bug-Klasse behoben werden — sonst wird nur unzuverlässiges Grün schneller ausgeliefert.

## Working in a multi-session repo

**Convention (enforced):** the main clone never receives commits. Every change — even a single-line typo fix — lands in a worktree. This is branch-agnostic: an agent whose HEAD got switched to `main` by a parallel session is caught here too, not just one that created a feature branch in the wrong tree. Enforced by the `.hooks/pre-commit` hook shipped via the engineering-standards skill.

~~~bash
git worktree add ../<repo>-<feature> -b <branch> main   # create with new branch
git worktree add ../<repo>-<feature> <existing-branch>  # or attach existing
# work in ../<repo>-<feature>/
git worktree remove ../<repo>-<feature>                 # remove the tree
git branch -D <feature>                                 # remove the branch ref (after merge or discard)
git worktree list                                       # inspect
~~~

Build artefacts (`target/`, `node_modules/`, etc.) live per worktree — first build per tree is full cost, subsequent builds are independent.

**Bypass levels** (in increasing persistence):

| Level | Effect | How |
|---|---|---|
| One-off | this commit only | `ALLOW_MAIN_TREE_BRANCH=1 git commit ...` |
| Per repo | persistent disable, other standards still apply | `git config engineering-standards.main-tree-discipline false` |
| Repo exempt | all engineering-standards disabled for this repo | `status: exempt` in `.github/engineering-standards.yml` |

### Drift signals (for any unusual main-tree work that is allowed)

- Run `git branch --show-current` before each commit and confirm it matches what you intended.
- Treat `git status` anomalies as drift signals: directories you didn't touch showing as `??`, unexpected `M` on files you didn't edit. Don't commit through that — `git reflog | head -20` first to see who moved your HEAD.
- Don't reach for `git reset --hard` reflexively; another session may have uncommitted work in the shared tree. Inspect `git stash list` and `git diff --stat` first.

## Parallele Arbeit — Kollisionen vermeiden

- **Fly-Deploys sind nicht atomar.** Wenn ein anderer Agent gerade deployt, abwarten, sonst trittst du ihm auf den Zeh. Der gemeinsame Lock `/tmp/omadia-fly-deploy.lock` regelt das (siehe unten).
- **Secrets-Rotation synchronisieren.** Nicht unangekündigt Secrets überschreiben — ein Agent deployt einen Proxy-Token-Rename, ein anderer Agent hält noch den alten im Skill. Kommuniziere solche Änderungen im CHANGELOG, bevor du die `fly secrets set`-Kommandos tippst.
- **Git-Workflow ernst nehmen.** Das Repo liegt seit `2026-05` öffentlich auf `github.com/byte5ai/omadia`. Keine direkten Pushes auf `main` (lokal vom `.hooks/pre-push`-Guard blockiert, serverseitig von Branch Protection). Alle Änderungen über Feature-Branch + PR. Conventional-Commits-Konvention gilt (siehe unten). Niemals zwei große Änderungen in einem Commit mischen — kleine, verifizierbare Schritte sind weiterhin Pflicht.

### Deploy unserer Fly-Instanz

**Einziger Weg:** `scripts/fly-deploy.sh` aus einem sauberen, verlinkten Worktree, nie aus `~/sources/odoo-bot`. Doku: [`docs/fly-deploy.md`](docs/fly-deploy.md). Das Skript nimmt den Lock, baut aus einem frischen detached Worktree am Ziel-Commit, stempelt `OMADIA_VERSION=sha-<8>`, verweigert bei Config-Diff (`middleware/sidecars`, `fly/`, `middleware/.env.example`) seit dem Live-Sha und verifiziert `/health`-Version, `wss://` und `Secure`-Cookies auf beiden Apps.

```bash
scripts/fly-deploy.sh --dry-run      # erst ansehen
scripts/fly-deploy.sh                # origin/main deployen + verifizieren
scripts/fly-deploy.sh --only-verify  # nur Live-Checks
```

Handgetippte `fly deploy`-Aufrufe für `odoo-bot-middleware` / `odoo-bot-harness` sind nicht mehr vorgesehen: ohne Build-Arg meldet `/health` `version: "unknown"` (Oktober 2026 mehrfach passiert), und der Build-Log zeigt dann einen `WARNING: OMADIA_VERSION build arg is EMPTY`-Banner.

## Anti-Pattern, die wir schon bezahlt haben

- **Doc-less Schema-Änderung**: v20-Build hat `CLAUDE_AGENT_ID` aus dem Zod-Schema entfernt, das Deployment enthielt aber noch das alte Config-Verhalten — Crashloop. Fix: Schema-Änderungen ab jetzt immer zusammen mit CHANGELOG-Eintrag + `.env.example`-Update.
- **Token in Agent-Config-YAML**: Bearer-Tokens dürfen nie im System-Prompt einer Agent-Config landen. Policy: Credentials gehören **ausschließlich** in den Deployment-Vault — siehe `docs/security-architecture.md` §1.
- **Build-Artefakt vergessen**: `tsc` kopiert keine `.sql`-Files. Fix via `middleware/scripts/copy-build-assets.mjs`. Generell: Non-TS-Assets brauchen immer einen expliziten Build-Schritt.

## Git Workflow & Engineering Standards

Diese Regeln gelten für alle AI-Agenten (Claude, Codex, Copilot, …) und für menschliche Contributors gleichermaßen. Source of truth: das `engineering-standards`-Repo des Accounts (nicht öffentlich — die hier relevanten Regeln stehen vollständig unten). Status dieses Repos: `.github/engineering-standards.yml` (`status: applied`).

- **Niemals direkt auf `main` pushen.** Feature-Branch + PR. Lokal blockt `.hooks/pre-push`, serverseitig Branch Protection.
- **Branch-Naming:** `feat/<desc>`, `fix/<desc>`, `refactor/<desc>`, `docs/<desc>`, `chore/<desc>`, `test/<desc>`, `ci/<desc>`, `perf/<desc>`, `release/vX.Y`, `dev/vX.Y.devN`.
- **Conventional Commits:** `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:`, `perf:`, `release:`, `dev:`. Subject < 70 Zeichen, Body erklärt das **Warum** (das *Was* steht im Diff).
- **Keine `Co-Authored-By:`-Trailer für Claude, Codex, Copilot oder andere KI-Agenten.** Commits werden unter der konfigurierten Git-Identität erstellt, ohne Model-Attribution-Footer. Auch nicht als empfohlenes Format in Templates oder Hilfetexten auftauchen lassen.
- **Niemals force-push** auf geteilte Branches (besonders `main`).
- **Niemals Secrets committen** (`.env`, API-Keys, Tokens). Bei Treffer: rotiert das betroffene Secret sofort.
- **Niemals `--no-verify`.** Wenn ein Hook fehlschlägt, erst die Ursache fixen.

### Pre-push-Hook aktivieren

Der Hook ist in `.hooks/pre-push` versioniert. Aktivierung pro Working-Tree:

```bash
git config core.hooksPath .hooks   # erledigt auch script/setup
```

Override für Notfälle (sehr selten gerechtfertigt):

```bash
ALLOW_PUSH_TO_MAIN=1 git push origin main
```

### PR-Regeln

- PR-Titel < 70 Zeichen, Conventional-Prefix.
- Eine logische Änderung pro PR — kein "While I'm at it…"-Stacking.
- CI muss grün sein vor Merge. Required sind die Status-Checks `middleware`, `web-ui`, `schema`, `desktop` und die drei `audit`-Jobs (middleware, web-ui, desktop).
- Squash-Merge ist Default; der PR-Titel wird zur Commit-Subject-Zeile.

## Meta

Dieses Dokument wird selbst im CHANGELOG geführt, wenn sich die Regeln ändern. Kein stilles Ändern der Regeln ohne Doku.

— Stand 2026-05-17, byte5
