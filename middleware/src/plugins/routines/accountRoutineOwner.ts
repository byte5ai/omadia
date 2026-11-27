/**
 * #1765 — which routine owner ids an admin-deleted account stands for.
 *
 * Web and API routines are owned by the session's `omadia_user_id`: the
 * person's User cluster in the knowledge graph, reached from the login
 * through its `web:<users.id>` ChannelIdentity — not `users.id` itself. The
 * cluster is the PERSON: other logins and channel identities of the same
 * person share it. Deleting one account removes the person's routines only
 * when this account is the person's only web login; otherwise the routines
 * stay with the person's other login (accepted, ADR 0244 notes it).
 * `users.id` is included as well (a routine filed under it directly).
 */

import type { Pool } from 'pg';

/** Whether a `users.id` still has a live account row. */
export type IsLiveAccount = (usersId: string) => Promise<boolean>;

const WEB_PREFIX = 'web:';

/**
 * `isLiveAccount` filters the person's other web logins: a ChannelIdentity
 * of an account deleted earlier stays in the graph, and must not keep the
 * person's routines alive forever. Without it every other login counts.
 */
export async function routineOwnerIdsForAccount(
  pool: Pick<Pool, 'query'>,
  tenantId: string,
  usersId: string,
  isLiveAccount?: IsLiveAccount,
): Promise<string[]> {
  const { rows } = await pool.query<{ omadia_user_id: string | null; other_web_logins: string[] | null }>(
    `SELECT (u.properties->>'omadiaUserId') AS omadia_user_id,
            ARRAY(SELECT ci2.external_id FROM graph_edges e2
               JOIN graph_nodes ci2 ON ci2.id = e2.from_node
              WHERE e2.to_node = u.id AND e2.type = 'IS_IDENTITY_OF'
                AND ci2.type = 'ChannelIdentity' AND ci2.tenant_id = $1
                AND ci2.external_id LIKE 'web:%' AND ci2.external_id <> $2) AS other_web_logins
       FROM graph_nodes ci
       JOIN graph_edges e ON e.from_node = ci.id AND e.type = 'IS_IDENTITY_OF'
       JOIN graph_nodes u ON u.id = e.to_node AND u.type = 'User'
      WHERE ci.tenant_id = $1 AND ci.external_id = $2 AND ci.type = 'ChannelIdentity'
      ORDER BY u.id
      LIMIT 1`,
    [tenantId, `${WEB_PREFIX}${usersId}`],
  );
  const row = rows[0];
  const ids = [usersId];
  if (!row?.omadia_user_id || row.omadia_user_id === usersId) return ids;
  const others = (row.other_web_logins ?? []).map((ext) => ext.slice(WEB_PREFIX.length));
  const live = isLiveAccount
    ? (await Promise.all(others.map((id) => isLiveAccount(id)))).filter(Boolean).length
    : others.length;
  if (live === 0) ids.push(row.omadia_user_id);
  return ids;
}
