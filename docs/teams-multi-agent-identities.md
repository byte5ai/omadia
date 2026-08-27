# Mehrere omadia-Agenten als benannte Bots in Microsoft Teams

| | |
|---|---|
| **Status** | Live (Epic byte5ai/omadia#860, Waves W0a / W0b / W1a / W2a / W5) |
| **Zielgruppe** | Operator/Admin mit Azure-Portal-Zugriff |
| **Verifiziert gegen** | `byte5ai/omadia@main` (69f3f5bc), `@omadia/integration-microsoft365` 0.3.1, `@omadia/channel-teams` 0.21.0 |
| **Stand** | 2026-08-27 |

Diese Anleitung führt von null zu mehreren benannten omadia-Agenten, die in Microsoft
Teams als jeweils eigener Bot auftreten — mit eigenem Namen, eigenem Icon und eigener
App-Registrierung. Sie beschreibt den Weg über die Operator-Oberfläche und den
gleichwertigen Weg über die REST-API.

---

## 1. Was das Feature kann

omadia stellt pro Agent eine eigene Teams-Identität bereit:
**1 Agent = 1 Entra-App-Registrierung + 1 Azure-Bot + 1 generiertes Teams-App-Paket.**
Die Provisionierung läuft als asynchrone Kette

```
Entra-App → Azure-Bot → App-Paket → Tenant-Katalog → Team-Install
```

über die Operator-UI bzw. die Operator-API und wird im Middleware-Kernel persistiert
(Tabelle `agent_teams_identities`, Core-Migration `0049`). Ein Abbruch setzt genau dort
wieder auf, wo er stehengeblieben ist.

Ein einzelnes `@omadia/channel-teams`-Plugin betreibt dabei beliebig viele Bots
gleichzeitig; jeder Bot empfängt unter seinem eigenen Pfad
`/api/teams/<botSlug>/messages`.

### Die harte Plattform-Wahrheit

Vier Punkte, die nicht verhandelbar sind, weil sie aus Microsoft Teams kommen und nicht
aus omadia:

- **Kein Namenswechsel pro Nachricht.** Anzeigename und Icon einer Bot-Nachricht kommen
  aus dem Teams-App-Paket, nicht aus dem Nachrichten-Payload. Wer N sichtbar
  unterschiedliche Agenten in einem Kanal will, braucht **N Teams-Apps und N Bots** —
  genau das automatisiert dieses Feature. Ein einzelner Bot, der je nach Kontext „als
  Agent A" oder „als Agent B" spricht, ist auf der Plattform nicht darstellbar.
- **Bots sehen einander nicht.** Teams blockt Bot-zu-Bot by design: ein Bot empfängt
  niemals Nachrichten eines anderen Bots — auch nicht mit RSC
  `ChannelMessage.Read.Group` (die liefert Human-Messages ohne @mention).
  Agent-zu-Agent-Koordination läuft deshalb serverseitig in der Middleware, nie über
  den Kanal.
  ([Microsoft-Doku](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations))
- **Rate-Limits gelten pro Bot.** Etwa 7 Nachrichten/s pro Thread (8 pro 2 s, 60 pro
  30 s) und global 50 RPS pro App pro Tenant; Überschreitung → HTTP 429. Positiv
  gelesen: N getrennte Bots sind **N getrennte Budgets** statt eines geteilten.
  ([Microsoft-Doku](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit))
- **SingleTenant, im Kunden-Tenant.** Der Provisioner legt ausschließlich
  SingleTenant-Apps an (`signInAudience: 'AzureADMyOrg'`, `tenantMode: 'customer' |
  'home'`); MultiTenant ist im Typmodell nicht ausdrückbar. Azure hat das Anlegen neuer
  MultiTenant-Registrierungen 07/2025 deprecated. SingleTenant-Bots sind außerhalb
  ihres Heimat-Tenants **messaging-only** — SSO, proaktive Sends und Graph-Szenarien
  sind cross-tenant nicht zuverlässig. Deshalb ist die Architektur-Invariante:
  **App-Registrierung im Kunden-Tenant.**
  ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5882874/clarification-on-multi-tenant-support-for-single-t))

---

## 2. Voraussetzungen

### 2.1 Plugin-Versionen

| Plugin | Mindestversion | Warum |
|---|---|---|
| `@omadia/integration-microsoft365` | **0.3.1** (für Team-Deinstallation: **0.4.0**) | stellt die Capability `teamsProvisioner@1` bereit; ab 0.3.1 zusätzlich `getCatalogApp` (Katalog-Lookup ohne Upload), ab 0.4.0 `uninstallFromTeam` (App wieder aus einem Team entfernen, siehe 5.1) |
| `@omadia/channel-teams` | **0.21.0** | `teams_bots[]` (Multi-Bot ab 0.20.0), `teams_agent_apps[]` + Auto-Invite (0.21.0) |
| omadia-Middleware | **v0.136.2** | ältere Versionen lehnen das Plugin-Paket von channel-teams 0.21.0 am Ingest-Gate ab (siehe Troubleshooting) |

Beide Plugin-Versionen sind der aktuelle Stand auf `hub.omadia.ai` (Registry-Poll
2026-08-27). „Mindestversion" heißt: neuere Versionen sind in Ordnung, ältere nicht.

### 2.2 Kernel-Migrationen

| Migration | Serie | Was sie bringt |
|---|---|---|
| `0049_agent_teams_identities.sql` | Core (`middleware/migrations/`) | die Tabelle der Agent-Teams-Identitäten (`PRIMARY KEY (agent_id)`, `UNIQUE (bot_slug)`) |
| `0050_agent_context_memory_flag.sql` | Core (`middleware/migrations/`) | Spalte `agents.context_memory` — der Rollout-Schalter der Memory-ACL (Default `off`, siehe Abschnitt 8) |
| `0031_teams_conversation_refs.sql` | Knowledge-Graph (`middleware/packages/harness-knowledge-graph-neon/src/migrations/`) | `teams_conversation_refs` mit `bot_app_id` und Composite-PK `(conversation_id, bot_app_id)` |

Zu `0031` lohnt der Hintergrund: die ursprüngliche DDL lag als `0009` in
`middleware/src/services/graph/migrations/` — einem Verzeichnis, das seit der
KG-Konsolidierung **nichts mehr anwendet**. Deployments hatten die Tabelle deshalb nie,
und der Write-Through-Cache der Teams-Conversation-Refs fiel still auf Cache-only
zurück (der Store ist best-effort, es hat nie etwas geworfen). `0031` holt die Tabelle
in die Serie, die tatsächlich läuft, und ergänzt `bot_app_id TEXT NOT NULL DEFAULT ''`
(`''` = Legacy-/Default-Bot). Für Operatoren gibt es dabei nichts zu tun: die Migration
wird beim nächsten Boot angewendet, Single-Bot-Deployments verhalten sich
byte-identisch weiter.

> Ohne `bot_app_id` wäre Multi-Bot-Betrieb nicht sauber isoliert — proaktive Sends
> könnten zwischen Bots übersprechen (Bot A präsentiert die Credentials von Bot B an
> `continueConversationAsync`).

### 2.3 Middleware-Konfiguration

- **`DATABASE_URL` gesetzt.** Ohne Datenbank registriert sich die Identity-Verdrahtung
  nicht; alle Teams-Identity-Endpunkte antworten `503 teams_identity_unavailable`.
- **`TEAMS_PUBLIC_BASE_URL`** (Fallback: `PUBLIC_BASE_URL`) — daraus baut der Kernel den
  Messaging-Endpoint jedes Bots als
  `https://<your-omadia-host>/api/teams/<botSlug>/messages`. Der Builder
  (`buildTeamsBotMessagingEndpoint`) erzwingt **https** (Azure lehnt Nicht-TLS-
  Bot-Endpoints ab) und verbietet Credentials, Query-String und Fragment in der
  Basis-URL.

### 2.4 Azure-Rechte und Admin-Consent

Der Provisioner arbeitet im App-Only-Flow (Client-Credentials) auf der
App-Registrierung, die in den Setup-Feldern des M365-Connectors hinterlegt ist.
Zusätzlich zu den fachlichen Graph-Berechtigungen brauchen die Provisioning-Schritte
diese **Application Permissions**:

| Scope | Wofür | Graph-Call |
|---|---|---|
| `Application.ReadWrite.OwnedBy` | Pro-Agent-App-Registrierungen + deren Client-Secrets anlegen | `POST /applications`, `POST /applications/{id}/addPassword` |
| `AppCatalog.ReadWrite.All` | generiertes Teams-App-Paket in den Tenant-Katalog hochladen / auflösen | `POST /appCatalogs/teamsApps`, `GET /appCatalogs/teamsApps` |
| `TeamsAppInstallation.ReadWriteForTeam.All` | Katalog-App ins Ziel-Team installieren | `POST /teams/{id}/installedApps` |

Vergabe: **Azure Portal → App registrations → API permissions → Add a permission →
Microsoft Graph → Application permissions**, danach **Grant admin consent for
`<Tenant>`**. Alternativ einen Admin über die tenant-weite Consent-URL schicken (sie
enthält nur die öffentliche Client-ID, nie ein Secret):

```
https://login.microsoftonline.com/<tenant-id>/adminconsent?client_id=<application-client-id>
```

#### Die drei Fallstricke beim Consent

