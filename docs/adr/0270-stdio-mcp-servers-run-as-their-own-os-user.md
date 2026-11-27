# 0270 — stdio MCP servers run as their own OS user, without the middleware's environment or data directory

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** Owner (byte5), decision 2026-11-27 (#2306), reversible; Welle 6 cluster W33
- **Supersedes:** [ADR-0211](0211-stdio-mcp-servers-share-the-middleware-trust-domain.md) in
  part (the trust model "a stdio server is inside the middleware's trust domain" and option B
  as an open follow-up). The Compose default (`MCP_STDIO_ENABLED=false`) of ADR-0211 stands.

## Context and Problem Statement

A stdio MCP server is a command line the middleware starts as its own child process. ADR-0211
recorded that the child runs under the middleware's OS user. Because of that it can read
`/proc/1/environ` (`VAULT_KEY`, `CREDENTIAL_KEYCHAIN_KEY`, `DATABASE_URL`, provider keys) and
the data directory (`/data`: Vault, `.dev-vault.key`, uploads, CLI logins), which is enough to
decrypt every stored secret. ADR-0211 accepted that risk and named a separate UID as the
follow-up. The owner decided on 2026-11-27 to build that isolation: the child gets its own OS
user, no access to `/data` and no middleware environment. How does the middleware, which runs
as the unprivileged `node` user, start a child under another UID, and what happens where that
is not possible?

## Decision Drivers

- A child must not read the middleware's secrets, neither from its environment nor from the
  data directory.
- The middleware keeps running unprivileged; no long-lived root process.
- The row's own config env (operator values and Vault secrets, epic #459) must still reach the
  child, and must never appear on a command line (`/proc/<pid>/cmdline` is world-readable).
- A configured isolation that silently falls back to the middleware's user would be the leak
  itself: fail closed.
- From-source runs and the desktop app have no second user and must keep working.

## Considered Options

- **A — `sudo` with a narrow rule in the image, switch configured by `MCP_STDIO_RUN_AS`**
- **B — Run the middleware as root and set `uid`/`gid` in `child_process.spawn`**
- **C — File capabilities (`cap_setuid`, `cap_setgid`) on the node binary**
- **D — A sandbox binary (bubblewrap, nsjail) per child**

## Decision Outcome

Chosen option: **A**, because it needs no privileged middleware process, passes the env through
`execve` instead of argv, and is one package plus one sudoers line in the image.

- **Environment, always.** A stdio child gets the MCP SDK's curated base (HOME, LOGNAME, PATH,
  SHELL, TERM, USER), the locale variables `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ` and the row's
  config env, nothing else (`stdioLaunch` / `stdioChildEnv`,
  `packages/harness-orchestrator/src/mcp/stdioIsolation.ts`). This holds on every install.
- **OS user, where configured.** `MCP_STDIO_RUN_AS=<user>` (a plain POSIX name) starts every
  stdio child through `sudo -n -E -H -u <user> -- <command> <args…>`. The image creates the
  system user `omadia-mcp` (own group, home `/home/omadia-mcp`, mode `0700`, shell `nologin`),
  installs `sudo` with the rule `node ALL=(omadia-mcp) NOPASSWD:SETENV: ALL` plus
  `Defaults:node !use_pty, !lecture, runcwd=~`, and sets `ENV MCP_STDIO_RUN_AS=omadia-mcp`.
  `node` can start commands as `omadia-mcp` only, never as root. `SETENV` lets `-E` keep the
  env handed over through `execve`; `-H`, `runcwd=~` and sudo's `secure_path` give the child
  its own HOME, working directory and PATH. Between sudo and the server a `/bin/sh` shim
  (`MCP_STDIO_CHILD_SHIM`) sets `umask 077` and gives each server its own npm cache,
  `$HOME/.npm-cache/<sha256(server id)[:16]>` (a row's own `npm_config_cache` wins).
- **No data directory.** The entrypoint sets `/data` to `0700` owned by `node` on every start
  (an existing volume was created `0755`); the image sets `/home/node` to `0700` as well. The
  middleware's `/proc/<pid>/environ` is readable only by its own UID, so the child can no longer
  read it either. On Fly the entrypoint also sets the Machines API socket `/.fly/api` to `0600`
  when it exists (root only; the middleware does not use it), and never fails the boot over it.
- **Fail closed.** With `MCP_STDIO_RUN_AS` set, the connect guard runs
  `sudo -n -E -H -u <user> -- true` before the first stdio spawn (`createStdioIsolationProbe`).
  A success is cached for the process lifetime, a failure for 30 seconds. When it fails, the
  connect is refused with the guard code `stdio_isolation_unavailable` (Discover →
  `502 mcp_discover_failed`, same shape as `stdio_disabled`) and no child is started.
- **Unset `MCP_STDIO_RUN_AS`** (from-source run, desktop app, or an operator who unsets it in
  the image): the child runs as the middleware's user with the scrubbed env. That is the
  ADR-0211 trust model, unchanged, and the UI says so.
- **The UI follows the deployment.** `GET /api/v1/operator/mcp-servers` reports
  `stdioIsolated` (configured) and, when the probe fails, `stdioIsolationError` (its reason);
  the add-server hint and the catalog card show the isolated or the shared-user wording, and
  the form names a broken switch before a Discover runs into it.
- **Compose default stays off.** `MCP_STDIO_ENABLED=false` in `middleware/compose.defaults.env`
  is kept (ADR-0211). Isolation removes access to the secrets; it does not remove the other
  things a stdio child shares with the middleware (network, CPU). Turning stdio on by default
  is a separate decision.

### Consequences

- 🟢 **Good:** On the container image, a stdio server or catalog package can no longer read
  `VAULT_KEY`, `DATABASE_URL`, provider keys or anything under `/data`.
- 🟢 **Good:** The middleware stays unprivileged; the only setuid binary is sudo with a rule
  scoped to one unprivileged target user.
- 🟢 **Good:** A broken switch (missing sudo, missing user, changed rule) refuses the connect
  instead of quietly running the child as `node`.
- 🔴 **Bad:** All stdio children share the one run-as UID. A hostile stdio server can read the
  other stdio servers' `/proc/<pid>/environ` (their config values, including Vault secrets of
  their rows), their files and their npm caches, and can signal them. The per-server npm cache
  only stops accidental sharing (one server's `npx` installing into another's cache); it is not
  a boundary between servers. Accepted for now: every stdio server is operator configuration;
  one UID per server (a user pool) is the follow-up if servers must be isolated from each other.
