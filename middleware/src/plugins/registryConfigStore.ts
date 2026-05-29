// ===========================================================================
// RegistryConfigStore — admin-managed, persistent registry configuration.
// ---------------------------------------------------------------------------
// The set of plugin registries Core pulls from is RUNTIME config, managed via
// the admin UI (not an immutable env var). The non-secret view (name + url)
// lives in the platform_settings KV (Postgres); bearer tokens are secrets and
// live in the encrypted SecretVault under a synthetic owner namespace — never
// in plaintext jsonb, never returned in a listing.
//
// On first boot the store is seeded: from `REGISTRY_URLS` if the operator set
// it, otherwise with the public default `hub.omadia.ai`. After seeding the
// list is fully admin-editable and the env var is no longer consulted.
//
// Backend-agnostic: the same logic runs against Postgres (PlatformSettingsStore
// structurally satisfies `RegistrySettingsKV`) or an in-memory KV for DB-less
// boots and tests.
// ===========================================================================

import type { RegistryConfigEntry } from '../api/registry-v1.js';
import type { SecretVault } from '../secrets/vault.js';

/** Public default registry seeded when nothing else is configured. */
export const DEFAULT_REGISTRY: { name: string; url: string } = {
  name: 'omadia-public',
  url: 'https://hub.omadia.ai',
};

/** Synthetic SecretVault owner namespace for registry bearer tokens. Not a
 *  real agent id, so it never surfaces in any per-agent secret listing. */
export const REGISTRY_VAULT_OWNER = '__registries__';

/** platform_settings key holding the non-secret registry list. */
export const SETTING_REGISTRY_LIST = 'registry.list';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Persisted, non-secret view of a configured registry. */
export interface StoredRegistry {
  name: string;
  url: string;
  /** True iff a bearer token is stored in the vault for this registry. */
  has_token: boolean;
}

/** Minimal KV the store needs. `PlatformSettingsStore` satisfies this. */
export interface RegistrySettingsKV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export class RegistryConfigError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'RegistryConfigError';
    this.code = code;
    this.status = status;
  }
}

export interface RegistryConfigStore {
  /** Resolved entries incl. tokens — feeds the RegistryClient. */
  list(): Promise<RegistryConfigEntry[]>;
  /** Non-secret listing for the admin UI (never leaks tokens). */
  listPublic(): Promise<StoredRegistry[]>;
  add(input: { name: string; url: string; token?: string }): Promise<void>;
  update(
    name: string,
    patch: { url?: string; token?: string | null },
  ): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface VaultBackedRegistryConfigStoreDeps {
  settings: RegistrySettingsKV;
  vault: SecretVault;
}

/**
 * Default `RegistryConfigStore` — non-secret list in the KV, tokens in the
 * vault. Works over any `RegistrySettingsKV` (Postgres or in-memory).
 */
export class VaultBackedRegistryConfigStore implements RegistryConfigStore {
  constructor(private readonly deps: VaultBackedRegistryConfigStoreDeps) {}

  private async readList(): Promise<StoredRegistry[]> {
    const raw = await this.deps.settings.get<StoredRegistry[]>(
      SETTING_REGISTRY_LIST,
    );
    return Array.isArray(raw) ? raw : [];
  }

  private async writeList(list: StoredRegistry[]): Promise<void> {
    await this.deps.settings.set(SETTING_REGISTRY_LIST, list);
  }

  async listPublic(): Promise<StoredRegistry[]> {
    return this.readList();
  }

  async list(): Promise<RegistryConfigEntry[]> {
    const stored = await this.readList();
    const out: RegistryConfigEntry[] = [];
    for (const r of stored) {
      const entry: RegistryConfigEntry = { name: r.name, url: r.url };
      if (r.has_token) {
        const token = await this.deps.vault.get(REGISTRY_VAULT_OWNER, r.name);
        if (token) entry.token = token;
      }
      out.push(entry);
    }
    return out;
  }

  async add(input: {
    name: string;
    url: string;
    token?: string;
  }): Promise<void> {
    assertName(input.name);
    assertUrl(input.url);
    const list = await this.readList();
    if (list.some((r) => r.name === input.name)) {
      throw new RegistryConfigError(
        'registry_config.duplicate',
        `a registry named '${input.name}' already exists`,
        409,
      );
    }
    const hasToken = typeof input.token === 'string' && input.token.length > 0;
    if (hasToken) {
      await this.deps.vault.set(REGISTRY_VAULT_OWNER, input.name, input.token!);
    }
    list.push({ name: input.name, url: input.url, has_token: hasToken });
    await this.writeList(list);
  }

  async update(
    name: string,
    patch: { url?: string; token?: string | null },
  ): Promise<void> {
    const list = await this.readList();
    const idx = list.findIndex((r) => r.name === name);
    if (idx < 0) throw notFound(name);
    const row = { ...list[idx]! };

    if (patch.url !== undefined) {
      assertUrl(patch.url);
      row.url = patch.url;
    }
    if (patch.token !== undefined) {
      if (patch.token === null || patch.token === '') {
        await this.deps.vault.deleteKey(REGISTRY_VAULT_OWNER, name);
        row.has_token = false;
      } else {
        await this.deps.vault.set(REGISTRY_VAULT_OWNER, name, patch.token);
        row.has_token = true;
      }
    }
    list[idx] = row;
    await this.writeList(list);
  }

  async remove(name: string): Promise<void> {
    const list = await this.readList();
    const next = list.filter((r) => r.name !== name);
    if (next.length === list.length) throw notFound(name);
    await this.deps.vault.deleteKey(REGISTRY_VAULT_OWNER, name);
    await this.writeList(next);
  }
}

/** In-memory `RegistrySettingsKV` for DB-less boots and tests. JSON round-trips
 *  on read to mimic Postgres jsonb (no aliasing of the stored value). */
export class InMemoryRegistrySettings implements RegistrySettingsKV {
  private readonly map = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }
}

/**
 * Seed the store on first boot. No-op if any registry already exists, so it is
 * safe to call on every boot. `seed` is the parsed `REGISTRY_URLS` (env); when
 * empty, the public default `hub.omadia.ai` is used.
 */
export async function seedRegistriesIfEmpty(
  store: RegistryConfigStore,
  seed: RegistryConfigEntry[],
  log: (msg: string) => void = (m) => console.log(m),
): Promise<void> {
  const existing = await store.listPublic();
  if (existing.length > 0) return;
  const toSeed: RegistryConfigEntry[] =
    seed.length > 0 ? seed : [{ ...DEFAULT_REGISTRY }];
  for (const r of toSeed) {
    try {
      await store.add({ name: r.name, url: r.url, token: r.token });
    } catch (err) {
      log(
        `[registry] seed skipped '${r.name}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  log(
    `[registry] seeded ${toSeed.length} default registr${
      toSeed.length === 1 ? 'y' : 'ies'
    } (${toSeed.map((r) => r.name).join(', ')})`,
  );
}

// ----- validation ----------------------------------------------------------

function assertName(name: string): void {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new RegistryConfigError(
      'registry_config.invalid_name',
      "name must match /^[a-z0-9][a-z0-9._-]{0,63}$/i",
      400,
    );
  }
}

function assertUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RegistryConfigError(
      'registry_config.invalid_url',
      `'${url}' is not a valid URL`,
      400,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RegistryConfigError(
      'registry_config.invalid_url',
      'registry url must be http(s)',
      400,
    );
  }
}

function notFound(name: string): RegistryConfigError {
  return new RegistryConfigError(
    'registry_config.not_found',
    `no registry named '${name}'`,
    404,
  );
}
