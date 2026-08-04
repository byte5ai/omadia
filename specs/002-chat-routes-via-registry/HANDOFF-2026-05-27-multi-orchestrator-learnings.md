# HANDOFF — Multi-Orchestrator Runtime · Learnings & Carry-Forward

**Date**: 2026-05-27
**Scope**: Post-Phase-B retrospective after #146, #148 (omadia) and
`omadia-byte5-plugins#3` shipped.
**Audience**: Next session picking up the platform's per-Agent routing
work — what we built, what surprised us, what we'd build differently.

---

## What shipped (live on Fly today)

| PR | Repo | Content |
|---|---|---|
| #146 | byte5ai/omadia | Multi-orchestrator runtime US1–US9 + Phase A chat routing + Phase B operator UX |
| #148 | byte5ai/omadia | A+B channel-directory capability + `/operator/channels` dashboard |
| #3 | byte5ai/omadia-byte5-plugins | `@omadia/channel-teams` 0.9.0 — per-conversation routing, mention-only, directory contribution |

Live on `https://odoo-bot-middleware.fly.dev` + `https://odoo-bot-harness.fly.dev`.

---

## Top 10 Learnings

### L1 · Per-Agent orchestrators built before kernel DomainTools exist → empty tool surface

The biggest single bug found post-Phase-B. The orchestrator plugin's
`activate()` runs as part of `toolPluginRuntime.activateAllInstalled()`,
which is **earlier** in boot than where the kernel assembles its
`DomainTool[]` set (sub-agent query tools like `query_odoo_accounting`,
`query_confluence`). Every per-Agent `Orchestrator` built by the
multi-orchestrator registry started with `domainTools: []`. Result: chat
against the fallback Agent could not reach **any** sub-agent — the
fallback was effectively brain-dead.

**Fix landed**: post-`dynamicAgentRuntime.activateAllInstalled()` the
kernel now walks `registry.list()` and `registerDomainTool` on each
per-Agent orchestrator. `OrchestratorRegistry.setOnAgentBuilt(...)`
re-runs the hydration on every future `add` / `rebuild` action.

**Lesson for next time**: a runtime-level component built per Agent
needs **either** all deps resolved at construct-time (impossible here
because of capability ordering), **or** a post-build hook for the
kernel to inject deferred deps. We chose the hook. Future per-Agent
deps (e.g. per-Agent tool permissions in the in-flight refactor)
should plug into the same `onAgentBuilt` callback rather than adding
a second one.

### L2 · `agent_plugins.config` is persisted but not yet runtime-applied

The Phase B dnd editor + per-plugin `setup_fields` drawer happily writes
per-Agent config to the `agent_plugins.config` JSONB column. The
operator sees the form, the DB row updates, the operator-channels page
shows the binding. **But `toolPluginRuntime.activateAllInstalled()`
still activates each plugin ONCE with the GLOBAL store-config** from
`installedRegistry`. Per-Agent runtime config is queued but not
delivered.

We explicitly enforced the **fallback Agent contract** (fallback's
config is force-emptied on save, the UI hides the drawer) so the
behaviour is consistent: today every Agent uses the store-config. The
moment per-(Agent × plugin) `PluginContext` lands, the fallback contract
stays (operator opted into "fallback = store-default by design") and
named Agents start honouring their saved configs.

**Lesson**: don't let the UI imply behaviour the runtime doesn't yet
implement. We surfaced the disconnect via the fallback-card notice and
documented it as carry-forward.

### L3 · Microsoft Teams' `conversation.id` semantics are non-obvious

| Operator's mental model | Teams reality |
|---|---|
| "I open another Teams tab" | Same conv-id (UI tabs do not segment conversations) |
| "I add the bot to another channel" | Same conv-id if all messages are replies to the same root post |
| "@-mention the bot in a different chat" | New conv-id only if the chat is a different group constellation OR a different Team-channel-root |
| "Two group chats with different people" | Two different conv-ids, both `19:<id>@thread.skype` |
| "Personal chat with bot" | One `a:<aad>` conv-id, stable |

We hit this hard during testing. The operator @-mentioned the bot from
what they believed was a different chat three times — same conv-id
each time. The fix wasn't code, it was understanding the platform.

**Documented in the operator-channels dashboard tooltip**: each entry
labels its `conversationType` (`channel` / `personal` / `groupChat`)
so the operator can correlate.

### L4 · Node ESM module cache breaks plugin hot-reload of sub-imports

The `DynamicChannelPluginResolver` busts plugin.js's import URL with
`?v=<token>` on `invalidate()`, so `plugin.js` reloads cleanly. BUT
plugin.js's `import { TeamsBot } from './teamsBot.js'` resolves to the
**same** absolute file URL on every load, and Node's module cache
returns the **first** `teamsBot.js` it ever loaded — even if a newer
version sits on disk at the same path.

