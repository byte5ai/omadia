import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  INTERN_EXEMPT_OPERATIONS,
  INTERN_EXEMPT_TOOLS,
  PROMPT_MASKED_UPLOAD_TOOLS,
  isInternExemptCall,
  isInternExemptTool,
  isPromptMaskedUploadCall,
  runsOnModelInput,
} from '@omadia/orchestrator/dist/privacyInternPolicy.js';

import { isPubliclyServableTool } from '../src/mcp/publicMcpPrivacy.js';

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
    // #268 — user-uploaded attachment the agent was asked to read; not a
    // specialist-agent PII source.
    'read_attachment',
    // #1967 — the agent's own produced files: metadata only, no cell value.
    'render_diagram',
    'create_xlsx',
    'create_docx',
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
    // #361 acceptance pin — MCP-sourced tools (adapted via
    // `mcpNativeToolName` → `mcp__<server>__<tool>`, or exposed through a
    // sub-agent toolkit) dispatch through the same choke points as
    // first-party tools and MUST stay interned via `internToolResultV4`.
    'mcp__strava__get_activities',
    'mcp__confluence__search_pages',
    // Only some operations are exempt (ADR-0197) / prompt-masked (ADR-0198).
    'query_dataset',
    'transcribe_recording',
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

  it('runs file producers on restored values, scaffolding on the model input', () => {
    for (const name of ['render_diagram', 'create_xlsx', 'create_docx']) {
      assert.equal(runsOnModelInput(name), false, `${name} must get the restored input`);
    }
    for (const name of ['memory', 'read_attachment', 'write_process']) {
      assert.equal(runsOnModelInput(name), true, `${name} keeps the model input`);
    }
    assert.equal(runsOnModelInput('dynamics_query'), false);
  });

  describe('per-operation exemptions (ADR-0197, #1866)', () => {
    it('exempts query_dataset metadata operations, never query_rows', () => {
      assert.equal(isInternExemptCall('query_dataset', { query: 'list_datasets' }), true);
      assert.equal(
        isInternExemptCall('query_dataset', { query: 'get_schema', dataset_id: 'x' }),
        true,
      );
      assert.equal(
        isInternExemptCall('query_dataset', { query: 'query_rows', dataset_id: 'x' }),
        false,
      );
    });

    it('fails closed on a missing or malformed operation', () => {
      for (const input of [undefined, null, 'list_datasets', {}, { query: 7 }, { query: 'LIST_DATASETS' }]) {
        assert.equal(isInternExemptCall('query_dataset', input), false, JSON.stringify(input));
      }
    });

    it('does not grant an operation of one tool to another', () => {
      assert.equal(isInternExemptCall('dynamics_query', { query: 'list_datasets' }), false);
    });

    it('keeps whole-tool exemptions independent of the input', () => {
      assert.equal(isInternExemptCall('memory', undefined), true);
      assert.equal(isInternExemptCall('render_diagram', { kind: 'mermaid' }), true);
    });

    it('lists exactly the documented operations (no drift)', () => {
      assert.deepEqual(
        [...INTERN_EXEMPT_OPERATIONS].map(([tool, rule]) => [tool, rule.field, [...rule.operations].sort()]),
        [['query_dataset', 'query', ['get_schema', 'list_datasets']]],
      );
    });
  });

  describe('prompt-masked uploads (ADR-0198, #1985)', () => {
    const keys = new Set(['uploads/turn/rec-1.wav']);

    it('prompt-masks a transcript of an upload from this turn', () => {
      assert.equal(
        isPromptMaskedUploadCall('transcribe_recording', { storage_key: 'uploads/turn/rec-1.wav' }, keys),
        true,
      );
    });

    it('keeps a transcript of any other stored file interned (#1960)', () => {
      assert.equal(
        isPromptMaskedUploadCall('transcribe_recording', { storage_key: 'uploads/other/chat.wav' }, keys),
        false,
      );
      assert.equal(
        isPromptMaskedUploadCall('transcribe_recording', { storage_key: 'uploads/turn/rec-1.wav' }, undefined),
        false,
      );
      assert.equal(isPromptMaskedUploadCall('transcribe_recording', {}, keys), false);
    });

    it('applies to the listed tools only', () => {
      assert.deepEqual([...PROMPT_MASKED_UPLOAD_TOOLS], [['transcribe_recording', 'storage_key']]);
      assert.equal(
        isPromptMaskedUploadCall('read_attachment', { storage_key: 'uploads/turn/rec-1.wav' }, keys),
        false,
      );
    });
  });

  describe('public MCP servability', () => {
    it('never serves intern-exempt tools or tools with exempt operations', () => {
      for (const name of ['memory', 'read_attachment', 'query_processes', 'query_dataset']) {
        assert.equal(isPubliclyServableTool(name), false, `${name} must not be public`);
      }
    });

    it('serves the file producers behind the per-result check (#2305, ADR-0271)', () => {
      for (const name of ['render_diagram', 'create_xlsx', 'create_docx']) {
        assert.equal(isPubliclyServableTool(name), true, `${name} is public again`);
      }
    });

    it('keeps guarded tools servable', () => {
      assert.equal(isPubliclyServableTool('dynamics_query'), true);
    });
  });
});

describe('#1768 / ADR 0241 — field-level interning exemption', () => {
  it('lists manage_routine only, withholding its free text', async () => {
    const { INTERN_FIELD_EXEMPT_TOOLS } = await import('@omadia/orchestrator/dist/privacyInternPolicy.js');
    assert.deepEqual([...INTERN_FIELD_EXEMPT_TOOLS.keys()], ['manage_routine']);
    assert.equal(isInternExemptTool('manage_routine'), false, 'not exempt as a whole');
  });

  it('hands the operational state over in clear and drops prompt/lastRunError at every depth', async () => {
    const { fieldExemptModelCopy } = await import('@omadia/orchestrator/dist/privacyInternPolicy.js');
    const raw = JSON.stringify({
      action: 'list',
      routines: [
        { id: 'r1', name: 'report-alt', cron: '0 3 1 1 *', status: 'paused', prompt: 'Sag Hallo an Max Mustermann', lastRunError: 'max@example.com unreachable' },
      ],
      _pendingRoutineList: { routines: [{ prompt: 'Sag Hallo an Max Mustermann' }] },
    });
    const copy = fieldExemptModelCopy('manage_routine', raw);
    assert.ok(copy);
    const parsed = JSON.parse(copy) as { action: string; routines: Array<Record<string, unknown>> };
    assert.equal(parsed.action, 'list');
    assert.deepEqual(parsed.routines[0], { id: 'r1', name: 'report-alt', cron: '0 3 1 1 *', status: 'paused' });
    assert.doesNotMatch(copy, /Mustermann|example\.com|_pendingRoutineList/);
  });

  it('does not project a non-JSON result or another tool (they are interned as usual)', async () => {
    const { fieldExemptModelCopy } = await import('@omadia/orchestrator/dist/privacyInternPolicy.js');
    assert.equal(fieldExemptModelCopy('manage_routine', 'Error: routine not found'), undefined);
    assert.equal(fieldExemptModelCopy('manage_routine', '"just a string"'), undefined);
    assert.equal(fieldExemptModelCopy('odoo_search', '{"name":"x"}'), undefined);
  });

  it('keeps a field-exempt tool off the public MCP endpoint (ADR 0142)', async () => {
    const { isPubliclyServableTool } = await import('../src/mcp/publicMcpPrivacy.js');
    assert.equal(isPubliclyServableTool('manage_routine'), false);
  });
});
