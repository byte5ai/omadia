import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  INTERN_EXEMPT_TOOLS,
  isInternExemptTool,
} from '@omadia/orchestrator/dist/privacyInternPolicy.js';

/**
 * Guards the Privacy Shield interning boundary. The agent's own
 * infrastructure/self tools must be read in clear; every external/PII
 * data-source tool must stay interned. This test locks both halves so a
 * later edit can't silently widen the exemption (leaking external data to
 * the LLM) or narrow it (re-blinding the agent to its own memory).
 */
describe('privacyInternPolicy', () => {
  const EXEMPT = [
    'memory',
    'query_processes',
    'run_stored_process',
    'write_process',
    'edit_process',
    'suggest_follow_ups',
    'ask_user_choice',
  ];

  const GUARDED = [
    // Deliberately NOT exempt — can carry external/PII data.
    'query_knowledge_graph',
    'chat_participants',
    'find_free_slots',
    'book_meeting',
    // Domain/plugin data tools.
    'dynamics_query',
    'dynamics_describe',
    'odoo_search',
    'enrich_company',
    'web_search',
  ];

  it('exempts exactly the agent self/infra tools', () => {
    for (const name of EXEMPT) {
      assert.equal(isInternExemptTool(name), true, `${name} must be exempt`);
    }
  });

  it('keeps external/data-source tools guarded (interned)', () => {
    for (const name of GUARDED) {
      assert.equal(
        isInternExemptTool(name),
        false,
        `${name} must stay guarded`,
      );
    }
  });

  it('allowlist contents are exactly the documented set (no drift)', () => {
    assert.deepEqual([...INTERN_EXEMPT_TOOLS].sort(), [...EXEMPT].sort());
  });

  it('is case-sensitive and does not exempt unknown tools', () => {
    assert.equal(isInternExemptTool('Memory'), false);
    assert.equal(isInternExemptTool('totally_unknown_tool'), false);
  });
});
