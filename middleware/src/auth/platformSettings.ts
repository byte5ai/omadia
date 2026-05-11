import type { Pool } from 'pg';

/**
 * Tiny key→JSON KV that survives a process restart but is not scoped to
 * any single agent. The per-agent SecretVault is the wrong shape for
 * platform-wide runtime config (it'd need a synthetic owner-id and would
 * leak into agent secret-listings). This store lives in the auth schema
 * because its first consumer (OB-50) is the auth admin-UI's
 * provider-toggle override; further keys can join later.
 *
 * Conventions:
 *   - keys are dotted namespaces ('auth.active_providers', 'ui.banner', …)
 *   - values are arbitrary JSON; the consumer narrows on read
 *   - upsert semantics: `set` overwrites, `delete` removes the row
 */

export class PlatformSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get<T>(key: string): Promise<T | null> {
    const res = await this.pool.query<{ value: unknown }>(
      'SELECT value FROM platform_settings WHERE key = $1 LIMIT 1',
      [key],
    );
    const row = res.rows[0];
    return row ? (row.value as T) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
  }

  async delete(key: string): Promise<void> {
    await this.pool.query('DELETE FROM platform_settings WHERE key = $1', [key]);
  }
}

/** Storage key for the OB-50 "currently active providers" override. */
export const SETTING_AUTH_ACTIVE_PROVIDERS = 'auth.active_providers';
