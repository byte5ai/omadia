-- #2278 — memorable knowledge derived from an unprotected turn carries the
-- stamp itself.
--
-- Recall under a Privacy Shield skips a MemorableKnowledge row stamped
-- `unprotected` or with a DERIVED_FROM edge to a Turn stored `unprotected`
-- (#1536, `mkProtectedSql`). Auto-promotion never set the stamp, so for every
-- promoted memory the edge was the only mark, and the edge goes when the Turn
-- is deleted (user purge, ADR-0186; history purge). The memory then reached
-- shielded turns with values no shield masked. `createMemorableKnowledge` now
-- stamps new rows; this migration stamps the existing ones while their Turn
-- is still there.
--
-- A memory whose unprotected Turn was already deleted before this migration
-- has no mark left to find and stays as it is.
--
-- Idempotent: a re-run finds no unstamped row with such an edge.

UPDATE graph_nodes mk
   SET properties = mk.properties || '{"unprotected": true}'::jsonb
 WHERE mk.type = 'MemorableKnowledge'
   AND COALESCE((mk.properties->>'unprotected')::boolean, FALSE) = FALSE
   AND EXISTS (
     SELECT 1 FROM graph_edges d
       JOIN graph_nodes src ON src.id = d.to_node AND src.type = 'Turn'
      WHERE d.tenant_id = mk.tenant_id
        AND d.type = 'DERIVED_FROM'
        AND d.from_node = mk.id
        AND COALESCE((src.properties->>'unprotected')::boolean, FALSE));