We saw this concretely: 0.9.0 was uploaded + activate-logs ran fresh,
but the bot's `handleMessage` was still 0.8.0's implementation (no
mention-filter, no `inbound-meta` diagnostic). Cache bust on the
entry-point doesn't propagate to relative imports.

**Workaround in production**: `fly machine restart` after each plugin
upload. Wipes the whole Node cache, fresh import on next activate.

**Proper fix (deferred)**: extract uploads to a version-suffixed
directory (`<id>/<version>/`) which the code *already does*, but
combine it with **also** keeping the in-memory `cache` and `bustTokens`
maps invalidated transitively (delete on uninstall + on re-upload
re-activate). The current invalidate() handles channel-resolver
correctly; the bug is elsewhere — likely in the way the runtime keeps
a *bot-instance reference* alive across activations even after
deactivate() was called. Worth a focused debugging session.

### L5 · `replaceAgentPlugins` re-upserts stale rows if the UI echoes them back

Operator clicks Save with N plugins selected → PUT body contains all N
plugin ids → the route deletes rows missing from body, upserts each
listed row. If the UI includes "orphan" rows (plugin ids in
`agent_plugins` that no longer exist in the installed-plugin catalog),
those keep getting re-upserted on every save. "STALE" entries pile up.

**Fix landed**: dnd editor drops orphans from the save payload by
default + per-orphan "Keep" checkbox + bulk "Remove all" button. The
backend stayed unchanged — fix is correct at the UI level because
"explicit operator choice to keep" is the only safe signal.

**Lesson**: list-replace semantics in REST are correct, but the UI must
not echo every row back blindly. Filter what's clearly stale.

### L6 · `agent.updated_at` doesn't bump on plugin/binding writes

Initial Phase B used `key={agent.updated_at}` on `PluginsDnd` and
`BindingsEditor` to remount after server writes. `agents` table's
`updated_at` only changes on `UPDATE agents`, NOT on writes to
`agent_plugins` or `channel_bindings`. So saving plugins looked like a
no-op — local state stayed stale, operator thought save broke.

**Fix landed**: payload-hash key (`pluginsRevisionKey`,
`bindingsRevisionKey`) that incorporates the actual content of the
related tables. Remount whenever the editable data changes regardless
of which DB table changed.

**Lesson**: trust the actual data being edited, not a meta-timestamp
on a parent row.

### L7 · `validateSnapshot` rejects the entire snapshot when one plugin is "not installed"

`isInstalled === false` for any plugin throws `ConfigValidationError`,
which aborts the whole `registry.reload()`. If B1's first-boot seed
attached every catalog plugin (including some not in
`installedRegistry`), the registry would never finish loading. Hard to
diagnose because the failure is mid-snapshot and previous registry
state remains.

**Fix landed**: B1's `attachAllPlugins` only attaches `installed.list()`
entries (not catalog entries). B3d "Reset fallback" filters
`status !== 'errored'` so inactive-but-installed plugins stay attached.

**Lesson**: snapshot validators should ideally be **per-row** with
isolation (skip the offending row, log it, continue) instead of
all-or-nothing. Worth a small refactor on a future PR.

### L8 · Auto-merge via GraphQL is rate-limit-fragile; REST merge is the workhorse

GraphQL got rate-limited 5000/hr several times during the day's PR
churn — `gh pr merge --auto --squash --delete-branch` failed because it
goes through GraphQL. REST `PUT /repos/{}/pulls/{n}/merge` always
worked. Tracking via REST check-runs API also worked when GraphQL was
empty.

**Operational lesson**: when shipping >1 PR per hour, use REST endpoints
directly:
```bash
gh api -X PUT repos/owner/repo/pulls/N/merge -F merge_method=squash
gh api -X DELETE repos/owner/repo/git/refs/heads/<branch>
```
Auto-merge is convenience, not a hard requirement.

### L9 · `usePathname` not `window.location.pathname + popstate`

The stream-toast component watched route changes via
`window.location.pathname` + `popstate`. Next.js App Router does NOT
fire `popstate` on client-side `router.push` / `<Link>` clicks. So
after Chat → Memory the toast component still thought it was on /
and the toast never appeared.

**Fix**: `usePathname()` from `next/navigation` re-renders on every
client-side route change.

**Lesson**: any client component watching the route MUST use the
framework's hook, not the browser API. Burned a deploy on this one.

### L10 · Header z-index needs an explicit stacking context

Nav-cluster dropdown menus rendered behind the `/store` hero. The
dropdown had `z-50`, but only within the header's stacking context —
and the header had no `position` or `z-index`, so a sibling with
`position:relative` further down the DOM painted on top.