1. **Erneuter Consent ist Pflicht.** Bereits erteilter Admin-Consent deckt **neu
   hinzugefügte** Scopes nicht ab. Nach jeder Berechtigungsänderung an einer
   bestehenden Registrierung muss der Consent erneut erteilt werden — App-Only-Tokens
   tragen nur die Rollen, denen zum Zeitpunkt der Token-Ausstellung zugestimmt wurde.

2. **Portal-/CLI-Consent greift manchmal still nicht.** Feldbeobachtung mit
   `az ad app permission admin-consent`: Das Kommando meldet Erfolg, Graph antwortet
   weiter `403`. In dem Fall die App-Rollen direkt per REST vergeben — ein Call pro
   fehlender Permission, auf dem Service Principal der App:

   ```
   POST /servicePrincipals/{app-sp-object-id}/appRoleAssignments
   {
     "principalId": "{app-sp-object-id}",
     "resourceId":  "{graph-sp-object-id}",
     "appRoleId":   "{app-role-id-of-the-missing-permission}"
   }
   ```

   Die Object-ID des Microsoft-Graph-Service-Principals (`resourceId`) kommt aus
   `GET /servicePrincipals(appId='00000003-0000-0000-c000-000000000000')`.
   Kontrolle: `GET /servicePrincipals/{app-sp-object-id}/appRoleAssignments`.

3. **Nach dem Consent die Middleware neu starten.** Tokens werden gecacht; neu
   zugestimmte Rollen erscheinen erst in einem *frischen* Token. Ohne Restart (oder
   Ablauf des Tokens) bleiben die `403`s bestehen, obwohl der Consent korrekt erteilt
   ist.

### 2.5 Optionale ARM-Felder — und was ohne sie passiert

Der Azure-Bot-Schritt spricht ARM REST (`Microsoft.BotService`). Die dafür nötigen
Setup-Felder am M365-Connector sind **alle optional**:

| Setup-Feld | Label | Format |
|---|---|---|
| `azure_subscription_id` | Azure Subscription ID | GUID (`^[0-9a-fA-F-]{36}$`) |
| `azure_resource_group` | Azure Resource Group | Name der RG für `Microsoft.BotService/botServices` (`^[-A-Za-z0-9_.()]{1,90}$`) |
| `azure_region` | Azure Region | ARM-Location, für Azure Bot Services üblicherweise `global` (`^[a-z0-9]{2,32}$`) |
| `azure_sp_client_id` | ARM Service Principal Client ID | GUID; leer lassen → die Bot-Framework-App wird für ARM wiederverwendet |
| `azure_sp_client_secret` | ARM Service Principal Client Secret | leer lassen → das App-Secret der Bot-Framework-App wird wiederverwendet |

Fehlen sie, degradiert der Provisioner sauber in den **Registration-only-Modus**: Die
Entra-App-Registrierung wird erstellt und behalten, `createBot` liefert statt eines
Fehlers den typisierten Ausgang `RegistrationOnlyOutcome` (`kind: 'registration-only'`,
`reason: 'arm-not-configured'`, `missingSetupFields`). Der Lauf **hält an statt zu
scheitern** — der Zustand bleibt `app_registered` — und schreibt in `last_error`:

```
arm_not_configured: bot creation needs the ARM setup fields [<felder>] on the M365
connector — configure them, then re-run provisioning (the app registration is kept)
```

Der Azure-Bot muss dann manuell angelegt werden (Messaging-Endpoint:
`https://<your-omadia-host>/api/teams/<botSlug>/messages`), oder man trägt die
ARM-Felder nach und startet die Provisionierung erneut.

Netzwerk-Egress: Der Connector deklariert `login.microsoftonline.com`,
`graph.microsoft.com` und `management.azure.com`. Ohne den ARM-Eintrag wäre der
Azure-Bot-Schritt schon transportseitig geblockt.

---

## 3. Setup Schritt für Schritt

### Schritt 1 — M365-Connector konfigurieren

`@omadia/integration-microsoft365` (≥ 0.3.1) installieren und konfigurieren:

| Feld | Label | Pflicht |
|---|---|---|
| `microsoft_tenant_id` | Azure AD Tenant ID | ja |
| `microsoft_app_id` | App (Client) ID | ja |
| `microsoft_app_password` | App (Client) Secret | ja |
| `azure_subscription_id`, `azure_resource_group`, `azure_region`, `azure_sp_client_id`, `azure_sp_client_secret` | ARM-Felder | nein (siehe 2.5) |

### Schritt 2 — Admin-Consent erteilen

Die drei Scopes aus 2.4 hinzufügen, Admin-Consent erteilen, **Middleware neu starten**.
Kontrolle: `GET /api/v1/operator/agents/<slug>/teams-identity` liefert
`"provisioner_installed": true`, sobald der Connector die Capability
`teamsProvisioner@1` im Service-Registry veröffentlicht.

### Schritt 3 — channel-teams konfigurieren (`teams_bots`)

