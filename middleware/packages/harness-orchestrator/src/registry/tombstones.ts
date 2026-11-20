/**
 * #2088 — tombstones (migration 0072, spec 2042 §5.10).
 *
 * Deleting an agent marks its row (`agents.deleted_at`) instead of removing
 * it, and nothing that references the row is dropped. So every query has to
 * say whether it means live agents or all rows, and the default is LIVE:
 *
 *  - `agents` itself is read through `ConfigStore` only, which excludes
 *    tombstones in its one SELECT;
 *  - a query that lists a table referencing `agents` ACROSS agents (all
 *    grants, all schedules, …) excludes the rows of tombstones with
 *    {@link ofLiveAgent}. A per-agent query (`WHERE agent_id = $1`) needs
 *    nothing: its id came from a live agent;
 *  - four tables are deliberately read WITH tombstones, because a deleted
 *    agent must keep its place there: `channel_bindings` (a conversation
 *    bound to a deleted agent is refused, never handed to the default agent),
 *    the channel identities (a deleted agent's bot stays quiet, never answers
 *    as another agent), and #2055's `agent_default_entries` and
 *    `agent_selections` (an entry or a selection naming a deleted agent gives
 *    "<name> was deleted" until it is changed).
 *
 * `test/agentTombstoneReaders.test.ts` reads the source and fails when a
 * query on one of these tables does neither.
 *
 * The conditions go through `to_jsonb`, not the bare column, so they also
 * run on a database that has not applied migration 0072 yet (every row is
 * live there), like the config store's other early reads.
 */

/** SQL condition for a row of `agents` under `alias`: it is not a tombstone. */
export function liveAgentRow(alias: string): string {
  return `(to_jsonb(${alias}) ->> 'deleted_at') IS NULL`;
}

/**
 * SQL condition: `column` (an agent id) does not belong to a tombstone.
 *
 * `agents.id` is a uuid, and so are most columns that reference it. A table
 * that keeps the agent id as TEXT (the Teams identity tables of migration
 * 0049 and later, which have no foreign key to `agents`) says so with
 * `textColumn`: Postgres has no `text = uuid` operator and refuses the
 * statement otherwise. The uuid side is cast, never the column: such a
 * column may hold a value that is no uuid.
 */
export function ofLiveAgent(column: string, options: { readonly textColumn?: boolean } = {}): string {
  const id = options.textColumn ? 't.id::text' : 't.id';
  return `${column} NOT IN (SELECT ${id} FROM agents t WHERE (to_jsonb(t) ->> 'deleted_at') IS NOT NULL)`;
}

/** The slug a tombstone carries, so the name it had is free again. */
export function tombstoneSlug(agentId: string): string {
  return `deleted-${agentId.replace(/-/g, '').slice(0, 20)}`;
}

/** A deleted agent as the operator sees it. */
export interface AgentTombstone {
  readonly id: string;
  /** The slug it had while it lived. */
  readonly slug: string;
  readonly name: string;
  readonly archetype: string;
  /** ISO 8601. */
  readonly deletedAt: string;
  readonly deletedBy: string | null;
}
