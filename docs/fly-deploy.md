# Deploy unserer Fly-Instanz (`scripts/fly-deploy.sh`)

`scripts/fly-deploy.sh` ist **der** Weg, byte5s eigene Fly-Instanz zu deployen: die Apps `odoo-bot-middleware` (Kernel, Root-`Dockerfile`) und `odoo-bot-harness` (web-ui, `web-ui/Dockerfile`). Handgetippte `fly deploy`-Aufrufe sind für diese Apps nicht mehr vorgesehen.

Nicht verwechseln mit [`fly/deploy.sh`](../fly/deploy.sh): Das ist der öffentliche One-Shot-Installer, der **neue** Apps in einer fremden Fly-Org anlegt (siehe [`deployment.md`](deployment.md)).

## Warum es das Skript gibt

Im Oktober 2026 gingen mehrere Deploys ohne `--build-arg OMADIA_VERSION` und ohne den gemeinsamen Lock raus. Folge: `/health` meldete `version: "unknown"`, und niemand konnte mehr sagen, welcher Commit live ist. Dazu kamen zwei weitere Fallen des manuellen Rezepts:

- Aus dem Haupt-Checkout `~/sources/odoo-bot` deployt, landen die gitignored privaten Packages `middleware/packages/harness-channel-teams|telegram` über `COPY middleware/packages` im Image.
- Neue Env-Vars oder Sidecars brauchen vor dem Deploy Fly-Secrets oder eigene Apps. Wer nur `fly deploy` tippt, merkt das erst am Crashloop.

Das Skript macht das Rezept deterministisch.

## Aufruf

Aus einem **sauberen, verlinkten Worktree** des Repos (nicht dem Haupt-Checkout):

```bash
git worktree add --detach ../omadia-deploy origin/main
cd ../omadia-deploy
scripts/fly-deploy.sh                 # origin/main deployen + verifizieren
scripts/fly-deploy.sh --dry-run       # zeigt die fly-Kommandos, deployt nichts
scripts/fly-deploy.sh --only-verify   # nur Live-Checks, read-only
```

Das Skript verweigert (Exit 3), wenn der aktuelle Checkout dirty ist (lokale Änderungen würden nicht mitgehen, weil aus einem frischen Worktree gebaut wird) oder wenn es der Haupt-Checkout ist (`git rev-parse --git-dir` gleich `--git-common-dir`). `--only-verify` prüft beides nicht, weil es nichts verändert.

## Ablauf

1. Checkout-Prüfung (dirty / Haupt-Checkout), `fly.toml`-Dateien vorhanden.
2. Lock `/tmp/omadia-fly-deploy.lock` nehmen (siehe unten).
3. `git fetch origin`, Ziel auflösen (Default `origin/main`), Stempel `sha-<8>`.
Ein Ziel, das nicht auf `origin/main` liegt, wird ohne `--allow-unmerged` abgelehnt. Live gilt ein Ziel nur, wenn beide Apps es enthalten (ein halb gescheiterter Lauf wird beim nächsten Mal nachgeholt). Den Lock gibt das Skript nur frei, wenn die `owner`-Datei noch seine PID nennt.

4. Live-Sha aus `https://odoo-bot-middleware.fly.dev/health` (Feld `version`) lesen. Ist das Ziel schon Vorfahre des Live-Sha, endet das Skript mit Exit 0 ("already live"), außer mit `--force`.
5. `git diff --stat <live> <ziel> -- middleware/sidecars fly/ middleware/.env.example`. Nicht leer, oder Live-Version nicht auflösbar (`unknown`): Abbruch mit Exit 3 und Diff-Stat. Erst Secrets/Sidecars prüfen, dann `--allow-config-diff`.
6. Frischen detached Worktree am Ziel in einem Temp-Verzeichnis anlegen, die gitignored `fly.toml`-Dateien **nur dort hinein** kopieren.
7. Middleware: `fly deploy --config fly.toml --app odoo-bot-middleware --build-arg OMADIA_VERSION=sha-<8> --build-arg INSTALL_SUBSCRIPTION_CLIS=true` (Worktree-Root). Danach web-ui aus `web-ui/`: `fly deploy --config fly.toml --app odoo-bot-harness --build-arg OMADIA_VERSION=sha-<8>`.
8. Verifikation (unten), Zusammenfassung, Exit 1 bei jeder Abweichung.
9. Per `trap` auf EXIT/INT/TERM: Temp-Worktree entfernen, Lock freigeben.

## Flags