- 🔴 **Bad:** The child still shares the container's network namespace: it can reach Postgres,
  sidecars and the middleware's own port on loopback, without their credentials. Accepted;
  `docs/security-architecture.md` §10p names it.
- 🔴 **Bad:** A stdio server that read or wrote files under `/data`, or relied on the
  middleware's home (`/home/node`, e.g. an existing npx cache or config file), no longer
  finds them. It must get what it needs through its config env. Named in `docs/upgrading.md`.
- 🔴 **Bad:** The image grows by the `sudo` package (about 2 MB).
- 🔴 **Bad:** A runtime that forbids setuid (`--security-opt no-new-privileges`, some rootless or
  hardened runtimes) makes the switch fail; stdio is then refused with
  `stdio_isolation_unavailable` until the runtime allows it or the operator deliberately unsets
  `MCP_STDIO_RUN_AS`.
- ⚪ **Neutral:** `/proc` is not mounted with `hidepid`; other processes' command lines stay
  visible to the child. They carry no secrets (env goes through `execve`). A deployment that
  wants it can remount `/proc` with `hidepid=2` on the host side.
- ⚪ **Neutral:** Open check on Fly: whether `/.fly/api` is present and reachable by a non-root
  user could not be verified from the build environment; the entrypoint restricts it when it is
  a socket. The private-network Machines API (`_api.internal:4280`) needs a Fly token, which the
  child does not have.
- ⚪ **Neutral:** On the desktop app and from-source runs, isolation is the env scrub only,
  unless the operator creates a user and a sudo rule and sets `MCP_STDIO_RUN_AS`.

## Pros and Cons of the Options

### A — `sudo` with a narrow rule

- 🟢 Unprivileged middleware, env through `execve`, one package in the image.
- 🟢 Opt-in by one variable; the same code runs everywhere.
- 🔴 Relies on sudo's env handling (`-E` + `SETENV`; sudo still strips `LD_*` and similar,
  which a stdio server does not need).

### B — Root middleware, `spawn({ uid, gid })`

- 🟢 No extra package.
- 🔴 The whole middleware would run as root; every other bug becomes root inside the
  container.

### C — Capabilities on the node binary

- 🟢 No setuid helper.
- 🔴 `cap_setuid` lets the middleware become any user, root included; and a stdio child that
  is itself a node program would inherit the file capabilities on `exec`, undoing the switch.

### D — Sandbox binary per child

- 🟢 Could also cut the network and hide `/proc`.
- 🔴 Needs user namespaces or extra privileges that Fly machines and many Docker hosts do not
  grant; much larger change. Stays possible later behind the same `MCP_STDIO_RUN_AS` launch.

## More Information

`Dockerfile` (user, sudoers rule, `MCP_STDIO_RUN_AS`), `docker-entrypoint.sh` (`chmod 0700
/data`), `middleware/packages/harness-orchestrator/src/mcp/stdioIsolation.ts`,
`middleware/src/services/mcpStdioIsolationProbe.ts`,
`middleware/src/services/mcpOutboundHostGuard.ts` (`stdio_isolation_unavailable`),
`middleware/test/mcpStdioIsolation.test.ts`, `docs/security-architecture.md` §10p,
`docs/upgrading.md`. Issue #2306; ADR-0139, ADR-0211.
