import 'dotenv/config';
import { createKnowledgeGraph } from '../src/services/graph/index.js';

const { pool } = await createKnowledgeGraph({ log: () => undefined });
if (pool) {
  await pool.query(
    `DELETE FROM graph_nodes
     WHERE tenant_id = $1
       AND (scope = 'e2e-verify'
            OR external_id IN ('session:e2e-verify', 'user:e2e-user', 'odoo:hr.employee:999'))`,
    [process.env['GRAPH_TENANT_ID'] ?? 'default'],
  );
  await pool.end();
  console.log('cleaned');
}