`@omadia/channel-teams` (≥ 0.21.0) installieren. Das Setup-Feld **`teams_bots`**
(„Teams Bots (JSON)") nimmt ein JSON-Array von Bot-Identitäten:

```json
[
  {
    "botSlug": "vertriebs-agent",
    "displayName": "Vertriebs-Agent",
    "appId": "11111111-2222-3333-4444-555555555555",
    "appType": "SingleTenant",
    "tenantId": "66666666-7777-8888-9999-000000000000",
    "appPasswordSecretRef": "teams_bot_password:11111111-2222-3333-4444-555555555555"
  }
]
```

Regeln, die das Plugin hart durchsetzt:

- `botSlug` muss `^[a-z0-9][a-z0-9-]{0,62}$` erfüllen (1–63 Zeichen).
- `appPasswordSecretRef` ist eine **Vault-Referenz**, niemals das Passwort. Ein inline
  gesetztes `appPassword` wird abgelehnt.
- `appType`: `MultiTenant | SingleTenant | UserAssignedMSI`, Default `SingleTenant`.
- **Eintrag 0 ist der Default-Bot** — er bedient zusätzlich die Aliasse `/api/messages`
  (Legacy) und `/api/teams/messages`, damit bestehende Azure-Bot-Registrierungen
  weiterlaufen.
- Jeder Bot empfängt unter `/api/teams/<botSlug>/messages`.
- Feld leer lassen → Single-Bot-Betrieb über die Scalar-Credentials der
  M365-Integration (`microsoft_app_id` / `microsoft_tenant_id` /
  `microsoft_app_password`, App-Typ aus `MICROSOFT_APP_TYPE`, dort Default
  `MultiTenant`). Bestehende Single-Bot-Deployments laufen dadurch unverändert weiter.

> **Wichtig:** Die Übernahme einer frisch provisionierten Identität in `teams_bots[]`
> ist **nicht automatisch**. Der Kernel schreibt die Identität in seine eigene Tabelle,
> nicht in die Plugin-Config. UI und Statusendpunkt liefern unter `teams_bot` einen
> fertig geformten Eintrag, den man 1:1 in dieses Feld einfügt. Siehe Abschnitt 4.4.

### Schritt 4 (optional) — `teams_agent_apps` für Auto-Invite

Setup-Feld **`teams_agent_apps`** („Auto-Invite Agenten-Apps (JSON)"), JSON-Array:

```json
[
  {
    "agentSlug": "vertriebs-agent",
    "teamsAppExternalId": "de3c2a76-0000-0000-0000-000000000000",
    "teamsAppId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "displayName": "Vertriebs-Agent"
  }
]
```

- `agentSlug` ist der omadia-Conductor-Slug — reines Label/Status, **kein Routing**.
- `teamsAppExternalId` ist die Manifest-ID (`externalId`) und der Lookup-Schlüssel.
- `teamsAppId` (Graph-Katalog-ID) überspringt den Katalog-Lookup; ohne sie wird
  `getCatalogApp` des Connectors (≥ 0.3.1) genutzt, sofern vorhanden.
- Alle IDs sind öffentliche App-IDs — niemals Secrets.
- Das Feld akzeptiert ein echtes Array (Install-Registry) oder einen JSON-String
  (Setup-Wizard). Leer lassen → Auto-Invite komplett aus.

---

## 4. Agenten anlegen und provisionieren

Es gibt zwei gleichwertige Wege: die Operator-Oberfläche (empfohlen) und die REST-API.
Beide sprechen dieselben Endpunkte.

### 4.1 Der UI-Weg

Die Agent-Detailseite liegt unter **`/operator/agents/<slug>`**. Sie ist eine einzelne
vertikale Seite ohne Tabs; die Abschnitte in Reihenfolge:

| Abschnitt | Was er tut |
|---|---|
| **Teams-Identität** | Identität anlegen, Live-Provisioning-Status, Fehler, `teams_bots`-Block |
| **Teams-Zuordnung** | Consent-Status, Installationsliste, Installation in ein Team |
| **Persona und Verhalten** | Link in den Agent Builder (Abschnitt 7) |
| **Zugewiesene Plugins** | Plugin-Zuweisung des Agenten |
| **Tool-Grants** | Tool-Freigaben |
| **MCP-Server** | MCP-Server und -Grants |

**Identität anlegen.** Hat der Agent noch keine Teams-Identität, zeigt der Abschnitt
„Teams-Identität" ein Formular mit drei Feldern:

| Feld | Pflicht | Hinweis in der UI |
|---|---|---|
| **Bot-Slug** | nein | „Kleinbuchstaben, Ziffern und Bindestriche. Muss über alle Orchestratoren hinweg eindeutig sein." |
| **Anzeigename** | nein | „Der Name, den Menschen in Teams sehen." |
| **Ziel-Team-ID** | **ja** | „Pflichtfeld. Die Teams-Team-(Gruppen-)ID, in die die App installiert wird." |

Bot-Slug und Anzeigename leitet der Server ohne Angabe aus dem Agenten ab. Der Button
**„Provisioning starten"** bleibt inaktiv, solange die Ziel-Team-ID leer ist.

**Live-Status.** Solange der Zustand nicht terminal ist (`installed` oder `failed`),
pollt die Seite **alle 3 Sekunden** und zeigt die Provisioning-Kette als Fortschritts-
liste: *ausstehend → App registriert → Bot angelegt → Paket gebaut → Katalog
hochgeladen → installiert*. `fehlgeschlagen` ist eine Senke und belegt keinen Schritt
der Kette. Dazu eine Statuszeile („Ein Provisioning-Lauf ist gerade aktiv." /
„Aktuell läuft kein Provisioning.") und eine Faktenliste mit Bot-Slug, Anzeigename,
Anwendungs-ID (Client), Tenant-ID, Teams-App-ID und externer Teams-App-ID; noch nicht
vergebene Werte stehen als „noch nicht vergeben".

**Verständliche Fehler.** Die UI rendert nicht den rohen Satz aus `last_error`, sondern
den serverseitig klassifizierten Code — je mit *Was ist passiert*, *Was jetzt zu tun
ist* und einem aufklappbaren „Technisches Detail":

| Code | Was die UI sagt (gekürzt) |
|---|---|
| `consent_missing` | „Microsoft hat die Anfrage abgelehnt, weil eine Tenant-Administration die Admin-Zustimmung für die benötigten Berechtigungen noch nicht erteilt hat." + Liste der fehlenden Berechtigungen + Link auf die Entra-Doku. Ein erneuter Lauf ohne die Zustimmung ändert nichts. |
| `arm_not_configured` | „Die Entra-App-Registrierung wurde angelegt, für den Bot selbst fehlen aber Azure-Setup-Felder, die am M365-Connector noch leer sind." + Liste der Felder + ausdrücklich: „Hier stehenzubleiben ist völlig in Ordnung. Die App-Registrierung bleibt bestehen … der Agent ist nicht kaputt — er hat nur noch keinen Teams-Bot." |
| `throttled` | „Microsoft hat die Provisioning-Anfragen gedrosselt …" — inklusive Wartezeit, wenn Microsoft eine genannt hat. „An der Konfiguration ist nichts falsch." |
| `unknown` | „Das Provisioning wurde aus einem Grund gestoppt, den omadia nicht einordnen kann." → technisches Detail ansehen |

Zwei Zustände sind bewusst **keine** Fehler, sondern graue Hinweise:
`teams_identity_unavailable` und `teams_provisioner_unavailable`.

Bei terminalem Zustand erscheint **„Provisioning erneut ausführen"**. Der Button
re-POSTet die **hinterlegte** `team_id`; ist keine hinterlegt, ist er deaktiviert.

**Der `teams_bots`-Block — mit ehrlichem Hinweis.** Sobald App- und Tenant-ID
existieren, zeigt der Unterabschnitt „Konfiguration für das Teams-Channel-Plugin" den
fertigen JSON-Block (Schlüssel in der Reihenfolge `botSlug`, `displayName`, `appId`,
`appType`, `tenantId`, `appPasswordSecretRef`) mit **Kopieren**-Button. Dabei stehen
drei Sätze, die man ernst nehmen sollte:

> „Ein manueller Schritt bleibt: Dieser Block muss von Hand in das
> Teams-Channel-Plugin eingetragen werden."
>
> „Diese Konfiguration automatisch zu schreiben ist als Folgeschritt geplant und
> passiert heute nicht."
>
> „Der Block enthält nur eine Referenz auf das Bot-Passwort, niemals das Passwort
> selbst — das Geheimnis bleibt im Vault des M365-Connectors."

Vor der Entra-Registrierung steht dort: „Es gibt noch keine Bot-Konfiguration — sie
erscheint, sobald die Entra-App-Registrierung existiert."

### 4.2 Der REST-Weg

Alle Endpunkte hängen unter `/api/v1` und sind über `requireAuth` auth-gated.

#### Provisionierung starten

```
POST /api/v1/operator/agents/<agent-slug>/teams-identity
Content-Type: application/json
```

| Body-Feld | Typ | Pflicht | Regeln |
|---|---|---|---|
| `team_id` | string | **ja** | 1–200 Zeichen; Graph-Team-(Group-)ID des Ziel-Teams |
| `bot_slug` | string | nein | `^[a-z0-9][a-z0-9-]{0,62}$`; Default: aus dem Agent-Slug abgeleitet |
| `display_name` | string | nein | 1–120 Zeichen; Default: der Name des Agenten |

```bash
curl -X POST "https://<your-omadia-host>/api/v1/operator/agents/vertriebs-agent/teams-identity" \
  -H "Content-Type: application/json" \
  -d '{"team_id":"19:xxxxxxxx@thread.tacv2","bot_slug":"vertriebs-agent","display_name":"Vertriebs-Agent"}'
```

Der Default-`bot_slug` entsteht aus dem Agent-Slug: lowercase, alles außerhalb
`[a-z0-9-]` wird zu `-`, dann auf 63 Zeichen gekürzt, danach führende/abschließende
Bindestriche entfernt (leeres Ergebnis → `agent`).

**Antwort `202 Accepted`** — der Call ist per Vertrag asynchron und blockiert nie auf
Graph/ARM:

```json
{
  "ok": true,
  "agent": "vertriebs-agent",
  "bot_slug": "vertriebs-agent",
  "state": "pending",
  "running": true
}
```

`running` ist ein ehrliches Signal: `true` nur, wenn der Runner tatsächlich einen Lauf
für diesen Agenten hält (ein abgelehntes Enqueue lässt es `false`).

| Status | `error` | Bedeutung |
|---|---|---|
| `400` | (Zod-Validierungsfehler) | Body verletzt das Schema (z. B. ungültiger `bot_slug`) |
| `404` | `not_found` | Es gibt keinen Agenten mit diesem Slug |
| `409` | `bot_slug_taken` | Der Slug gehört bereits einem **anderen** Agenten (`UNIQUE (bot_slug)`) |
| `409` | `team_install_conflict` | Retarget auf ein anderes Team — siehe 5.1 |
| `503` | `teams_provisioner_unavailable` | `teamsProvisioner@1` nicht installiert/aktiv — M365-Connector ≥ 0.3.1 installieren und aktivieren |
| `503` | `teams_identity_unavailable` | Identity-Store + Job-Runner nicht verdrahtet (kein `DATABASE_URL` / Boot-Wiring nicht gelaufen) |

Ein erneuter POST auf denselben Agenten mit **demselben** Team ist unschädlich: Die
Zeile wird per `agent_id`-Primärschlüssel create-if-absent behandelt. Genau so startet
man auch einen in `failed` geparkten Lauf neu.

#### Status abfragen

```
GET /api/v1/operator/agents/<agent-slug>/teams-identity
```

```json
{
  "ok": true,
  "agent": "vertriebs-agent",
  "state": "catalog_uploaded",
  "running": true,
  "provisioner_installed": true,
  "identity": {
    "bot_slug": "vertriebs-agent",
    "display_name": "Vertriebs-Agent",
    "app_id": "11111111-2222-3333-4444-555555555555",
    "tenant_id": "66666666-7777-8888-9999-000000000000",
    "teams_app_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "teams_app_external_id": "de3c2a76-0000-0000-0000-000000000000",
    "team_id": "19:xxxxxxxx@thread.tacv2",
    "last_error": null,
    "last_error_detail": null,
    "created_at": "2026-08-20T09:12:44.000Z",
    "updated_at": "2026-08-20T09:13:58.000Z"
  },
  "teams_bot": {
    "botSlug": "vertriebs-agent",
    "displayName": "Vertriebs-Agent",
    "appId": "11111111-2222-3333-4444-555555555555",
    "appType": "SingleTenant",
    "tenantId": "66666666-7777-8888-9999-000000000000",
    "appPasswordSecretRef": "teams_bot_password:11111111-2222-3333-4444-555555555555"
  }
}
```

- `teams_bot` ist die fertige `teams_bots[]`-Projektion (camelCase, exakt das Format,
  das channel-teams parst) — direkt kopierbar. Sie ist `null`, solange noch keine
  Entra-App existiert (`app_id`/`tenant_id` fehlen).
- `last_error_detail` ist derselbe Fehler, nur strukturiert:
  `{code, raw, scopes?, fields?, retryAfterSeconds?}` mit
  `code ∈ {consent_missing, arm_not_configured, throttled, unknown}`. Clients rendern
  aus `code` plus typisierten Argumenten — nie durch Parsen des englischen Satzes.
- `appPasswordSecretRef` ist eine **Referenz**, kein Secret: `teams_bot_password:<appId>`.
  Das Client-Secret verlässt nie den Vault des Connectors und steht weder in der Tabelle
  noch in einer HTTP-Antwort — die Tabelle `agent_teams_identities` hat bewusst *keine*
  Secret-Spalte.
- `404 not_found` = kein Agent mit diesem Slug; `404 teams_identity_not_found` = Agent
  existiert, hat aber noch keine Identity-Zeile.

### 4.3 Was die States bedeuten

```
pending → app_registered → bot_created → package_built → catalog_uploaded → installed
```

| State | Erreicht, wenn … | Nächster Schritt |
|---|---|---|
| `pending` | Zeile angelegt, noch kein Remote-Call erfolgreich | Entra-App-Registrierung (`createAppRegistration`) |
| `app_registered` | Entra-App + Client-Secret existieren (`app_id`, `tenant_id` gesetzt) | Azure-Bot per ARM + Teams-Kanal |
| `bot_created` | Azure-Bot existiert und zeigt auf den Messaging-Endpoint | App-Paket rendern |
| `package_built` | Teams-App-Paket (manifest.json + Icons) gerendert | Upload in den Tenant-Katalog |
| `catalog_uploaded` | App im Org-Katalog, `teams_app_id` gesetzt | `POST /teams/{id}/installedApps` |
| `installed` | App im Ziel-Team installiert | fertig |
| `failed` | terminal abgebrochen; `last_error` erklärt warum | Ursache beheben, POST erneut |

Jeder Schritt ist idempotent über einen stabilen Schlüssel (Graph `uniqueName`,
ARM-Bot-Handle, Katalog-`externalId`, Team-Install). Ein Resume betritt die Kette anhand
der persistierten Spalten wieder — nichts wird doppelt angelegt. Auch eine
`failed`-Zeile resumt so; sie bleibt aber geparkt, bis ein Operator erneut POSTet.

Beim Middleware-Boot werden unterbrochene Läufe automatisch neu eingereiht: alle Zeilen
mit `state NOT IN ('installed','failed')` **und** gesetzter `team_id`.

**Dauer.** Der Runner arbeitet im Hintergrund. Ein manueller Spike der Kernschritte
(App-Registration → Azure-Bot F0 → Teams-Kanal → Manifest-ZIP) lief in unter 60
Sekunden; Katalog-Upload und Team-Install kommen hinzu, und die Katalog-Sichtbarkeit
kann nachlaufen. Als Erfahrungswert: **typischerweise unter zwei Minuten**, ohne Zusage.

Bei Fehlern gilt ein Retry-Budget von **5 Versuchen**, exponentieller Backoff ab
**5 s**, jede einzelne Wartezeit gedeckelt auf **300 s**. Ein `Retry-After`-Hinweis der
API gewinnt gegen den Backoff, aber nie gegen den Deckel.

### 4.4 Was in `last_error` steht — und was zu tun ist

| `last_error` beginnt mit | Zustand danach | Bedeutung | Aktion |
|---|---|---|---|
| `consent_missing: admin consent required for scopes [...]` | `failed` (**terminal**) | Graph/ARM antwortete 403; die genannten Scopes fehlen | Scopes vergeben, Admin-Consent (ggf. via REST `appRoleAssignments`), **Middleware neu starten**, dann POST erneut |
| `arm_not_configured: bot creation needs the ARM setup fields [...]` | bleibt `app_registered` (**nicht terminal**) | ARM-Felder fehlen; die App-Registrierung bleibt erhalten | ARM-Felder am Connector setzen **oder** den Azure-Bot manuell anlegen, dann POST erneut |
| `throttled: … (gave up after N attempts; retry after Ms)` | erreichter State bleibt erhalten | 429-Drosselung, Retry-Budget erschöpft | später erneut POSTen — der Fortschritt ist echt und bleibt erhalten |
| `… (gave up after N attempts)` | erreichter State bleibt bei „Provisioner gerade weg"; sonst `failed` | Retry-Budget erschöpft | später erneut POSTen |
| `enqueue_failed: <message>` | unverändert | Das Einreihen selbst schlug fehl; es läuft nichts | Log `[operator-agents] teams provisioning enqueue for '<slug>' failed:` bzw. `… was refused:` prüfen, dann POST erneut |
| `teams_app_package_assets_unavailable: …` | `failed` nach Retries | Das App-Paket-Template ist nicht ladbar | `@omadia/channel-teams` muss installiert sein und `appPackage/{manifest.json.template,color.png,outline.png}` mitbringen |

**Merksatz zur Fehlerpolitik:** `consent_missing` ist terminal (Retry kann nichts
ausrichten, bevor ein Admin zustimmt). `arm_not_configured` ist *nicht* terminal — es
ist ein Teilerfolg. Drosselung und „Connector gerade nicht da" werden im Budget
wiederholt und stürzen nie ab; der erreichte Zustand bleibt stehen.

### 4.5 Die Identität ins Plugin übernehmen

Dieser Schritt ist **manuell** und wird heute von nichts automatisiert:

1. `teams_bot`-Block aus der UI kopieren (Button „Kopieren") oder aus
   `GET …/teams-identity` entnehmen.
2. Im Setup des `@omadia/channel-teams`-Plugins in das Feld **`teams_bots`** einfügen —
   als weiteres Element des JSON-Arrays, nicht als Ersatz.
3. Speichern. Der Bot empfängt danach unter `/api/teams/<botSlug>/messages`.

> Der Slug im Messaging-Endpoint des Azure-Bots und der `botSlug` in `teams_bots[]`
> müssen exakt übereinstimmen. Es gibt bewusst **keinen** Fallback auf fremde
> Credentials: ein unbekannter Slug antwortet nicht, statt mit dem falschen Bot zu
> antworten.

---

## 5. Agenten in ein Team bekommen

Es gibt drei Wege, und sie ergänzen sich: die Team-Zuordnung in der Operator-UI, der
Auto-Install beim Einladen eines Bots, und die Fallback-Card im Kanal.

### 5.1 Team-Zuordnung in der Operator-UI

Der Abschnitt **„Teams-Zuordnung"** auf der Agent-Detailseite zeigt

- **Admin-Zustimmung**: `erteilt` / `fehlt` / `nicht belegt`, bei `fehlt` mit der Liste
  der ausstehenden Berechtigungen. Der Status ist abgeleitet, nicht live gemessen:
  entweder aus dem letzten Fehler oder aus einem Zustand, den die Kette ohne Consent
  gar nicht hätte erreichen können.
- **Installiert in**: die abgeleitete Installationsliste (`evidence: 'identity_row'`).
  Sie ist leer, solange die Kette nicht `installed` erreicht hat — ein `team_id` auf
  einem früheren Zustand ist das *Ziel* eines laufenden Laufs, keine Installation.
- **In ein Team installieren**: Feld „Team-ID" (Pflicht) plus Button „Installieren".
- **Deinstallieren**: pro installiertem Team ein Button — aktiv ab
  M365-Connector **0.4.0** (siehe unten).

Die zugehörigen Endpunkte:

| Methode + Pfad | Zweck |
|---|---|
| `GET /api/v1/operator/agents/:slug/teams` | abgeleitetes Read-Model + `consent` + `capabilities` + `teams_bot` |
| `POST /api/v1/operator/agents/:slug/teams` | Body `{"team_id":"…"}` → `202`, setzt das Ziel und lässt die Kette weiterlaufen |
| `DELETE /api/v1/operator/agents/:slug/teams/:teamId` | entfernt die App aus dem Team (ab Connector 0.4.0) — siehe unten |

`GET …/teams` liefert ein `capabilities`-Objekt, aus dem die UI ableitet, was sie
anbieten darf, statt es aus fehlgeschlagenen Requests zu lernen:

| Capability | Wert | Begründung |
|---|---|---|
| `install` | `true` | Installation durch Fortsetzen der Provisioning-Kette |
| `uninstall` | **abhängig vom Connector** | `true`, sobald das installierte `teamsProvisioner@1` `uninstallFromTeam` veröffentlicht (M365-Connector ≥ 0.4.0); sonst `false` |
| `enumerate` | `false` | der Connector veröffentlicht keine Installations-Auflistung — die Liste ist abgeleitet, nicht live |
| `multi_team` | `false` | `agent_teams_identities` speichert **ein** `team_id` pro Agent |

#### Deinstallieren (ab Connector 0.4.0)

**Was passiert.** Der Button steht hinter einem Bestätigungsdialog. Bestätigt man,
ruft die Middleware `uninstallFromTeam({teamId, teamsAppId})` des Connectors auf. Der
löst die Graph-**Installations-ID** auf
(`GET /teams/{id}/installedApps?$expand=teamsApp&$filter=teamsApp/id eq '…'`) und
löscht sie (`DELETE /teams/{id}/installedApps/{installationId}`). Erst **danach** wird
die Zeile aufgeräumt: `state` fällt auf `catalog_uploaded` zurück, `team_id` wird
`NULL`. Entra-App, Azure-Bot und Katalog-Eintrag bleiben bestehen — ein späterer
`POST …/teams` setzt genau dort wieder auf und kostet einen einzigen Graph-Call.

Die Reihenfolge ist Absicht: Graph zuerst, Zeile danach. Bricht etwas dazwischen ab,
konvergiert ein Retry (die Entfernung ist idempotent). Andersherum bliebe eine noch
laufende Installation zurück, die nichts mehr führt.

**War die App gar nicht im Team**, ist das trotzdem ein Erfolg: die Antwort trägt
`outcome: "already-absent"`, die UI meldet „Die App war nicht in Team … installiert —
die Zuordnung wurde aufgehoben", und die Zeile wird genauso aufgeräumt.

**Ist der Connector älter als 0.4.0**, antwortet die Route weiterhin
**`501 teams_uninstall_unsupported`** (mit `min_connector_version: "0.4.0"`) — und die
UI zeigt den Button erst gar nicht aktiv an, weil `capabilities.uninstall` denselben
Befund meldet. Der Hinweistext nennt die Lösung: *„Das Entfernen der App aus einem Team
braucht den Microsoft-365-Connector 0.4.0 oder neuer … aktualisiere das Plugin, oder
lass die App von einem Teams-Admin manuell entfernen."* Die Middleware spiegelt den
Connector-Contract strukturell statt ihn zu importieren, deshalb ist das eine
Laufzeit-Feature-Detection (`typeof provisioner.uninstallFromTeam === 'function'`) und
kein Versionsvergleich.

Weitere Antworten der Route:

| Status | Code | Wann |
|---|---|---|
| `200` | — | entfernt (`outcome: "uninstalled"`) oder war nicht installiert (`"already-absent"`) |
| `404` | `team_install_not_found` | für dieses Team ist keine Installation verzeichnet (auch: Zeile noch nicht `installed`) |
| `409` | `teams_provisioning_running` | ein Provisioning-Lauf ist unterwegs und würde direkt wieder installieren |
| `409` | `teams_app_id_missing` | Zeile gilt als `installed`, trägt aber keine `teams_app_id` |
| `501` | `teams_uninstall_unsupported` | Connector < 0.4.0 |
| `503` | `teams_provisioner_unavailable` | M365-Connector gar nicht installiert/aktiv |

**`409 team_install_conflict`.** Ein Retarget wird **vor jedem Schreibvorgang**
abgelehnt — sowohl bei einer bereits `installed`-Zeile mit anderem Team als auch bei
einem laufenden Lauf auf ein anderes Team. Die UI zeigt: „Dieser Orchestrator ist
bereits einem anderen Team zugeordnet. Löse diese Zuordnung zuerst — pro Orchestrator
wird ein Team geführt." Ein POST auf **dasselbe** Team ist idempotent und antwortet
`200` mit `already_installed: true`.

### 5.2 Auto-Install beim Einladen (der Komfortweg)

Wird einer der konfigurierten Bots einem Team hinzugefügt (`membersAdded`), installiert
channel-teams die in `teams_agent_apps[]` gelisteten Agenten-Apps automatisch über
`teamsProvisioner@1` → `POST /teams/{id}/installedApps`.

Voraussetzungen:

1. `teams_agent_apps` ist konfiguriert.
2. `teamsProvisioner@1` ist auflösbar (M365-Connector installiert **und** aktiv). Fehlt
   er, wird Auto-Invite mit einer Log-Zeile deaktiviert — die Plugin-Aktivierung bleibt
   davon unberührt.
3. Admin-Consent für `AppCatalog.ReadWrite.All` und
   `TeamsAppInstallation.ReadWriteForTeam.All` liegt vor.
4. Die App ist im Org-Katalog auflösbar: entweder über die konfigurierte `teamsAppId`
   (dann entfällt der Lookup) oder über `getCatalogApp({teamsAppExternalId})` des
   Connectors ≥ 0.3.1.

Ein `409` („war schon installiert") gilt als Erfolg. Auflösungsvorrang: konfigurierte
`teamsAppId` → `getCatalogApp` → „nicht im Katalog".

### 5.3 Die Fallback-Card im Kanal

Schlägt ein Teil des Auto-Installs fehl, postet der Bot eine Adaptive Card mit der
Überschrift **„🤝 Agenten-Apps für dieses Team"** — eine Statuszeile pro konfigurierter
App:

| Zeile | Bedeutung |
|---|---|
| `✅ <Name> — installiert` | frisch installiert |
| `✅ <Name> — war bereits installiert` | idempotenter Erfolg (409) |
| `⚠️ <Name> — Admin-Zustimmung fehlt` | Graph 403 (`consent-missing` bzw. `consent-cached`) |
| `⚠️ <Name> — nicht im Teams-App-Katalog gefunden` | `not-in-catalog` |

Dazu je nach Lage:

- **Consent-Block**: welche Graph-Berechtigungen ein Admin noch zustimmen muss, plus
  den Hinweis, dass die Apps bis dahin manuell über die Links unten hinzugefügt werden
  können.
- **Katalog-Hinweis**: „ℹ️ Nicht gefundene Apps zuerst in den Teams-App-Katalog der
  Organisation hochladen — danach hier „Prüfen" klicken."
- **Install-Deep-Links** (`Action.OpenUrl`) für jede nicht installierte App mit
  bekannter Katalog-ID: `https://teams.microsoft.com/l/app/<teamsAppId>` —
  ausschließlich öffentliche App-IDs.
- **„🔄 Prüfen"** (`Action.Submit`, Value-Typ `agent_apps_recheck`) — solange nicht alle
  Apps installiert sind. Der Klick lässt den Installer erneut laufen und
  **aktualisiert die Card an Ort und Stelle**. `teamId`/`tenantId` werden im
  Submit-Value mitgeführt, der Handler bevorzugt aber die transportseitigen Werte aus
  `channelData` (Card-Daten sind clientseitig editierbar).

Schutzmechanismen, die man kennen sollte:

- **Negativ-Cache pro Tenant** bei `consent-missing` — ein Tenant ohne Consent wird
  nicht bei jedem `membersAdded` erneut gegen Graph gefahren. Deshalb kann eine Zeile
  auch mit dem Grund `consent-cached` erscheinen, ohne dass ein Graph-Call stattfand.
- **429 kurzschließt den Lauf** — ein Throttle ist tenant-weit, also bricht er den Rest
  des Durchlaufs ab, statt jede App einzeln gegen die Wand zu fahren.
- **Intro-Throttle** — frisch installierte Bots erhalten alle ein `membersAdded`. Ein
  Marker unterdrückt für ein kurzes TTL die Begrüßungsnachricht aller Bots außer dem,
  der den Installer ausgeführt hat. Der Marker ist prozesslokal: bei mehreren
  Middleware-Instanzen kann in seltenen Fällen ein doppeltes Intro durchkommen.

---

## 6. Rechte pro Agent (Plugins / MCP)

Jede Teams-Identität gehört zu genau einem omadia-Agenten — und dessen Fähigkeiten
werden pro Agent gesetzt. Die Oberfläche dafür ist dieselbe Agent-Detailseite
(`/operator/agents/<slug>`) mit den Bereichen Agent-Detail, Tool-Grants und
MCP-Server.

Die zugehörigen Endpunkte:

| Methode + Pfad | Zweck |
|---|---|
| `GET /api/v1/operator/agents/:slug/plugins` | Plugin-Zuweisung des Agenten lesen |
| `PUT /api/v1/operator/agents/:slug/plugins` | Plugin-Set ersetzen — Body `{"plugins":[{"id":"@omadia/odoo","config":{…},"enabled":true}]}` |
| `PATCH /api/v1/operator/agents/:slug/plugins` | **ein** Plugin an-/abschalten — Body `{"id":"@omadia/odoo","enabled":false}` (die ID steht im Body, weil Plugin-IDs `/` enthalten) |
| `GET /api/v1/operator/agents/:slug/grants` | Tool-Grants des Agenten + MCP-Grants seiner Plugins + `grant_epoch` |
| `GET \| PUT /api/v1/operator/mcp-grants`, `DELETE /api/v1/operator/mcp-grants/:grantId` | MCP-Grants schreiben. Der Ziel-Agent steht bei `PUT` im **Body** (`agentSlug`, `mcpServerId`, optional `toolNames[]`, optional `delegation: 'service' \| 'per_user'`) |
| `GET \| PUT \| DELETE /api/v1/operator/plugin-mcp-grants` | MCP-Grants auf Plugin-Ebene |

Alle Routen hängen hinter `requireAuth`.

<!-- VERIFY: Die Aussage des Entwurfs "der Fallback-Agent läuft Plugins immer mit der
     globalen Store-Konfiguration; Per-Agent-Config-Overrides sind benannten Agenten
     vorbehalten" ließ sich auf main nicht belegen — weder in
     routes/operatorAgents.ts noch im Orchestrator-ConfigStore. Belegt ist nur, dass
     der Fallback-Agent gegen Löschen/Deaktivieren geschützt ist (409
     `fallback_protected`). Vor Veröffentlichung entweder belegen oder streichen. -->

---

## 7. Persönlichkeit und Verhalten: der Agent Builder

Wie ein Agent *klingt* und *sich verhält*, wird nicht in der Teams-Konfiguration
gestaltet, sondern im **nativen Agent Builder** von omadia. Die Teams-Identität liefert
Namen, Icon und Bot-Endpunkt; der Builder liefert Persona und Leitplanken. Es gibt
**keine externe Persona-Anbindung** — der Builder ist Teil des Produkts.

Von der Agent-Detailseite führt der Abschnitt „Persona und Verhalten" mit dem Button
**„Agent Builder öffnen"** direkt dorthin: auf `/store/builder/<draft-id>`, wenn sich
genau ein Builder-Entwurf eindeutig zuordnen lässt, sonst auf die Übersicht
`/store/builder`. Die UI sagt das auch: „Persona, Tonalität und Verhalten werden im
Agent Builder entworfen. Diese Seite weist dem Orchestrator nur Fähigkeiten zu."

Im Builder liegt die Persona im Tab **Persona** (neben Übersicht, Spec, Slots, Skills,
Versionen). Die PersonaPillar („Charakter prägen") bietet:

- **12 Achsen**, jede einzeln optional, Skala 0–100 mit Neutralwert 50 — 8 Kern-Achsen
  (`formality`, `directness`, `warmth`, `humor`, `sarcasm`, `conciseness`,
  `proactivity`, `autonomy`) und 4 erweiterte (`risk_tolerance`, `creativity`, `drama`,
  `philosophy`). Ein Radar-Diagramm zeigt das Profil; ein Klick auf eine Achsen-
  beschriftung springt zum passenden Slider.
- **Persona-Templates** — sechs Archetypen (Customer Service, Sales Dev, Content
  Marketing, Research Analyst, Software Engineer, Team Lead), die das komplette
  12-Achsen-Profil setzen.
- **Culture-Presets** — sechs Branchen-Overlays (SaaS-Startup, Enterprise-Corporate,
  Healthcare, Legal, E-Commerce, Creative Agency), die nur die Achsen verschieben.
- **Boundary-Presets** — zwölf Vorgaben in vier Kategorien (Daten, Scope, Autorität,
  Kommunikation), z. B. „keine PII", „nur eigene Domäne", „keine Zusagen", plus ein
  Freitextfeld für eigene „You must NOT"-Regeln.
- **Konflikt-Erkennung** rund um Sycophancy: eine hohe Sycophancy-Einstellung zusammen
  mit sehr niedriger oder sehr hoher `directness` wird als Warnung an der betroffenen
  Achse markiert, bevor daraus ein widersprüchlicher System-Prompt wird.
- **Prompt-Preview** direkt unter der Pillar: die kompilierten Prompt-Abschnitte
  (`header`, `persona`, `custom_notes`, `boundaries`, `sycophancy`, `skill`) samt
  Token-Zahl und Health-Band, mit Kopieren-Button.

Die Snapshot-Ebene (`middleware/src/profileSnapshots/`) hält **unveränderliche**
Profil-Snapshots — keine Änderung an `bundle_hash`, Manifest oder Asset-Bytes, nur das
Flag `is_deploy_ready` und die Audit-Felder mutieren. Ein täglicher Drift-Sweep
vergleicht den deploy-fähigen Snapshot gegen den Live-Stand und schreibt einen
Drift-/Health-Score plus die abgewichenen Assets; Profile ohne deploy-fähige Basis
werden übersprungen. Der Score ist ausdrücklich heuristisch, keine Freigabe-Instanz.

Praktisch heißt das: einen Agenten erst im Builder fertig gestalten und einen
deploy-fähigen Snapshot erzeugen, dann die Teams-Identität provisionieren. Beides ist
unabhängig — eine Persona-Änderung erfordert keine Neu-Provisionierung des Bots, und
umgekehrt.

---

## 8. Kontext-Memory mit ACL (Wave W5)

### Das Problem

Agent-Memory war bisher pro **Agent** isoliert, nicht pro **Chat-Kontext**. Was ein
Agent in Teams-Team A lernte, landete im agent-globalen Baum und war im nächsten Turn
in Team B zitierbar. Bei mehreren benannten Agenten in mehreren Teams ist das kein
Komfort-Problem mehr, sondern eine Vertraulichkeitsfrage.

W5 partitioniert diesen Baum nach Chat-Kontext.

### Der Rollout-Schalter ist standardmäßig AUS

**Das Wichtigste zuerst:** die Spalte `agents.context_memory` (Core-Migration `0050`)
hat drei Werte und den **Default `off`**:

| Wert | Verhalten |
|---|---|
| `off` | **Default.** Byte-identisch zu vorher: jeder Turn bekommt den agent-privaten Memory-Stack, unabhängig davon, ob sein Channel-Plugin einen `TurnOrigin` mitschickt. |
| `enforce` | Ein Kontext-Turn schreibt in sein eigenes Tier und liest das Agent-Tier **read-only** — bestehendes Wissen bleibt zitierbar, aber „merk dir das global" ist kein Leak-Kanal von Team A nach Team B mehr. |
| `enforce-strict` | Volle Quarantäne: ein Kontext-Turn kann das Agent-Tier nicht einmal lesen. |

Unbekannte oder `NULL`-Werte lesen sich als `off` (Deny-Default), damit ein Rollback
das Memory-Routing nicht verändert. Es gibt **keinen Flag-Day**: jede Kombination aus
alter/neuer Middleware und altem/neuem Channel-Plugin verhält sich wie vorher, bis ein
Operator einen Agenten bewusst umschaltet.

### Wo man den Schalter umlegt

Auf der Agent-Detailseite `/operator/agents/<slug>`, Abschnitt **Chat-Kontext-Memory**,
neben den anderen Einstellungen des Agenten. Die drei Modi stehen dort als Auswahl;
beim Wechsel **weg von „Aus"** blendet die Seite die drei Semantiken aus dem nächsten
Abschnitt ein und verlangt eine ausdrückliche Bestätigung, bevor Speichern aktiv wird.
Zurück auf „Aus" ist bewusst nicht bestätigungspflichtig — die sichere Richtung darf
nie schwerer sein als die unsichere.

Dahinter liegen zwei operator-authentifizierte Routen (#899):

```
GET /api/v1/operator/agents/<slug>/context-memory   → { slug, mode, modes }
PUT /api/v1/operator/agents/<slug>/context-memory     { mode: 'off' | 'enforce' | 'enforce-strict' }
```

`PUT` validiert gegen dieselbe Werteliste wie der CHECK-Constraint der Migration `0050`
— ein unbekannter Modus wird mit `400 invalid_body` **abgelehnt und nicht** still auf
`off` gemappt — und löst danach einen `registry.reload()` aus. Der nächste Turn läuft
also bereits im neuen Scope; ein Neustart ist nicht nötig. Der Moduswechsel wird mit
dem `[security-audit]`-Präfix geloggt.

Der Modus liegt **nicht** auf `PATCH /operator/agents/<slug>` (dem Umbenennen-/
Aktivieren-Formular). Eine Änderung am Memory-Scope soll nicht als Beifang einer
unabhängigen Bearbeitung mitreisen.

### Was Operatoren vor dem Aktivieren wissen müssen

Der effektive Scope entsteht aus statischer Agent-Konfiguration ∩ dynamischem Turn:

```
scope = axes.isContextFree
  ? ['core',    `orchestrator:<slug>:*`]                       // = heutiges Verhalten
  : ['ro:core', `ro:orchestrator:<slug>:*`, …axes.patterns]    // enforce
  : ['ro:core',                             …axes.patterns]    // enforce-strict
```

Vier Konsequenzen, die man vorher gelesen haben sollte:

1. **Team-Tier ist read-write, Agent-Tier ist read-only.** Unter `enforce` schreibt ein
   Kontext-Turn in sein engstes Tier (Kanal bzw. User) und ins Team-Tier; das
   Agent-Tier ist nur lesbar. Wäre es schreibbar, wäre „notiere das global" ein
   permanenter Leak-Kanal von Team A nach Team B.
2. **Auch die geteilten Bäume werden read-only** (`ro:core` statt `core`). `core`,
   `sessions`, `chat-sessions` und Top-Level-`_*` sind die eine modellseitige Fläche,
   die zwei Kontexte unter demselben Pfad ansprechen. Schreibbar wäre
   `/memories/core/notes.md` ein Einzeiler-Bypass der ganzen ACL.
3. **API-/HTTP-Turns ohne Origin bekommen nur den Agent-Privat-Scope.** HTTP-Turns
   emittieren bewusst **keinen** `TurnOrigin`: ihre Scope-Strings sind vom Caller
   gelieferte Transkript-Labels — daraus eine Memory-Partition abzuleiten hieße, jedem
   API-Client das Tier eines anderen benennbar zu machen. Solche Turns landen deshalb
   in **jedem** Modus context-free, also im agent-privaten Baum, und erreichen keinen
   Kontextbaum.
4. **Fail-closed, nie ein Throw auf dem Message-Pfad.** Fehlender `origin`, `unscoped`,
   `system`, unbekannter `channelType` oder unbrauchbare Patterns führen zurück auf den
   agent-privaten Scope und werden laut geloggt (`[security-audit]`). Ein Plugin-Bug
   weitet nie still den Scope — er verengt ihn.

Ein weiterer impliziter Schalter: der `channelType` muss in der Allowlist
`{teams, telegram, http, api}` stehen, und das Channel-Plugin muss den `TurnOrigin`
tatsächlich mitschicken. Die Spalte allein bewirkt nichts für einen Channel, der keinen
Origin sendet.

### Scope-Grammatik und der Baum

`/memories/contexts/` ist ein **neues Top-Level-Segment**, kein Unterbaum von
`/memories/orchestrators/`. Das ist das Kollisionsfreiheits-Argument:
`orchestrator:<slug>:*` matcht ausschließlich den Agent-Baum, also erreicht kein
Alt-Scope einen Kontextbaum und kein Kontext-Scope den Agent-Baum.

| Scope-Token | matcht |
|---|---|
| `team:<ctxKey>:*` | `/memories/contexts/<slug>/team/<ctxKey>/…` |
| `channel:<ctxKey>:*` | `/memories/contexts/<slug>/channel/<ctxKey>/…` |
| `user:<ctxKey>:*` | `/memories/contexts/<slug>/user/<ctxKey>/…` |
| `ro:<pattern>` | Access-Modifier vor einem **ganzen** Pattern: read/list/exists ja, write/delete/rename → `MemoryScopeViolation` |

Das nachgestellte `:*` gehört zur Grammatik. `ro:` ist ein **Veto, kein schwaches
Grant**: matcht ein `ro:`-Pattern den Pfad, wird der Write abgelehnt, auch wenn ein
zweites Pattern ihn gewähren würde. In der ausgelieferten Konfiguration steht `ro:` nur
vor `core` und `orchestrator:` — nie vor einem Kontext-Tier.

`/memories/core/audit/` ist für **jeden** Agenten unbeschreibbar (Deny-Prefix vor jeder
positiven Prüfung). Dort liegt das Promote-Audit-Log.

Modellseitig sieht der Agent im Kontext-Modus:

```
/memories/…         → engstes Tier des Turns (Kanal bzw. User)
/memories/~team/…   → Team-Tier (rw, nur wenn eine Team-Achse existiert)
/memories/~agent/…  → Agent-Baum (ro)
```

Der `<ctxKey>` kommt ausschließlich aus `memoryContextKey(channelType, nativeId)` —
Form `<channelType>~<safeKey(nativeId)>`, z. B.
`teams~19-abc-thread-tacv2-a1b2c3d4e5f60718`. Der Sanitizer ist injektiv: ein
verlustfreier Id geht byte-identisch durch, alles andere bekommt Stem plus
16-Hex-sha256-Digest des **rohen** Strings. Plain-Sanitizing wäre es nicht — eine
Teams-Conversation-Id `19:abc@thread.tacv2` kollidierte sonst mit dem Literal
`19-abc-thread-tacv2`, und aus einem Recall-Ärgernis würde ein Cross-Team-Leak.

### Wissen bewusst teilen: Promote

Der einzige Weg, auf dem Wissen eine Kontextgrenze überschreitet, ist eine explizite,
auditierte Operator-Aktion:

```
POST /api/v1/admin/memory/promotions/<agent-slug>
GET  /api/v1/admin/memory/promotions/<agent-slug>?limit=<1..1000>
```

Body:

```json
{
  "source": { "axis": "channel", "ctxKey": "teams~…", "path": "/notes/preise.md" },
  "target": { "tier": "team", "ctxKey": "teams~…", "path": "/notes/preise.md" },
  "mode": "copy",
  "reason": "Preisliste gilt teamweit",
  "overwrite": false
}
```

- `axis`: `team | channel | user`; `tier`: `agent | team`. `target.ctxKey` ist bei
  `tier: "team"` Pflicht und bei `tier: "agent"` unzulässig; `target.path` defaultet
  auf `source.path`.
- `agentSlug` kommt aus dem Pfad, der Actor aus der Session — **beides wird nicht vom
  Client angenommen**. Promote ist strukturell immer *innerhalb eines* Agenten; beide
  Tier-Wurzeln werden aus demselben `agentSlug` gebaut.
- Audit dreifach: JSONL-Zeile in `/memories/core/audit/memory-promotions.jsonl`,
  Provenance-Frontmatter (`promoted-from` / `-by` / `-at`) in jeder promoteten
  Markdown-Datei, und eine strukturierte `[security-audit]`-Logzeile.

Fehlerbilder: `404 source_not_found`; `409 target_exists` / `target_is_directory`;
`400` für die Validierungsfälle (`invalid_axis`, `invalid_tier`, `invalid_ctx_key`,
`invalid_path`, `source_escapes_agent`, `target_escapes_agent`,
`target_overlaps_source`, `source_empty`, …); `200` mit `warning`, wenn die Promotion
lief, aber die Audit-Zeile nicht geschrieben werden konnte.

> **Promote ist nicht atomar.** Garantiert ist nur: *jede* Validierungs-Ablehnung fällt,
> bevor das erste Byte landet — diese Codes bedeuten „beide Tiers unberührt". Nicht
> garantiert ist der Rest: der Dienst schreibt die geplanten Dateien in einer
> ungeschützten Schleife und löscht bei `mode: "move"` die Quelldateien danach. Ein
> Store-Fehler auf halber Strecke (Quota, transienter Postgres-Fehler, `EACCES`)
> hinterlässt eine **halb angewendete** Promotion. Solche Antworten tragen deshalb
> `partial: true` — dann vor dem Retry das Ziel-Tier ansehen, sonst läuft man in ein
> `409 target_exists` auf den Dateien, die schon gelandet sind.

### Kontext-Bäume ansehen

Der Memory-Browser im web-ui zeigt die Kontext-Bäume; er liest über die
operator-authentifizierte Read-only-API

```
GET /api/v1/operator/memory/contexts/list?path=<absoluter Pfad unter /memories/contexts>
GET /api/v1/operator/memory/contexts/file?path=<Datei unter /memories/contexts>
```

die strukturell nicht außerhalb von `/memories/contexts` lesen kann. Das Agent-Tier ist
bewusst **kein** Knoten in diesem Baum.

Zum Löschen: `POST /api/v1/admin/memory/purge` kennt zusätzlich
`axis: 'team' | 'channel' | 'user'`. Der Selector ist **immer** `<channelType>~<id>` —
ohne `~` antwortet die Route `400 invalid_selector`, denn eine Danger-Zone-Geste, die
nichts löscht und Erfolg meldet, ist schlimmer als ein Fehler.

Tiefe Details zur Scope-Auflösung, zur Turn-Bindung und zu den Tests stehen in
[`middleware-agent-handoff.md`](middleware-agent-handoff.md), Abschnitt
„Chat-Kontext-Memory-ACL".

---

## 9. Troubleshooting

| Symptom | Ursache | Fix |
|---|---|---|
| Store-Update auf `@omadia/channel-teams` 0.21.0 scheitert mit `entry appPackage/manifest.json.template has a disallowed extension (.template)` | Das Plugin-Paket bringt `appPackage/manifest.json.template` mit; das Ingest-Gate älterer Middleware-Versionen kennt die Endung `.template` nicht (Deny-by-default-Allowlist) | **Middleware auf ≥ v0.136.2 bringen.** Dort ist `.template` erlaubt — bewusst nur unterhalb von `appPackage/`. Umbenennen ist keine Alternative: der Consumer liest den Dateinamen fest, ein umbenanntes Plugin würde die Agent-Factory blind machen |
| `POST …/teams-identity` → `503 teams_provisioner_unavailable` | `teamsProvisioner@1` wird nicht veröffentlicht — M365-Connector fehlt, ist inaktiv oder < 0.3.1 | Connector ≥ 0.3.1 installieren **und** aktivieren; danach `GET …/teams-identity` → `provisioner_installed: true` prüfen |
| Beide Endpunkte → `503 teams_identity_unavailable` | Identity-Store + Job-Runner sind nicht verdrahtet | `DATABASE_URL` setzen, Migration `0049` einspielen, Middleware neu starten |
| `state: failed`, `last_error` beginnt mit `consent_missing:` | Admin-Consent fehlt für die genannten Scopes | Scopes vergeben + Admin-Consent. **Greift Portal/CLI still nicht** (Kommando meldet Erfolg, Graph antwortet weiter 403): App-Rollen per REST `POST /servicePrincipals/{app-sp-object-id}/appRoleAssignments` vergeben, ein Call pro Permission. **Danach Middleware neu starten**, dann POST erneut |
| `403` bleibt trotz erteiltem Consent bestehen | Tokens sind gecacht; neu zugestimmte Rollen erscheinen erst in einem frischen Token | Middleware neu starten (oder Token-Ablauf abwarten) |
| Lauf bleibt bei `app_registered`, `last_error` beginnt mit `arm_not_configured:` | ARM-Setup-Felder am Connector fehlen → Registration-only-Modus | `azure_subscription_id` / `azure_resource_group` / `azure_region` (+ ggf. SP-Credentials) setzen und erneut POSTen — **oder** den Azure-Bot manuell anlegen. Die App-Registrierung bleibt in jedem Fall erhalten |
| Bot antwortet nicht; Log zeigt einen unbekannten Bot bzw. HTTP 404 auf `/api/teams/<slug>/messages` | Der Messaging-Endpoint im Azure-Bot zeigt auf einen `botSlug`, den `teams_bots[]` nicht kennt (Tippfehler, Slug umbenannt, Eintrag nie eingepflegt) | Slug in Azure-Bot-Konfiguration und `teams_bots[]` angleichen. Es gibt bewusst **keinen** Fallback auf fremde Credentials |
| Bot antwortet nicht, obwohl der Slug stimmt | `teams_bots[]` wurde nie befüllt — die Provisionierung synct die Identität nicht in die Plugin-Config | `teams_bot`-Block aus der UI kopieren (oder aus `GET …/teams-identity`) und in `teams_bots` einfügen, Plugin-Config speichern |
| `409 bot_slug_taken` beim POST | Der Slug gehört bereits einer **anderen** Agent-Identität (`UNIQUE (bot_slug)`) | Anderen `bot_slug` wählen — zwei Agenten dürfen sich niemals eine Bot-Identität und deren Credential-Namensraum teilen |
| `409 team_install_conflict` beim POST | Retarget auf ein anderes Team, während die Zeile schon `installed` ist oder ein Lauf auf ein anderes Team fliegt | Auf den laufenden Lauf warten. Bei bereits installierter App: die alte Installation manuell in Teams entfernen — omadia führt genau ein Team pro Agent |
| „Deinstallieren" ist ausgegraut / `501 teams_uninstall_unsupported` | der installierte M365-Connector ist älter als **0.4.0** und veröffentlicht kein `uninstallFromTeam` | `@omadia/integration-microsoft365` auf ≥ 0.4.0 aktualisieren (Middleware-Neustart nicht nötig — die Capability wird pro Request aufgelöst). Bis dahin: App im Teams-Admin manuell entfernen |
| Card meldet „nicht im Teams-App-Katalog gefunden" | Weder `teamsAppId` konfiguriert noch über `getCatalogApp` auflösbar (App nicht publiziert, oder Connector 0.3.0 ohne Lookup) | App in den Org-Katalog hochladen oder `teamsAppId` in `teams_agent_apps[]` eintragen; danach „🔄 Prüfen" klicken |
| Nachrichten landen beim falschen Bot / Conversation-Refs kollidieren | Deployment ohne KG-Migration `0031` (`teams_conversation_refs.bot_app_id`) | `0031` einspielen (passiert beim nächsten Boot automatisch). Bis dahin ist Multi-Bot-Betrieb nicht sauber isoliert |
| `last_error` endet auf `(gave up after N attempts)`, State ist **nicht** `failed` | 429-Drosselung oder Connector zeitweise weg; Retry-Budget (5 Versuche) erschöpft | Später erneut POSTen. Der erreichte Fortschritt bleibt erhalten und wird nicht wiederholt |
| Provisioning hängt, `running: false`, `last_error` beginnt mit `enqueue_failed:` | Das Einreihen selbst schlug fehl — es läuft nichts | Log `[operator-agents] teams provisioning enqueue for '<slug>' failed:` bzw. `… was refused:` prüfen, Ursache beheben, POST erneut |
| `teams_app_package_assets_unavailable` | Das App-Paket-Template ist nicht ladbar | `@omadia/channel-teams` installiert und aktuell? Das Paket muss `appPackage/{manifest.json.template,color.png,outline.png}` mitbringen |
| Memory-ACL aktiviert, aber nichts ändert sich | Der Channel schickt keinen `TurnOrigin`, oder sein `channelType` steht nicht in der Allowlist `{teams, telegram, http, api}` | Channel-Plugin-Version prüfen. Ohne `TurnOrigin` bleibt jeder Turn context-free — genau so ist es gedacht (fail-closed) |

---

## 10. Grenzen und Ausblick

### Was heute nicht geht

- **Kein Namenswechsel pro Nachricht.** Identität = App-Paket. Wer N sichtbare Agenten
  will, braucht N Teams-Apps und N Bots.
- **Kein automatischer Sync in die Plugin-Config.** Die Provisionierung schreibt die
  Identität in den Kernel, nicht in `teams_bots[]` von channel-teams. Der Eintrag muss
  manuell übernommen werden; die UI sagt das ausdrücklich.
- **Ein Team pro Identität.** `agent_teams_identities` speichert genau ein `team_id`
  (Migration `0049`). Multi-Team ist deshalb **strukturell noch nicht möglich** — dafür
  braucht es eine Schema-Änderung (eigene Tabelle für das Installations-Set). Ein
  Retarget wird konsequent mit `409` abgelehnt, statt ein Read-Model zu erzeugen, das
  eine Installation behauptet, die nie stattgefunden hat. Seit Connector 0.4.0 ist der
  Wechsel aber kein Sackgasse mehr: erst deinstallieren (5.1), dann in das neue Team
  installieren.
- **Eine Identität pro Agent, ein Agent pro Bot-Slug.** Beides ist als
  Datenbank-Constraint festgeschrieben (`PRIMARY KEY (agent_id)`, `UNIQUE (bot_slug)`)
  und scheitert laut statt still.
- **Keine Live-Enumeration von Installationen.** Der Connector kann sie nicht
  auflisten; die Team-Liste ist aus der Identity-Zeile abgeleitet
  (`evidence: 'identity_row'`) und sagt das auch.
- **SingleTenant-Invariante.** Der Provisioner legt ausschließlich SingleTenant-Apps
  an. MultiTenant ist im Typmodell nicht ausdrückbar; bestehende
  MultiTenant-Registrierungen laufen als Legacy-Einträge weiter.
- **Kein Client-Secret über die API.** Das Bot-Passwort verlässt nie den Vault des
  Connectors. Antworten und Datenbank führen nur die Referenz
  `teams_bot_password:<appId>`.
- **Prozesslokaler State beim Auto-Invite.** Consent-Negativ-Cache und Intro-Marker
  liegen im Speicher. Bei mehreren Middleware-Instanzen kann eine zweite Instanz einen
  consent-losen Tenant erneut versuchen oder ein doppeltes Intro posten. Die TTLs
  begrenzen den Radius; ein globaler Lock ist das ausdrücklich nicht.
- **`promoteMemory` ist nicht atomar.** Validierungsfehler lassen beide Tiers
  unberührt; ein Store-Fehler mitten im Schreiben nicht. Solche Antworten tragen
  `partial: true` (siehe Abschnitt 8).
- **Der Schalter wirkt nur auf dem Orchestrator-Pfad.** Läuft ein Agent über den
  `claude-cli`-Provider, beantwortet ein `CliChatAgent` den Turn, nicht der
  `Orchestrator` — die Bindung wird dort nie gebildet, und der Modus bleibt folgenlos.
  Ebenso greift die ACL nicht für ein **Sub-Agent**, dem das native `memory`-Tool
  direkt zugeteilt wurde: dessen Handler zeigt auf den undekorierten Store. Beides ist
  älter als diese Wave und in #899 dokumentiert (siehe dort den Befund im PR).

### Was in Arbeit ist

- **Automatische Übernahme der Identität in `teams_bots[]`** — von der UI als
  Folgeschritt angekündigt („passiert heute nicht").
- **`TurnOrigin`-Producer in den Channel-Plugins.** Die Middleware-Seite der
  Memory-ACL ist gemergt; `omadia-channel-teams` und `omadia-channel-telegram` bauen
  ihren `TurnOrigin` in ihren **eigenen** Repos und können erst nach dem Release des
  Channel-SDK mit `TurnOrigin` gebaut werden. Bis dahin bleibt jeder Turn context-free
  — die ACL ist also aktivierbar, aber ohne Producer folgenlos.
- **Operator-Route für Kontext-Labels.** Der Memory-Browser fällt auf den dekodierten
  Kontext-Key zurück, solange kein Label-Resolver deployed ist.
- **Deinstallation ist erledigt** (#900): `teamsProvisioner@1` veröffentlicht seit
  M365-Connector **0.4.0** `uninstallFromTeam`, die Route und der UI-Button sind
  aktiv. Offen bleibt die **Live-Enumeration** von Installationen — dafür fehlt dem
  Connector-Vertrag weiterhin eine Auflistungs-Methode.

---

## Referenzen

| Was | Wo |
|---|---|
| Operator-Endpunkte (Identity + Team-Zuordnung) | `middleware/src/routes/operatorAgents.ts` |
| State-Maschine + Store | `middleware/src/platform/agentTeamsIdentityStore.ts` |
| Job-Runner + Fehlerpolitik | `middleware/src/services/teamsProvisioningJob.ts` |
| Capability-Choke-Point + Endpoint-Builder | `middleware/src/platform/teamsProvisionerService.ts` |
| App-Paket-Assets | `middleware/src/services/teamsAppPackageAssets.ts` |
| Tabelle Teams-Identitäten | `middleware/migrations/0049_agent_teams_identities.sql` |
| Rollout-Flag Memory-ACL | `middleware/migrations/0050_agent_context_memory_flag.sql` |
| Schalter (API) | `middleware/src/routes/operatorAgents.ts` → `GET`/`PUT /:slug/context-memory` |
| Schalter (UI) | `web-ui/app/operator/agents/[slug]/_components/AgentContextMemory.tsx` |
| Turn-Bindung, echter Turn | `middleware/test/orchestrator/contextMemoryTurnBinding.test.ts` |
| Conversation-Refs pro Bot | `middleware/packages/harness-knowledge-graph-neon/src/migrations/0031_teams_conversation_refs.sql` |
| Memory-ACL im Detail | [`middleware-agent-handoff.md`](middleware-agent-handoff.md) → „Chat-Kontext-Memory-ACL" |
| Operator-UI Teams-Identität | `web-ui/app/operator/agents/[slug]/_components/AgentTeamsIdentity.tsx`, `AgentTeamsInstalls.tsx` |
| Agent Builder (Persona) | `web-ui/app/store/builder/[id]/`, `middleware/src/plugins/builder/`, `middleware/src/profileSnapshots/` |
| Capability-Contract `teamsProvisioner@1` | `omadia-m365-connector/docs/teams-provisioner.md` |
| Setup-Felder Teams-Channel | `omadia-channel-teams/manifest.yaml` |
| App-Paket-Template | `omadia-channel-teams/appPackage/` |

> Die drei zuletzt genannten Repos sind eigenständig (`byte5ai/omadia-m365-connector`,
> `byte5ai/omadia-channel-teams`). Vor dem Arbeiten dort `git pull` — lokale Checkouts
> liegen erfahrungsgemäß hinter `origin/main`.

---

## Offene VERIFY-Punkte

- Abschnitt 6: die Aussage „der Fallback-Agent läuft Plugins immer mit der globalen
  Store-Konfiguration" ließ sich auf `main` nicht belegen und ist deshalb nicht
  behauptet, sondern als Kommentar markiert.
