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

interface VaultStatusDeps {
  vault: SecretVault;
  registry: InstalledRegistry;
  vaultPath: string;
  dataDir: string;
  masterKeySource: 'env' | 'dev-file-existed' | 'dev-file-created';
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
    master_key_source: 'env' | 'dev-file-existed' | 'dev-file-created';
    production_ready: boolean;
  };
  backup: VaultStatusBackupBody;
}

/**
 * Read-only observability endpoint for the encrypted secret vault.
 *
 * Returns metadata only — file path, ciphertext size, mtime, number of
 * installed agents, and the source the master key was loaded from. No
 * plaintext, no key material, no per-agent secret keys.
 *
 * Currently unauthenticated; A.1 will gate this behind the JWT middleware
 * once OAuth lands. The payload is deliberately non-sensitive so a short
 * window of open access during the M.0 rollout does not leak credentials.
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
          production_ready: deps.masterKeySource === 'env',
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
