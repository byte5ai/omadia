import { promises as fs } from 'node:fs';
import { Router } from 'express';
import type { Request, Response } from 'express';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { SecretVault } from '../secrets/vault.js';
import type {
  VaultBackupService,
  VaultBackupStatus,
} from '../secrets/vaultBackup.js';
import { createDisabledVaultBackupStatus } from '../secrets/vaultBackup.js';
import type { MasterKeySource } from '../health/platformHealth.js';

interface VaultStatusDeps {
  vault: SecretVault;
  registry: InstalledRegistry;
  vaultPath: string;
  dataDir: string;
  masterKeySource: MasterKeySource;
  /** #1387 — the credential keychain's own master key (`CREDENTIAL_KEYCHAIN_KEY`). */
  keychainKeySource: MasterKeySource;
  backup: VaultBackupService | null;
  backupDisabledReason?: string;
}

export interface VaultStatusBackupBody {
  enabled: boolean;
  bucket: string;
  prefix: string;
  retention: number;
  interval_hours: number;
  last_run_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  objects_kept: number | null;
}

export interface VaultStatusResponse {
  vault: {
    path: string;
    data_dir: string;
    exists: boolean;
    size_bytes: number | null;
    last_modified: string | null;
    agent_count: number;
    master_key_source: MasterKeySource;
    /** #1387 — source of the keychain master key, same values as `master_key_source`. */
    keychain_key_source: MasterKeySource;
    /** Both master keys come from env. One dev-file key is enough to say no. */
    production_ready: boolean;
  };
  backup: VaultStatusBackupBody;
}

/**
 * Read-only observability endpoint for the encrypted secret vault.
 *
 * Returns metadata only — file path, ciphertext size, mtime, number of
 * installed agents, and the sources the vault and keychain master keys were
 * loaded from. No
 * plaintext, no key material, no per-agent secret keys.
 *
 * Mounted behind `requireAuth`.
 */
export function createVaultStatusRouter(deps: VaultStatusDeps): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const vaultFile = await statOrNull(deps.vaultPath);
      const installed = deps.registry.list();
      let agentCount = 0;
      for (const entry of installed) {
        const keys = await deps.vault.listKeys(entry.id);
        if (keys.length > 0) agentCount += 1;
      }
      const backupStatus: VaultBackupStatus = deps.backup
        ? deps.backup.getStatus()
        : createDisabledVaultBackupStatus(
            deps.backupDisabledReason ?? 'backup service not configured',
          );
      const body: VaultStatusResponse = {
        vault: {
          path: deps.vaultPath,
          data_dir: deps.dataDir,
          exists: vaultFile !== null,
          size_bytes: vaultFile ? vaultFile.size : null,
          last_modified: vaultFile ? vaultFile.mtime.toISOString() : null,
          agent_count: agentCount,
          master_key_source: deps.masterKeySource,
          keychain_key_source: deps.keychainKeySource,
          // #1387 — this used to check the vault key alone, so an operator who
          // followed the vault warning and set only VAULT_KEY got a green
          // "production" card while the keychain key still sat in the dev file.
          production_ready:
            deps.masterKeySource === 'env' && deps.keychainKeySource === 'env',
        },
        backup: toBackupBody(backupStatus),
      };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        code: 'vault_status.read_failed',
        message,
      });
    }
  });

  return router;
}

function toBackupBody(s: VaultBackupStatus): VaultStatusBackupBody {
  return {
    enabled: s.enabled,
    bucket: s.bucket,
    prefix: s.prefix,
    retention: s.retention,
    interval_hours: s.intervalHours,
    last_run_at: s.lastRunAt,
    last_success_at: s.lastSuccessAt,
    next_run_at: s.nextRunAt,
    last_error: s.lastError,
    objects_kept: s.objectsKept,
  };
}

async function statOrNull(
  filePath: string,
): Promise<{ size: number; mtime: Date } | null> {
  try {
    const st = await fs.stat(filePath);
    return { size: st.size, mtime: st.mtime };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}
