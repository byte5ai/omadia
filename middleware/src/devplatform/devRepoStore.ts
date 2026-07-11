/**
 * Epic #470 W0 — DevRepoStore: registered-repository persistence (spec §4/§6).
 *
 * Split out of `devJobStore.ts` to keep both files under the 500-line limit.
 * Secrets never live here: `credential_ref` is only a Vault key prefix (e.g.
 * `repo/<id>`); the token itself is written to Vault by `devRepoCredentials.ts`
 * (w0-onboarding). Repo rows carry no secret column, so a `DevRepo` is safe to
 * map straight from the row.
 */

import type { Pool } from 'pg';

import { asArr, asObj, iso, isoN, str, strN, type Row } from './pgMappers.js';
import type { DiffPolicyOverrides } from './policy/diffPolicyEngine.js';
import type { DevRepo, NewDevRepo } from './types.js';

const REPO_COLS =
  `id, forge_kind, owner, name, clone_url, default_branch, credential_kind, credential_ref, ` +
  `tracker_kind, tracker_config, allowed_triggers, allowed_launchers, egress_allowlist, ` +
  `runs_tests, branch_protection_ok, branch_protection_checked_at, approver_role_key, ` +
  `gate_deadline_iso, bootstrap_command, test_command, policy_overrides, ` +
  `trigger_label, webhook_enabled, webhook_senders, ` +
  `created_by, created_at, updated_at`;

function toRepo(r: Row): DevRepo {
  return {
    id: str(r['id']),
    forgeKind: str(r['forge_kind']),
    owner: str(r['owner']),
    name: str(r['name']),
    cloneUrl: str(r['clone_url']),
    defaultBranch: str(r['default_branch']),
    credentialKind: str(r['credential_kind']) as DevRepo['credentialKind'],
    credentialRef: str(r['credential_ref']),
    trackerKind: strN(r['tracker_kind']),
    trackerConfig: asObj(r['tracker_config'], {}),
    allowedTriggers: asArr(r['allowed_triggers']),
    allowedLaunchers: asArr(r['allowed_launchers']),
    egressAllowlist: asArr(r['egress_allowlist']),
    runsTests: Boolean(r['runs_tests']),
    branchProtectionOk: r['branch_protection_ok'] == null ? null : Boolean(r['branch_protection_ok']),
    branchProtectionCheckedAt: isoN(r['branch_protection_checked_at']),
    approverRoleKey: strN(r['approver_role_key']),
    gateDeadlineIso: str(r['gate_deadline_iso']),
    bootstrapCommand: strN(r['bootstrap_command']),
    testCommand: strN(r['test_command']),
    policyOverrides: asObj<DiffPolicyOverrides>(r['policy_overrides'], {}),
    triggerLabel: r['trigger_label'] == null ? 'omadia-dev' : str(r['trigger_label']),
    webhookEnabled: r['webhook_enabled'] == null ? true : Boolean(r['webhook_enabled']),
    webhookSenders: asArr(r['webhook_senders']),
    createdBy: str(r['created_by']),
    createdAt: iso(r['created_at']),
    updatedAt: iso(r['updated_at']),
  };
}

export class DevRepoStore {
  constructor(private readonly pool: Pool) {}

  async createRepo(input: NewDevRepo): Promise<DevRepo> {
    const r = await this.pool.query<Row>(
      `INSERT INTO dev_repos
         (forge_kind, owner, name, clone_url, default_branch, credential_kind, credential_ref,
          tracker_kind, tracker_config, allowed_triggers, allowed_launchers, egress_allowlist,
          runs_tests, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
       RETURNING ${REPO_COLS}`,
      [
        input.forgeKind ?? 'github',
        input.owner,
        input.name,
        input.cloneUrl,
        input.defaultBranch ?? 'main',
        input.credentialKind,
        input.credentialRef,
        input.trackerKind ?? null,
        JSON.stringify(input.trackerConfig ?? {}),
        input.allowedTriggers ?? ['admin'],
        input.allowedLaunchers ?? [],
        input.egressAllowlist ?? [],
        input.runsTests ?? true,
        input.createdBy,
      ],
    );
    return toRepo(r.rows[0]!);
  }

  async listRepos(): Promise<DevRepo[]> {
    const r = await this.pool.query<Row>(`SELECT ${REPO_COLS} FROM dev_repos ORDER BY created_at DESC`);
    return r.rows.map(toRepo);
  }

  async getRepo(id: string): Promise<DevRepo | null> {
    const r = await this.pool.query<Row>(`SELECT ${REPO_COLS} FROM dev_repos WHERE id = $1`, [id]);
    return r.rows[0] ? toRepo(r.rows[0]) : null;
  }

  async updateRepo(id: string, patch: Partial<NewDevRepo>): Promise<DevRepo | null> {
    const map: Record<string, [string, unknown, boolean]> = {
      forgeKind: ['forge_kind', patch.forgeKind, false],
      owner: ['owner', patch.owner, false],
      name: ['name', patch.name, false],
      cloneUrl: ['clone_url', patch.cloneUrl, false],
      defaultBranch: ['default_branch', patch.defaultBranch, false],
      credentialKind: ['credential_kind', patch.credentialKind, false],
      credentialRef: ['credential_ref', patch.credentialRef, false],
      trackerKind: ['tracker_kind', patch.trackerKind, false],
      trackerConfig: ['tracker_config', patch.trackerConfig, true],
      allowedTriggers: ['allowed_triggers', patch.allowedTriggers, false],
      allowedLaunchers: ['allowed_launchers', patch.allowedLaunchers, false],
      egressAllowlist: ['egress_allowlist', patch.egressAllowlist, false],
      runsTests: ['runs_tests', patch.runsTests, false],
      policyOverrides: ['policy_overrides', patch.policyOverrides, true],
      triggerLabel: ['trigger_label', patch.triggerLabel, false],
      webhookEnabled: ['webhook_enabled', patch.webhookEnabled, false],
      webhookSenders: ['webhook_senders', patch.webhookSenders, false],
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const key of Object.keys(patch) as (keyof NewDevRepo)[]) {
      const entry = map[key as string];
      if (!entry || entry[1] === undefined) continue;
      const [col, val, isJson] = entry;
      params.push(isJson ? JSON.stringify(val) : val);
      sets.push(`${col} = $${params.length}${isJson ? '::jsonb' : ''}`);
    }
    if (sets.length === 0) return this.getRepo(id);
    sets.push('updated_at = now()');
    const r = await this.pool.query<Row>(
      `UPDATE dev_repos SET ${sets.join(', ')} WHERE id = $1 RETURNING ${REPO_COLS}`,
      params,
    );
    return r.rows[0] ? toRepo(r.rows[0]) : null;
  }

  /** Persist the tri-state branch-protection result (spec §6; used by w0-onboarding). */
  async setBranchProtection(id: string, ok: boolean | null): Promise<DevRepo | null> {
    const r = await this.pool.query<Row>(
      `UPDATE dev_repos SET branch_protection_ok = $2, branch_protection_checked_at = now(),
              updated_at = now()
        WHERE id = $1 RETURNING ${REPO_COLS}`,
      [id, ok],
    );
    return r.rows[0] ? toRepo(r.rows[0]) : null;
  }

  async deleteRepo(id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM dev_repos WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
}
