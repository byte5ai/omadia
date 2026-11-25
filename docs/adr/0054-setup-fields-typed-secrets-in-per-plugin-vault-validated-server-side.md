# 0054 — Setup fields: typed values, secrets in a per-plugin vault namespace, validation on the server

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); vault scoping from manifest schema v1 (design principle 6), pattern validation OM-17 (#602, #603), typed values #1464/#1524/#1958, runtime secret writes from spec 004, OAuth broker from spec 005
- **Supersedes:** —

## Context and Problem Statement

A plugin needs values from the operator: URLs, switches, API keys, OAuth connections. The
manifest declares them as setup fields and the kernel renders the form, stores the values
and hands them to the plugin. Several things went wrong in practice: a customer typed a
work e-mail and an account password into two fields that wanted a service-account address
and a PEM key, and both were stored and confirmed; boolean and integer values reached
plugins as strings; and a plugin manifest, which is untrusted input, supplies the regular
expression that the server runs. This record is written retroactively; the decision is
implemented on main.

Where do setup values live, who may read them, and where are they checked?

## Decision Drivers

- A secret must never sit in plain configuration, a listing or another plugin's reach.
- The check that guards the vault write must run where the vault write happens.
- A manifest pattern must not be able to stall the event loop.
- A plugin reads a value in its declared type, whatever spelling it was stored in.
- Fields without a pattern must keep working exactly as before.

## Considered Options

- **A — Kernel-owned typed fields; secrets in a vault namespaced by plugin id; server-side
  validation with a bounded pattern matcher**
- **B — Plugins store and validate their own settings**
- **C — One configuration store for everything, secrets flagged for masking**
- **D — A linear-time regex engine (RE2) instead of a time bound**

## Decision Outcome

Chosen option: **A**.

- **Field types** (`SetupFieldType`): `string`, `url`, `secret`, `oauth`, `enum`,
  `boolean`, `integer`, `host_list`, `json_file`.
- **Two stores, split by type** (`splitSecretsAndConfig` in `installService.ts`): `secret`
  and `oauth` values go to the vault under the plugin's id; everything else goes to the
  entry's `config` in the installed registry, which records only non-secret values.
- **Vault invariants** (`middleware/src/secrets/vault.ts`): secrets are namespaced by
  plugin id; no handle crosses a namespace; there is no call that lists values, only
  `listKeys`; uninstall purges the namespace. The file store encrypts the whole payload
  with AES-256-GCM under a 32-byte key from `VAULT_KEY`, with a dev-only key file as
  fallback.
- **A plugin's view** (`ctx.secrets`, `ctx.config`): `get`, `require` (throws
  `MissingSecretError` / `MissingConfigError`) and `keys`. Writing secrets at runtime
  exists only when the manifest declares `permissions.secrets.runtime_write`, and only in
  the plugin's own namespace.
- **OAuth is kernel-owned.** The broker runs the authorization-code flow and stores the
  tokens in the plugin's namespace; no plugin code runs in the loop, so client secret and
  refresh token do not leave the kernel.
- **Typed values have one parser** (`setupFieldValue.ts`). Manifest defaults, install
  submissions, the string-only patch body of the post-install editor and values stored by
  older builds all pass through it; a `boolean` or `integer` field reaches the plugin as
  a real boolean or number.
- **Validation is on the server, in one module** (`setupFieldPattern.ts`), shared by the
  install commit and the post-install credentials patch. For a manifest `pattern`:
  - an allowlist grammar screens the source at manifest load (no backreferences, no
    quantified group containing alternation or another quantifier, bounded nesting and
    repetition, source at most 512 characters);
  - every match runs in a worker thread under a 250 ms budget; overrun counts as a
    violation; values over 8192 characters are refused unmatched;
  - the source is anchored like an HTML `pattern` attribute;
  - a pattern that is rejected or does not compile is dropped, never a 500, and the
    field is marked `pattern_unavailable` so the operator sees it is unchecked.
- **`host_list` values widen `ctx.http`** only in the plugin's own allowlist; `json_file`
  stores nothing itself and maps an uploaded document onto other fields.

### Consequences

- 🟢 **Good:** A secret has one home, one owner and no read path that returns it in bulk.
- 🟢 **Good:** A hostile or careless pattern costs one bounded wait on an admin write.
- 🔴 **Bad:** The grammar is conservative and rejects legitimate-looking patterns; such a
  field is then unchecked, visibly.
- 🔴 **Bad:** The vault is one encrypted blob rewritten per change, sized for roughly a
  hundred plugins with ten keys each; losing `VAULT_KEY` loses every secret.
- 🔴 **Bad:** Namespacing protects the handle the kernel gives out. Plugin code runs in
  the kernel's process; this is not a boundary against hostile code.
- ⚪ **Neutral:** Registry bearer tokens use the same vault under the synthetic owner
  `__registries__` ([ADR-0051](0051-plugin-registries-runtime-config-first-wins-and-graceful-degrade.md)).

## Pros and Cons of the Options

### A — Kernel-owned fields, vault, bounded validation

- 🟢 Uniform forms, storage and checks for every plugin.
- 🔴 The kernel owns a regex screen and a worker.

### B — Plugin-owned settings

- 🟢 Maximum freedom for authors.
- 🔴 Secrets end up wherever each plugin puts them; no common install dialog.

### C — One store with masking

- 🟢 One code path.
- 🔴 Masking is presentation; the registry file would hold secrets in plain JSON.

### D — RE2

- 🟢 No time bound needed.
- 🔴 Every Node binding is a native addon, which the Electron desktop build would have to
  rebuild per ABI and platform.

## More Information

- Related: [ADR-0014](0014-plugins-are-only-the-delivery-form.md) (credentials stay in
  the vault), [ADR-0017](0017-model-gateway-and-execution-contexts.md) (network sandbox).
- Paths: `middleware/src/plugins/setupFieldPattern.ts`, `setupFieldValue.ts`,
  `setupJsonFile.ts`, `installService.ts`, `oauth/brokerService.ts`;
  `middleware/src/secrets/vault.ts`, `fileVault.ts`; `middleware/src/routes/runtime.ts`;
  types in `middleware/src/api/admin-v1.ts` and
  `middleware/packages/plugin-api/src/pluginContext.ts` (`SecretsAccessor`).
- Tests: `middleware/test/setupFieldPatternValidation.test.ts`, `setupFieldValue.test.ts`,
  `manifestLoaderSetupFields.test.ts`.
- Border: the vault implementation (`middleware/src/secrets/`) also belongs to the
  security domain.
