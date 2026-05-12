import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import type { SecretVault } from './vault.js';

/**
 * Encrypted, file-backed per-agent secret vault.
 *
 * File format (vault.enc.json):
 *   {
 *     "version": 1,
 *     "iv": "<base64 12-byte IV>",
 *     "tag": "<base64 16-byte GCM auth tag>",
 *     "ciphertext": "<base64 encrypted JSON payload>"
 *   }
 *
 * Cipher: AES-256-GCM with a random IV per write. The master key is 32
 * bytes and comes from VAULT_KEY (base64) or a dev-only .dev-vault.key file.
 *
 * Writes are atomic (tmp file + rename). We encrypt the whole payload as a
 * single blob — simpler than per-entry envelopes and sufficient for the
 * target scale (O(100) agents × O(10) keys).
 */

interface EncryptedFile {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface MasterKeyResult {
  key: Buffer;
  source: 'env' | 'dev-file-existed' | 'dev-file-created';
}

export class FileSecretVault implements SecretVault {
  private readonly byAgent = new Map<string, Map<string, string>>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) {
      throw new Error('FileSecretVault: masterKey must be 32 bytes');
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as EncryptedFile;
      if (parsed.version !== 1) {
        throw new Error(`unknown vault file version: ${parsed.version}`);
      }
      const plaintext = this.decrypt(parsed);
      const payload = JSON.parse(plaintext) as {
        agents: Record<string, Record<string, string>>;
      };
      this.byAgent.clear();
      for (const [agentId, entries] of Object.entries(payload.agents ?? {})) {
        this.byAgent.set(agentId, new Map(Object.entries(entries)));
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
      this.byAgent.clear();
    }
    this.loaded = true;
  }

  async set(agentId: string, key: string, value: string): Promise<void> {
    this.ensureLoaded();
    let ns = this.byAgent.get(agentId);
    if (!ns) {
      ns = new Map<string, string>();
      this.byAgent.set(agentId, ns);
    }
    ns.set(key, value);
    await this.persist();
  }

  async setMany(
    agentId: string,
    entries: Record<string, string>,
  ): Promise<void> {
    this.ensureLoaded();
    let ns = this.byAgent.get(agentId);
    if (!ns) {
      ns = new Map<string, string>();
      this.byAgent.set(agentId, ns);
    }
    for (const [k, v] of Object.entries(entries)) ns.set(k, v);
    await this.persist();
  }

  async get(agentId: string, key: string): Promise<string | undefined> {
    this.ensureLoaded();
    return this.byAgent.get(agentId)?.get(key);
  }

  async listKeys(agentId: string): Promise<string[]> {
    this.ensureLoaded();
    const ns = this.byAgent.get(agentId);
    return ns ? Array.from(ns.keys()).sort() : [];
  }

  async purge(agentId: string): Promise<void> {
    this.ensureLoaded();
    this.byAgent.delete(agentId);
    await this.persist();
  }

  async deleteKey(agentId: string, key: string): Promise<void> {
    this.ensureLoaded();
    const ns = this.byAgent.get(agentId);
    if (!ns || !ns.has(key)) return;
    ns.delete(key);
    await this.persist();
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error(
        'FileSecretVault: call load() before any other operation',
      );
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const agents: Record<string, Record<string, string>> = {};
    for (const [agentId, ns] of this.byAgent) {
      agents[agentId] = Object.fromEntries(ns);
    }
    const plaintext = JSON.stringify({ agents });
    const envelope = this.encrypt(plaintext);
    const serialized = JSON.stringify(envelope, null, 2);
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, serialized, { mode: 0o600, encoding: 'utf8' });
    await fs.rename(tmp, this.filePath);
  }

  private encrypt(plaintext: string): EncryptedFile {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      version: 1,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ct.toString('base64'),
    };
  }

  private decrypt(file: EncryptedFile): string {
    const iv = Buffer.from(file.iv, 'base64');
    const tag = Buffer.from(file.tag, 'base64');
    const ct = Buffer.from(file.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }
}

/**
 * Resolve the 32-byte master key used to encrypt the vault.
 *
 * Precedence:
 *   1. VAULT_KEY env (base64, 32 bytes) — production path.
 *   2. Existing dev key file under DATA_DIR/.dev-vault.key.
 *   3. Freshly generated 32-byte key written to the dev key file (LOUD warning).
 *
 * When `productionMode` is true, only step 1 is permitted — falling back to
 * a host-local dev key in production silently turns an encrypted vault into
 * plaintext-at-rest equivalence (anyone with read access to the data volume
 * can decrypt). Fail-hard instead of warn-and-continue.
 *
 * The caller is responsible for logging the source so operators notice when
 * they're unintentionally on dev-path.
 */
export async function resolveMasterKey(
  envValue: string | undefined,
  devKeyPath: string,
  productionMode = false,
): Promise<MasterKeyResult> {
  if (envValue && envValue.length > 0) {
    const buf = Buffer.from(envValue, 'base64');
    if (buf.length !== 32) {
      throw new Error('VAULT_KEY must decode to 32 bytes (base64)');
    }
    return { key: buf, source: 'env' };
  }
  if (productionMode) {
    throw new Error(
      `VAULT_KEY is required when NODE_ENV=production. Refusing to fall back ` +
        `to dev key file at ${devKeyPath}. Generate one with ` +
        `\`openssl rand -base64 32\` and set it as a secret (e.g. ` +
        `\`fly secrets set VAULT_KEY=...\`).`,
    );
  }
  try {
    const existing = await fs.readFile(devKeyPath, 'utf8');
    const buf = Buffer.from(existing.trim(), 'base64');
    if (buf.length !== 32) {
      throw new Error(`${devKeyPath} does not contain a valid 32-byte key`);
    }
    return { key: buf, source: 'dev-file-existed' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  }
  const fresh = crypto.randomBytes(32);
  await fs.mkdir(path.dirname(devKeyPath), { recursive: true });
  await fs.writeFile(devKeyPath, fresh.toString('base64'), { mode: 0o600 });
  return { key: fresh, source: 'dev-file-created' };
}