**Fix**: `relative z-50` on `<header>` lifts the whole stacking context
above main content.

**Lesson**: dropdowns that escape their parent box need a managed
z-axis from the page root, not just from the immediate parent.

---

## What's deferred (carry-forward)

1. **Per-(Agent × plugin) `PluginContext`** — the actual unlock for L2.
   The runtime still activates plugins globally with store-config.
   Per-Agent isolation needs a new lifecycle where each Agent owns its
   own PluginContext instance with per-Agent config + per-Agent secrets
   scope. Big refactor; tracked separately.

2. **Plugin module-cache fix (L4)** — the workaround (machine restart)
   is operationally painful. Fix candidates:
   - Use `import()` with a fresh URL containing the version suffix in
     the file URL itself, not as query string — Node's cache then
     misses for sibling imports too.
   - Move each plugin to a Worker thread (heavy, isolates everything).
   - Implement a custom ESM loader that namespaces by plugin version.

3. **Conversation-observer persistence** — currently in-memory. After
   middleware restart `/operator/channels` shows only the bot-level
   catch-all until each conversation receives a new message. Two
   options: vault-JSON (cheap, lossy on multi-instance Teams), or
   Postgres table (durable, joinable with `channel_bindings`).

4. **Azure Bot Service display name** — Teams app sideload manifest
   was bumped to v1.3.0 with `name: omadia-agent`, BUT the @-mention
   chip name in Teams comes from the Azure-side bot's display name,
   which still reads `virtual-bitch`. Manual rename in Azure portal
   needed; no code change available.

5. **byte5 channel webhook handlers via `channelResolver@1`** — Teams
   is now wired (Plugin 0.9.0). Telegram (`@omadia/channel-telegram`)
   still consumes the legacy `chatAgent@1`. Symmetrical change in the
   Telegram plugin needed before Telegram conversations can be routed
   per-Agent.

6. **Snapshot validation per-row isolation** (L7) — convert
   `validateSnapshot`'s all-or-nothing throw into per-row skip+log so
   one bad plugin can't take down the whole registry boot.

7. **Operator-side agent-config-per-plugin runtime semantics** — once
   L2 lands, decide UX for "this Agent uses Odoo prod, that one uses
   Odoo staging". The dashboard already persists; behaviour wakes up
   when the runtime catches up.

8. **T043 structured-logging audit, T044 Notion docs sync, T045
   two-Agent boot smoke, T046 quickstart e2e** — original Phase 12
   tasks, untouched.

---

## Operational recipes (post-mortem-ready)

### Fresh deploy of an updated channel plugin

```bash
# 1. Build + ZIP
cd ~/sources/omadia-byte5-plugins/packages/channel-teams
npm run build
cd ../.. && node scripts/package-all.mjs channel-teams

# 2. Upload via Operator UI: /operator/agents → Plugins → Store →
#    channel-teams → Update with zips/channel-teams-X.Y.Z.zip

# 3. Force fresh module cache (REQUIRED — see L4)
fly machine restart <id> -a odoo-bot-middleware

# 4. Verify boot log
fly logs -a odoo-bot-middleware --no-tail | grep -E "channel-key directory|Teams per-turn"
```

### Diagnose "operator/channels shows nothing"

```bash
# 1. Is the directory registered?
fly logs -a odoo-bot-middleware --no-tail | grep "channelDirectoryRegistry: registered"

# 2. Is the bot receiving messages?
fly logs -a odoo-bot-middleware --no-tail | grep "inbound conv="

# 3. Live endpoint check (auth'd browser)
GET https://odoo-bot-harness.fly.dev/bot-api/v1/operator/channels
```

### Diagnose "different chat, same conv-id"

L3 is the most common cause — operator believes two chats are different
but Teams treats them as one conversation. Confirm with:

```bash
fly logs -a odoo-bot-middleware --no-tail \
  | grep "inbound conv=" | awk -F'conv=' '{print $2}' | awk '{print $1}' | sort -u
```

If the output has only one line across multiple operator-side tests,
the chats are the same conv from Teams' perspective. Solution: open a
genuinely different Teams chat (different team-channel, different
group-chat constellation) — not just a different tab/sidebar entry.

---

## One-liner to resume

```bash
cd ~/sources/odoo-bot-multi-orchestrator
git log --oneline -8
cat specs/002-chat-routes-via-registry/HANDOFF-2026-05-27-multi-orchestrator-learnings.md
# Pick from carry-forward 1–8 above; each entry has enough context to
# stand alone.
```

The platform is stable for one-bot operation with per-conversation
routing. The next operator-visible win is L2 (per-Agent configs
actually flowing into plugin activations) — that's also the unblock
for "Agent-X talks to Odoo prod, Agent-Y to Odoo staging" use cases.
