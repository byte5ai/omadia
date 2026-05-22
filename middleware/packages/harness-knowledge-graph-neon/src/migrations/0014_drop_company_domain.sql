BEGIN;

-- Slice 1a — purge NorthData/OpenRegister domain (Company / Person /
-- FinancialSnapshot nodes + 5 commercial-register edges). Schema is single-
-- table, so we delete by `type` rather than dropping a table.

DELETE FROM graph_edges
WHERE type IN ('MANAGES', 'SHAREHOLDER_OF', 'SUCCEEDED_BY', 'HAS_FINANCIALS', 'REFERS_TO');

DELETE FROM graph_nodes
WHERE type IN ('Company', 'Person', 'FinancialSnapshot');

DO $$
DECLARE
  remaining_nodes INT;
  remaining_edges INT;
BEGIN
  SELECT count(*) INTO remaining_nodes
  FROM graph_nodes
  WHERE type IN ('Company', 'Person', 'FinancialSnapshot');

  SELECT count(*) INTO remaining_edges
  FROM graph_edges
  WHERE type IN ('MANAGES', 'SHAREHOLDER_OF', 'SUCCEEDED_BY', 'HAS_FINANCIALS', 'REFERS_TO');

  IF remaining_nodes > 0 OR remaining_edges > 0 THEN
    RAISE EXCEPTION 'Slice 1a purge incomplete: % nodes, % edges remain', remaining_nodes, remaining_edges;
  END IF;
END $$;

COMMIT;
