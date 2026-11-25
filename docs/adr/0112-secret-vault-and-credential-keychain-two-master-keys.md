# 0112 — Secrets at rest: a namespaced encrypted vault and a separate keychain key; production refuses dev keys

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main). The vault
  ships since v0.1.0; the keychain key is #578; key-posture reporting #1385 / #1387.

## Context and Problem Statement

This record is retroactive: it documents a decision that is implemented on main.

The kernel holds provider keys, plugin setup secrets, OAuth tokens, its own session signing
key, hashed API keys and, since the credential keychain (#578), personal and service
credentials that agents use through a broker. System prompts and plugin configuration are
read on every turn and leak easily through logs and transcripts. Where do secrets live, who
can read which ones, which key protects them, and what happens when no key was configured?

## Decision Drivers

- No secret in a prompt, a manifest, an agent config or the non-secret install registry.
- A plugin reads only its own secrets.
- A local `docker compose up` must work without key management.
- A production deployment must not silently run on a key stored next to the data.
- One leaked key should not unlock every class of secret.

## Considered Options

- **A — One encrypted file vault namespaced per plugin, a second master key for the
  credential keychain, env keys mandatory in production.**
- **B — One master key for everything.**
- **C — An external secret manager** (cloud KMS, HashiCorp Vault) as the only backend.
- **D — Secrets in Postgres or in the install registry next to the configuration.**

## Decision Outcome

Chosen option: **A**.

- **The vault** (`secrets/fileVault.ts`) is one file, `vault.enc.json`, encrypted as a single
  AES-256-GCM blob with a random 12-byte IV per write, written atomically (tmp + rename).
  The interface (`secrets/vault.ts`) is namespaced by plugin/agent id: a handle never crosses
  a namespace, there is `listKeys` but no way to list values, rotation replaces one key and
  uninstall purges the namespace.
- **Configuration and secrets are split at install.** Setup fields of type `secret` and
  `oauth` go to the vault; everything else goes to the installed registry
  (`plugins/installedRegistry.ts`), which records only non-secret configuration.
- **A kernel-only scope.** `core:auth` (`auth/coreAuthScope.ts`) holds the session signing
  key and Entra refresh tokens. The colon puts it outside the plugin id format, and no
  `PluginContext` is ever handed out against it.
- **Two master keys.** `VAULT_KEY` protects the vault. `CREDENTIAL_KEYCHAIN_KEY` protects the
  credential keychain (`credentials/crypto.ts`, same envelope and cipher, each secret sealed
  individually). They are deliberately different keys and dev-key files: plugin-owned
  provider secrets and broker-mediated credentials are different trust domains.
- **Key resolution** (`resolveMasterKey`): the env value (base64, 32 bytes), else an existing
  dev-key file under the data directory, else a freshly generated one with a loud warning.
  With `NODE_ENV=production` only the env value is accepted and boot fails otherwise, naming
  the variable that is missing.
- **Posture is visible, but not publicly.** The unauthenticated `/health` does not say where
  the keys came from. The authenticated `GET /api/v1/admin/vault-status` reports
  `master_key_source` and `keychain_key_source`; `production_ready` requires both from env.
- **Writes are observable inside the kernel only.** The concrete vault emits key names, never
  values, after a write (`secrets/vaultWriteEvents.ts`) so caches derived from a credential
  are dropped (#1080). The observer is not part of the `SecretVault` interface.
- **Backup carries ciphertext only.** The optional nightly snapshot to S3-compatible storage
  (`VAULT_BACKUP_ENABLED`, `secrets/vaultBackup.ts`) never uploads a master key.

### Consequences

- 🟢 **Good:** A plugin cannot read another plugin's secrets or the kernel's signing key.
- 🟢 **Good:** A copied data volume or backup bucket is useless without the env key.
- 🔴 **Bad:** The Compose stack overrides `NODE_ENV` to `development` so it boots without
  keys; such an install runs on a key file stored beside the vault it encrypts until the
  operator sets both keys and drops the override.
- 🔴 **Bad:** The vault is one file on one volume, loaded once into process memory and
  rewritten whole on every change. Nothing coordinates two kernel processes writing it, and
  the file header sizes the design for on the order of 100 namespaces.
- 🔴 **Bad:** No re-keying tool is in the tree. The keys must stay stable: losing or
  changing one makes the vault or keychain entries unrecoverable (`docker-compose.yaml`).
- ⚪ **Neutral:** The kernel process holds the master keys and decrypted values in memory;
  namespace isolation is an API guarantee, not a process boundary.

## Pros and Cons of the Options

### A — Namespaced file vault, two keys, env keys in production

- 🟢 No external dependency; works on desktop, Compose and Fly alike.
- 🔴 Single-file, single-writer.

### B — One master key

- 🟢 One secret to manage.
- 🔴 One leak unlocks plugin secrets and every brokered credential.

### C — External secret manager only

- 🟢 Rotation, audit and HSM backing come with the product.
- 🔴 No offline or desktop install; a hard dependency for the open-source default.

### D — Secrets beside configuration

- 🟢 One store.
- 🔴 Every config read, export and backup carries secrets.

## More Information

- Code: `middleware/src/secrets/`, `middleware/src/credentials/crypto.ts`,
  `middleware/src/auth/{coreAuthScope,sessionSigningKey}.ts`,
  `middleware/src/routes/vaultStatus.ts`, `docker-compose.yaml` (key comments).
- Tests: `middleware/test/{fileVaultPersistRace,secretVaultWriteEvents,vaultStatusRoute,credentialCrypto}.test.ts`.
- Docs: `docs/security-architecture.md` §1, §2, §8; `SECURITY.md` ("Handling secrets").
- Related: [ADR-0102](0102-credential-broker-stamps-secrets-and-owner-only-asks.md),
  [ADR-0101](0101-api-keys-as-second-authentication-method.md), ADR-0001, ADR-0017.
