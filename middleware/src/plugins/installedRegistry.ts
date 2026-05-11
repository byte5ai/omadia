/**
 * Registry of installed agents.
 *
 * v1 (this file): in-memory. A restart of the middleware forgets every
 * installation. Slice 1.2b persists this to JSON under /data/plugins/installed.
 *
 * Every entry records ONLY non-secret configuration. Secret values live in
 * the vault (see src/secrets/vault.ts). Keeping those concerns separate makes
 * Slice 1.2b's persistence migration straightforward — config is plain JSON,
 * secrets are encrypted blobs.
 */

import type { AgentId, ISO8601 } from '../api/admin-v1.js';

export interface InstalledAgent {
  id: AgentId;
  installed_version: string;
  installed_at: ISO8601;
  status: 'active' | 'inactive' | 'errored';
  /** Non-secret setup values (everything whose SetupField.type !== 'secret' && !== 'oauth'). */
  config: Record<string, unknown>;
  /** Circuit-breaker: count of consecutive activation failures since the last
   *  successful activation. Reset to 0 on success. When it reaches
   *  CIRCUIT_BREAKER_THRESHOLD the entry's status flips to 'errored' and
   *  `activateAllInstalled` will skip it on subsequent boots until manual
   *  intervention (remove + reinstall, or dedicated /reactivate endpoint). */
  activation_failure_count?: number;
  /** Human-readable tail of the last activation error. Populated only when
   *  activation_failure_count > 0. Trimmed to avoid unbounded growth. */
  last_activation_error?: string;
  /** ISO8601 of the last activation failure. */
  last_activation_error_at?: ISO8601;
  /** Raw `<name>@<major>` strings that the resolver could not satisfy on
   *  the most recent boot. Persisted by `toolPluginRuntime` when a
   *  consumer is dropped from the eligible set; consumed by
   *  `bootstrap.retryErroredPlugins` to decide whether the chain is now
   *  resolvable (operator may have installed a provider in the
   *  meantime) and the entry can be auto-reset to 'active'. Cleared
   *  on success or via `clearActivationError`. */
  unresolved_requires?: string[];
}

/** Number of consecutive activation failures tolerated before the entry is
 *  flipped to status='errored' and skipped on future boots. Exposed as a
 *  constant (not per-registry config) so the value is the same across
 *  in-memory and file-backed implementations. */
export const CIRCUIT_BREAKER_THRESHOLD = 3;

/** Max length stored in last_activation_error — keep the registry JSON small. */
const ERROR_TAIL_MAX = 500;

export interface InstalledRegistry {
  list(): InstalledAgent[];
  get(id: AgentId): InstalledAgent | undefined;
  has(id: AgentId): boolean;
  register(entry: InstalledAgent): Promise<void>;
  remove(id: AgentId): Promise<void>;
  /** Record a failed activation attempt. Increments failure count and flips
   *  status to 'errored' when the threshold is reached. No-op if the agent
   *  is not in the registry. The optional `unresolved_requires` list is
   *  persisted alongside the error so `bootstrap.retryErroredPlugins` can
   *  re-check whether the chain is now resolvable on the next boot. */
  markActivationFailed(
    id: AgentId,
    error: string,
    unresolvedRequires?: readonly string[],
  ): Promise<void>;
  /** Record a successful activation. Clears failure count + last error +
   *  unresolved_requires. */
  markActivationSucceeded(id: AgentId): Promise<void>;
  /** Lift the `errored` circuit-breaker state of an entry without going
   *  through a full activation. Use case: bootstrap-time auto-reset when
   *  the operator has either fixed the plugin's source/manifest
   *  (file-mtime > last_activation_error_at) or installed a provider for
   *  every previously-unresolved capability. Sets status back to
   *  'active' and clears all error fields + `unresolved_requires`. No-op
   *  if the agent is not in the registry. */
  clearActivationError(id: AgentId): Promise<void>;
  /** Replace the non-secret config for an installed agent. Throws if the
   *  agent is not installed. Callers supplying a partial should merge with
   *  `get(id).config` first — this method overwrites, not merges. */
  updateConfig(id: AgentId, config: Record<string, unknown>): Promise<void>;
  /** Atomically bump `installed_version` and replace `config`. Used by the
   *  upload pipeline after a successful `onMigrate` run. Throws if the agent
   *  is not installed. */
  updateVersion(
    id: AgentId,
    newVersion: string,
    newConfig: Record<string, unknown>,
  ): Promise<void>;
}

