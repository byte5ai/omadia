/**
 * #2319 / ADR-0290 — which credentials an agent may name through the kernel
 * capability `credentialBroker@1`.
 *
 * Two layers, both required on every call:
 *  1. this grant (operator → agent, named credentials only, no wildcard) —
 *     the coarse gate the channel-sdk header calls `credential:broker:use`;
 *  2. the per-principal `CredentialGrant` the broker itself checks
 *     (ADR-0102), for the account the turn speaks for (ADR-0355).
 *
 * Offering the tools reads a snapshot (`isAvailable` is synchronous); every
 * call reads the store live, so a revoked grant stops the next call even
 * while a stale snapshot still offers the tool.
 *
 * Also the delivery store for asks: where the owner's decision goes back to.
 */

import type { Pool } from 'pg';

export interface AgentCredentialGrant {
  readonly agentId: string;
  readonly credentialId: string;
  readonly grantedBy: string;
  readonly grantedAt: Date;
}

/** #2319 / ADR-0290 — one credential an agent may reach through `credentialBroker@1`. */
export interface AgentCredentialReach {
  readonly credentialId: string;
  readonly name: string;
  readonly kind: string;
  /** The declared host a `service` credential may be sent to; null for `personal`. */
  readonly host: string | null;
}

export interface AgentCredentialGrantStore {
  list(agentId: string): Promise<readonly AgentCredentialGrant[]>;
  listAll(): Promise<readonly AgentCredentialGrant[]>;
  /** Idempotent: `created` is false when the grant already existed. */
  put(agentId: string, credentialId: string, grantedBy: string): Promise<{ grant: AgentCredentialGrant; created: boolean }>;
  /** @returns whether a grant was actually removed. */
  remove(agentId: string, credentialId: string): Promise<boolean>;
}

interface GrantRow {
  agent_id: string;
  credential_id: string;
  granted_by: string;
  granted_at: Date;
}

function toGrant(row: GrantRow): AgentCredentialGrant {
  return { agentId: row.agent_id, credentialId: row.credential_id, grantedBy: row.granted_by, grantedAt: row.granted_at };
}

export class PostgresAgentCredentialGrantStore implements AgentCredentialGrantStore {
  constructor(private readonly pool: Pool) {}

  async list(agentId: string): Promise<readonly AgentCredentialGrant[]> {
    const { rows } = await this.pool.query<GrantRow>(
      `SELECT agent_id, credential_id, granted_by, granted_at FROM agent_credential_grants
        WHERE agent_id = $1 ORDER BY granted_at`,
      [agentId],
    );
    return rows.map(toGrant);
  }

  async listAll(): Promise<readonly AgentCredentialGrant[]> {
    const { rows } = await this.pool.query<GrantRow>(
      'SELECT agent_id, credential_id, granted_by, granted_at FROM agent_credential_grants',
    );
    return rows.map(toGrant);
  }

  async put(agentId: string, credentialId: string, grantedBy: string): Promise<{ grant: AgentCredentialGrant; created: boolean }> {
    const inserted = await this.pool.query<GrantRow>(
      `INSERT INTO agent_credential_grants (agent_id, credential_id, granted_by)
       VALUES ($1, $2, $3) ON CONFLICT (agent_id, credential_id) DO NOTHING
       RETURNING agent_id, credential_id, granted_by, granted_at`,
      [agentId, credentialId, grantedBy],
    );
    const row = inserted.rows[0];
    if (row) return { grant: toGrant(row), created: true };
    const { rows } = await this.pool.query<GrantRow>(
      `SELECT agent_id, credential_id, granted_by, granted_at FROM agent_credential_grants
        WHERE agent_id = $1 AND credential_id = $2`,
      [agentId, credentialId],
    );
    const existing = rows[0];
    if (!existing) throw new Error('agent credential grant vanished between insert and read');
    return { grant: toGrant(existing), created: false };
  }

