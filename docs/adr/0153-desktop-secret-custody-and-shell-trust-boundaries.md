# 0153 — The desktop shell holds the master keys, authenticates its own database and gates the renderer by origin and phase

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from
  `docs/security-architecture.md` §8a, §8b, §10i, §10j and `desktop/src/`)

## Context and Problem Statement

This record is retroactive: it documents controls that are implemented on main.

A server install gets `VAULT_KEY` and `CREDENTIAL_KEYCHAIN_KEY` from its platform's secret
store, and its database from an operator. The desktop app has neither. It also shows three
kinds of documents in one window with one preload: bundled pages (wizard, loading screen), the
loopback web UI, and whatever a sign-in redirect lands on. The first embedded database was
initialised with `trust` authentication, so any local process could log in as superuser. Who
holds the keys on a desktop, who may reach the database, and which document may call the
shell?

## Decision Drivers

- The kernel refuses to boot in production mode without both master keys.
- Replacing the keys loses the data they encrypt; losing a file must not silently do that.
- Other OS users and other local processes are outside the trust boundary.
- The recovery-key export returns `VAULT_KEY`; no web page may reach it.

## Considered Options

- **A — The shell generates and keeps all secrets in one OS-encrypted file, runs the database
  with SCRAM and a restricted kernel role, and decides every IPC call in the main process from
  the sender frame and the app phase.**
- **B — Use the kernel's development fallback (keys written into the data directory).**
- **C — `trust` authentication on loopback and one bridge for every document.**

## Decision Outcome

Chosen option: **A**.

- **One file, OS-encrypted.** `secrets.enc` in the data folder holds `VAULT_KEY`,
  `CREDENTIAL_KEYCHAIN_KEY`, the provider keys from the wizard and the two database passwords,
  encrypted with Electron `safeStorage` (Keychain, DPAPI, Secret Service).
- **Fail closed.** A packaged build refuses to store secrets when OS encryption is unavailable.
  New keys are created only when the file is missing; an existing file that cannot be read
  throws `SecretsUnreadableError` and is never replaced. Every rewrite is backup, temp file,
  rename (`desktop/src/secretsBlob.ts`, `secretsStore.ts`).
- **Two database roles, SCRAM only.** `omadia` (bootstrap superuser) is used by the shell
  alone and its password never leaves the shell process. The kernel connects as
  `omadia_kernel`, which owns the database but is `NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS`. The shell owns `pg_hba.conf` (`scram-sha-256` rules for exactly
  these roles) and rewrites it only while the server is stopped.
- **A private endpoint.** On macOS and Linux the server listens only on a Unix socket in a
  directory no other OS user can enter; on Windows on loopback TCP. Clients accept SCRAM only
  (`desktop/src/scramOnlyConnect.ts`, `OMADIA_DB_REQUIRE_SCRAM=1` for the kernel).
- **The renderer bridge is gated twice.** The preload classifies the document
  (`bridgeSurface.ts`: `wizard`, `boot`, `app`, `none`) as defence in depth. The boundary is
  the main process: every channel is registered for one surface and checked against
  `event.senderFrame`, the real install path or the web UI's exact origin, and the navigator's
  current view (`ipcSender.ts`). Setup channels answer only the bundled wizard while the
  wizard is the view; the web UI gets `uiReady` and `setUiLocale` only.
- **Navigation is restricted.** The main frame stays on the app's own loopback origins; other
  web links open in the system browser; `javascript:`, `data:`, `file:` and custom schemes are
  refused; no permission, including `openExternal`, is granted by default
  (`navigationPolicy.ts`). A foreign sign-in page reached by server redirect may continue its
  own hops and gets no bridge.
- **A wizard switch changes the kernel or does not exist** (§10j): the one switch,
  Attachments, reaches the kernel as environment.

### Consequences

- 🟢 **Good:** No plaintext-equivalent key next to the data, unlike the kernel's dev fallback.
- 🟢 **Good:** A local process without the password cannot log in; the kernel cannot run
  superuser statements.
- 🔴 **Bad, accepted:** The recovery key is `VAULT_KEY` itself and is display-only; there is no
  import path yet. A lost or unreadable `secrets.enc` without a snapshot means lost data.
- 🔴 **Bad, accepted for v1:** `VAULT_KEY`, provider keys and the kernel role's password travel
  in the child environment, readable by same-user processes.
- 🔴 **Bad:** On Windows the loopback port is a shared resource; another local user who binds it
  fails the boot (it does not learn a password).
- ⚪ **Neutral:** The pre-update snapshot copies `pgdata` plus `secrets.enc`, not
  `platform-data/` (see [ADR-0152](0152-desktop-installers-signing-and-auto-update.md)).

## Pros and Cons of the Options

### A — Shell-held secrets, SCRAM, main-process IPC checks

- 🟢 Matches the wizard's promise; testable in Electron-free modules.
- 🔴 Considerable shell code; recovery remains manual.

### B — Kernel dev fallback

- 🟢 No shell code.
- 🔴 Master keys in the data volume, the weakness `docker-compose.yaml` warns about.

### C — `trust` and one open bridge

- 🟢 Simple.
- 🔴 Any local process is database superuser; any loaded page could ask for the vault key.

## More Information

- Docs: `docs/security-architecture.md` §8a, §8b, §10i, §10j; `desktop/README.md`.
- Code: `desktop/src/secrets.ts`, `secretsBlob.ts`, `secretsStore.ts`, `embeddedDbAuth.ts`,
  `embeddedDbEndpoint.ts`, `bridgeSurface.ts`, `ipcSender.ts`, `navigationPolicy.ts`.
- Tests: `desktop/test/secretsBlob.test.mts`, `embeddedDbAuth.test.mts`,
  `ipcSender.test.mts`, `navigationPolicy.test.mts`, `bridgeSurface.test.mts`.
- Related draft: [ADR-0154](0154-desktop-shell-supervises-the-unmodified-stack-with-bundled-postgres.md).