function bumpFailure(
  current: InstalledAgent,
  error: string,
  nowIso: string,
  unresolvedRequires?: readonly string[],
): InstalledAgent {
  const prevCount = current.activation_failure_count ?? 0;
  const nextCount = prevCount + 1;
  const next: InstalledAgent = {
    ...current,
    activation_failure_count: nextCount,
    last_activation_error: error.slice(0, ERROR_TAIL_MAX),
    last_activation_error_at: nowIso,
  };
  if (unresolvedRequires && unresolvedRequires.length > 0) {
    next.unresolved_requires = [...unresolvedRequires];
  } else {
    delete next.unresolved_requires;
  }
  if (nextCount >= CIRCUIT_BREAKER_THRESHOLD) {
    next.status = 'errored';
  }
  return next;
}

function clearFailure(current: InstalledAgent): InstalledAgent {
  if (
    !current.activation_failure_count &&
    !current.last_activation_error &&
    !current.last_activation_error_at &&
    !current.unresolved_requires
  ) {
    return current;
  }
  const next = { ...current };
  delete next.activation_failure_count;
  delete next.last_activation_error;
  delete next.last_activation_error_at;
  delete next.unresolved_requires;
  return next;
}

/** Lift status:errored → status:active and remove every error field. */
function liftErrored(current: InstalledAgent): InstalledAgent {
  const next = clearFailure(current);
  if (next.status === 'errored') {
    return { ...next, status: 'active' };
  }
  return next;
}

export class InMemoryInstalledRegistry implements InstalledRegistry {
  private readonly agents = new Map<AgentId, InstalledAgent>();

  list(): InstalledAgent[] {
    return Array.from(this.agents.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  get(id: AgentId): InstalledAgent | undefined {
    return this.agents.get(id);
  }

  has(id: AgentId): boolean {
    return this.agents.has(id);
  }

  async register(entry: InstalledAgent): Promise<void> {
    this.agents.set(entry.id, entry);
  }

  async remove(id: AgentId): Promise<void> {
    this.agents.delete(id);
  }

  async markActivationFailed(
    id: AgentId,
    error: string,
    unresolvedRequires?: readonly string[],
  ): Promise<void> {
    const current = this.agents.get(id);
    if (!current) return;
    this.agents.set(
      id,
      bumpFailure(current, error, new Date().toISOString(), unresolvedRequires),
    );
  }

  async markActivationSucceeded(id: AgentId): Promise<void> {
    const current = this.agents.get(id);
    if (!current) return;
    this.agents.set(id, clearFailure(current));
  }

  async clearActivationError(id: AgentId): Promise<void> {
    const current = this.agents.get(id);
    if (!current) return;
    this.agents.set(id, liftErrored(current));
  }

  async updateConfig(
    id: AgentId,
    config: Record<string, unknown>,
  ): Promise<void> {
    const current = this.agents.get(id);
    if (!current) {
      throw new Error(`InstalledRegistry: no agent with id '${id}'`);
    }
    this.agents.set(id, { ...current, config });
  }

  async updateVersion(
    id: AgentId,
    newVersion: string,
    newConfig: Record<string, unknown>,
  ): Promise<void> {
    const current = this.agents.get(id);
    if (!current) {
      throw new Error(`InstalledRegistry: no agent with id '${id}'`);
    }
    this.agents.set(id, {
      ...current,
      installed_version: newVersion,
      config: newConfig,
    });
  }
}