| Flag | Wirkung |
|---|---|
| `--sha <rev>` | Ziel-Commit statt `origin/main` |
| `--no-cache` | an beide `fly deploy` durchgereicht. Im Zweifel nutzen: der Depot-Builder hat einmal eine Layer mit leerer Version wiederverwendet |
| `--skip-webui` | nur Middleware deployen; web-ui-Version wird nicht gegen das Ziel geprüft |
| `--skip-middleware` | nur web-ui deployen; Live-Referenz für Skip/Config-Diff ist dann die web-ui |
| `--only-verify` | kein Lock, kein Worktree, kein Deploy. Ohne `--sha` reicht pro App ein wohlgeformter `sha-<8>`-Stempel (Middleware und web-ui dürfen verschieden sein); mit `--sha` müssen beide exakt passen |
| `--allow-config-diff` | trotz Änderungen an `middleware/sidecars`, `fly/`, `middleware/.env.example` (oder unbekannter Live-Version) deployen |
| `--force` | deployen, auch wenn live das Ziel schon enthält |
| `--allow-unmerged` | ein `--sha` deployen, das nicht auf `origin/main` liegt (sonst Abbruch mit Exit 3: nur gemergter Code geht live) |
| `--dry-run` | alles außer `fly deploy` und Verify; druckt die fly-Kommandos. Nimmt den Lock und baut den Temp-Worktree trotzdem |

Exit-Codes: `0` ok oder schon live, `1` Fehler oder Verify-Abweichung, `2` Usage, `3` verweigert.

## Env-Variablen

| Variable | Default |
|---|---|
| `OMADIA_FLY_MIDDLEWARE_TOML` | `$HOME/sources/odoo-bot/fly.toml` |
| `OMADIA_FLY_WEBUI_TOML` | `$HOME/sources/odoo-bot/web-ui/fly.toml` |
| `OMADIA_FLY_MIDDLEWARE_APP` | `odoo-bot-middleware` |
| `OMADIA_FLY_WEBUI_APP` | `odoo-bot-harness` |
| `OMADIA_FLY_MIDDLEWARE_URL` | `https://<middleware-app>.fly.dev` |
| `OMADIA_FLY_WEBUI_URL` | `https://<webui-app>.fly.dev` |
| `OMADIA_FLY_LOCK_DIR` | `/tmp/omadia-fly-deploy.lock` |
| `OMADIA_FLY_VERIFY_TIMEOUT` | `300` (Sekunden, die `/health` nach dem Deploy umspringen darf; Poll alle 10 s) |
| `OMADIA_FLY_REMOTE` | `origin` |

## Verifikation

Gegen beide Apps:

- `GET /health`: `version` gleich `sha-<8>` des Ziels (mit Retry bis zum Timeout, weil der Machine-Wechsel einen Moment dauert).
- `GET /.well-known/omadia-ui`: `wsUrl` beginnt mit `wss://`.
- `GET /api/v1/auth/login/entra/start` (Middleware) bzw. `/bot-api/v1/auth/login/entra/start` (Harness), ohne Redirect-Folgen: mindestens ein `Set-Cookie`, und jedes trägt `Secure`.

## Der Lock

`/tmp/omadia-fly-deploy.lock` ist ein Verzeichnis; `mkdir` ist atomar. Das Skript wartet in 30-s-Schritten, bis es den Lock bekommt, und zeigt dabei die Owner-Datei des Halters. Den eigenen Lock beschreibt es mit `pid`, `host`, `user`, `started`, `cwd` und `target` in `<lock>/owner`. Freigegeben wird er per `trap` bei EXIT, INT und TERM, aber **nur**, wenn dieser Prozess ihn genommen hat. Ein fremder Lock bleibt auch bei Abbruch liegen.

Manuelle Deploys anderer Sessions nutzen dasselbe Verzeichnis (`until mkdir /tmp/omadia-fly-deploy.lock 2>/dev/null; do sleep 30; done`). Fehlt die Owner-Datei, stammt der Lock von so einem manuellen Deploy. Einen verwaisten Lock nur löschen (`rm -rf /tmp/omadia-fly-deploy.lock`), wenn sicher kein Deploy mehr läuft.

## Build-Warnung bei leerem `OMADIA_VERSION`

`Dockerfile` und `web-ui/Dockerfile` drucken direkt nach `ARG OMADIA_VERSION=` einen mehrzeiligen `WARNING`-Banner auf stderr, wenn das Build-Arg leer ist. Der Build schlägt bewusst **nicht** fehl, weil lokale `docker compose build`-Läufe ohne Stempel legitim sind. Taucht der Banner im Fly-Build-Log auf, ging der Deploy am Skript vorbei.
