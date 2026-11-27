# 0317 — The stdio shim supervises the server under the run-as user

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** W42 cluster lead (issue #2329, decision after the recommendation, reversible)
- **Supersedes:** — (refines [ADR-0270](0270-stdio-mcp-servers-run-as-their-own-os-user.md))

## Context and Problem Statement

With `MCP_STDIO_RUN_AS` set (ADR-0270), a stdio MCP child runs as
`sudo -n -E -H -u omadia-mcp -- /bin/sh -c <shim> …`, and the shim `exec`ed the server. To close
it, the MCP SDK ends stdin, sends SIGTERM to its direct child (`sudo`) and then SIGKILL. sudo
forwards SIGTERM, but a SIGKILL cannot be forwarded. A server that ignores stdin EOF and SIGTERM
then lives on as an orphan of `omadia-mcp`, and the middleware user cannot signal it. Who ends
such a server?

## Decision Drivers

- `node` must not gain more sudo rights than "run a command as `omadia-mcp`".
- A retired child (#2307) must be gone within the retire grace, whatever the server does.
- Children of a server (`npx` → `node`) must go too.

## Considered Options

- **A — Supervisor shim:** the shim runs as `omadia-mcp`, starts the server in its own process
  group, and escalates TERM → KILL on that group. It does this on SIGTERM, and when its parent
  sudo is gone.
- **B — Group kill through sudo:** start the child in its own process group and kill it with
  `sudo -u omadia-mcp kill -TERM/-KILL -<pgid>`. This needs the middleware to know the group,
  and the operator to keep a working rule for `kill`.

## Decision Outcome

Chosen option: **A**, because it needs no change to the sudoers rule or the image. It also holds
when sudo itself was SIGKILLed.

- `MCP_STDIO_CHILD_SHIM` (`packages/harness-orchestrator/src/mcp/stdioIsolation.ts`) starts
  `setsid "$@"` (plain `"$@"` where `setsid` is missing) in the background, with the
  middleware's stdin passed on explicitly. It waits for the server and returns its exit status.
- On SIGTERM, SIGINT or SIGHUP, and when `/proc/<parent>` disappears (Linux, polled once a
  second), it sends TERM to the server's group. After `MCP_STDIO_STOP_GRACE_S` (3 s) it sends
  KILL.
- The server's command line stays positional (`"$@"`). Nothing is re-parsed by the shell.

### Consequences

- 🟢 **Good:** A server that ignores stdin EOF and SIGTERM is gone a few seconds after
  `close()`, well inside the 30 s retire grace. Checked against the real `sudo` in the
  `node:22-slim` runtime. The old shim left the orphans in both cases.
- 🟢 **Good:** The sudoers rule and the image stay as ADR-0270 set them.
- 🔴 **Bad:** One extra `sh` process (and a polling subshell on Linux) per stdio child.
- ⚪ **Neutral:** Without `/proc` (macOS from-source runs), only the SIGTERM path applies. These
  runs have no user switch, and the middleware can signal the child itself.

## Pros and Cons of the Options

### A — Supervisor shim

- 🟢 No new privilege, and it works when sudo is gone.
- 🔴 More shell code in one constant.

### B — Group kill through sudo

- 🟢 No long-lived shim process.
- 🔴 It widens the sudoers rule's use and needs the group id on the middleware side. It fails
  when an operator's image lacks the rule.

## More Information

- Issues #2329, #2307, #2322. Test: `test/mcpStdioIsolation.test.ts` ("#2329 · …").
