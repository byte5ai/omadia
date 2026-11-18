import type { Pool } from 'pg';

/**
 * Who an omadia user id is, for the operator's memory browser.
 *
 * `members` notes are owned by KG user clusters (`omadiaUserId`), not by rows
 * of the `users` table. A cluster carries an optional `displayName`; its
 * channel identities may carry their own name and an email. The first
 * non-empty of those is shown — read-only, never used for access.
 */
export interface MemberName {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

export type ResolveMemberNames = (ids: readonly string[]) => Promise<Map<string, MemberName>>;

export function createMemberNameResolver(pool: Pool, tenantId: string): ResolveMemberNames {
  return async (ids) => {
    const out = new Map<string, MemberName>();
    if (ids.length === 0) return out;
    const res = await pool.query<{
      id: string;
      user_name: string | null;
      identity_names: string[] | null;
      emails: string[] | null;
    }>(
      `SELECT u.properties->>'omadiaUserId' AS id,
              u.properties->>'displayName' AS user_name,
              array_remove(array_agg(DISTINCT ci.properties->>'displayName'), NULL) AS identity_names,
              array_remove(array_agg(DISTINCT ci.properties->>'email'), NULL) AS emails
         FROM graph_nodes u
         LEFT JOIN graph_edges e ON e.to_node = u.id AND e.type = 'IS_IDENTITY_OF'
         LEFT JOIN graph_nodes ci ON ci.id = e.from_node AND ci.type = 'ChannelIdentity'
        WHERE u.tenant_id = $1
          AND u.type = 'User'
          AND u.properties->>'omadiaUserId' = ANY($2::text[])
        GROUP BY u.id`,
      [tenantId, [...ids]],
    );
    for (const row of res.rows) {
      out.set(row.id, {
        id: row.id,
        displayName: row.user_name ?? row.identity_names?.[0] ?? null,
        email: row.emails?.[0] ?? null,
      });
    }
    return out;
  };
}