  async remove(agentId: string, credentialId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM agent_credential_grants WHERE agent_id = $1 AND credential_id = $2',
      [agentId, credentialId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

/** For pool-less deployments and tests; lost on restart, like the in-memory keychain. */
export class InMemoryAgentCredentialGrantStore implements AgentCredentialGrantStore {
  private readonly grants = new Map<string, AgentCredentialGrant>();

  private static key(agentId: string, credentialId: string): string {
    return `${agentId}\u0000${credentialId}`;
  }

  async list(agentId: string): Promise<readonly AgentCredentialGrant[]> {
    return [...this.grants.values()].filter((g) => g.agentId === agentId);
  }

  async listAll(): Promise<readonly AgentCredentialGrant[]> {
    return [...this.grants.values()];
  }

  async put(agentId: string, credentialId: string, grantedBy: string): Promise<{ grant: AgentCredentialGrant; created: boolean }> {
    const key = InMemoryAgentCredentialGrantStore.key(agentId, credentialId);
    const existing = this.grants.get(key);
    if (existing) return { grant: existing, created: false };
    const grant: AgentCredentialGrant = { agentId, credentialId, grantedBy, grantedAt: new Date() };
    this.grants.set(key, grant);
    return { grant, created: true };
  }

  async remove(agentId: string, credentialId: string): Promise<boolean> {
    return this.grants.delete(InMemoryAgentCredentialGrantStore.key(agentId, credentialId));
  }
}

/** How often the offering snapshot reloads on its own (other machines' writes). */
export const AGENT_CREDENTIAL_SNAPSHOT_TTL_MS = 60_000;

/**
 * The agents that hold at least one grant, for the synchronous offer gate.
 * A failed reload keeps the previous snapshot and logs: offering is not
 * enforcement (the handler reads the store live), so a stale "offered" only
 * costs a refused call, never an unauthorised one.
 */
export class AgentCredentialGrantSnapshot {
  private agents: ReadonlySet<string> = new Set();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: AgentCredentialGrantStore,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  hasAnyGrant(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  async refresh(): Promise<void> {
    try {
      const all = await this.store.listAll();
      this.agents = new Set(all.map((g) => g.agentId));
    } catch (err) {
      this.log(`[credential-broker] grant snapshot reload failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  start(intervalMs: number = AGENT_CREDENTIAL_SNAPSHOT_TTL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Where the owner's decision on an ask is posted back to. */
export interface CredentialAskDelivery {
  readonly askId: string;
  readonly agentId: string;
  readonly channel: string;
  readonly conversationRef: unknown;
}

export interface CredentialAskDeliveryStore {
  put(delivery: CredentialAskDelivery): Promise<void>;
  /** Reads and removes the delivery in one step, so a decision is posted at most once. */
  take(askId: string): Promise<CredentialAskDelivery | undefined>;
}

interface DeliveryRow {
  ask_id: string;
  agent_id: string;
  channel: string;
  conversation_ref: unknown;
}

export class PostgresCredentialAskDeliveryStore implements CredentialAskDeliveryStore {
  constructor(private readonly pool: Pool) {}

  async put(delivery: CredentialAskDelivery): Promise<void> {
    await this.pool.query(
      `INSERT INTO credential_ask_deliveries (ask_id, agent_id, channel, conversation_ref)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (ask_id) DO NOTHING`,
      [delivery.askId, delivery.agentId, delivery.channel, JSON.stringify(delivery.conversationRef ?? null)],
    );
  }

  async take(askId: string): Promise<CredentialAskDelivery | undefined> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `DELETE FROM credential_ask_deliveries WHERE ask_id = $1
       RETURNING ask_id, agent_id, channel, conversation_ref`,
      [askId],
    );
    const row = rows[0];
    return row
      ? { askId: row.ask_id, agentId: row.agent_id, channel: row.channel, conversationRef: row.conversation_ref }
      : undefined;
  }
}

export class InMemoryCredentialAskDeliveryStore implements CredentialAskDeliveryStore {
  private readonly deliveries = new Map<string, CredentialAskDelivery>();

  async put(delivery: CredentialAskDelivery): Promise<void> {
    if (!this.deliveries.has(delivery.askId)) this.deliveries.set(delivery.askId, delivery);
  }

  async take(askId: string): Promise<CredentialAskDelivery | undefined> {
    const delivery = this.deliveries.get(askId);
    this.deliveries.delete(askId);
    return delivery;
  }
}
