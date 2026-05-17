import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseAgentSpec,
  validateSpecForCodegen,
  registerAgentTemplate,
  getKnownAgentTemplates,
} from '../../src/plugins/builder/agentSpec.js';

const validBase = {
  id: 'de.byte5.agent.weather',
  name: 'Weather Agent',
  description: 'Weather forecast agent',
  category: 'analysis',
  skill: { role: 'a weather expert' },
  playbook: { when_to_use: 'when user asks about weather' },
} as const;

describe('agentSpec', () => {
  describe('parseAgentSpec', () => {
    it('accepts a minimal valid spec and applies defaults', () => {
      const spec = parseAgentSpec(validBase);
      assert.equal(spec.template, 'agent-integration');
      assert.equal(spec.version, '0.1.0');
      assert.deepEqual(spec.depends_on, []);
      assert.deepEqual(spec.tools, []);
      assert.deepEqual(spec.slots, {});
      assert.deepEqual(spec.network.outbound, []);
      assert.deepEqual(spec.playbook.not_for, []);
      assert.deepEqual(spec.playbook.example_prompts, []);
    });

    it('rejects an invalid agent id (uppercase)', () => {
      assert.throws(() => parseAgentSpec({ ...validBase, id: 'INVALID_ID' }));
    });

    it('rejects an invalid agent id (starting with digit)', () => {
      assert.throws(() => parseAgentSpec({ ...validBase, id: '1foo' }));
    });

    it('rejects unknown top-level keys via strict()', () => {
      assert.throws(() => parseAgentSpec({ ...validBase, extra_field: 'x' }));
    });

    it('rejects setup_field type "password" (not in allowed enum)', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          setup_fields: [{ key: 'pw', type: 'password', required: true }],
        }),
      );
    });

    it('accepts setup_field type "secret"', () => {
      const spec = parseAgentSpec({
        ...validBase,
        setup_fields: [{ key: 'api_key', type: 'secret', required: true }],
      });
      assert.equal(spec.setup_fields[0]?.type, 'secret');
    });

    it('rejects an unknown template id', () => {
      assert.throws(() =>
        parseAgentSpec({ ...validBase, template: 'nonexistent-template' }),
      );
    });

    it('rejects an invalid tool id (uppercase)', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          tools: [{ id: 'BadName', description: 'x', input: { type: 'object' } }],
        }),
      );
    });

    it('rejects an invalid version (non-semver)', () => {
      assert.throws(() => parseAgentSpec({ ...validBase, version: '1.0' }));
    });

    it('accepts an optional admin_ui_path with the recommended shape', () => {
      const spec = parseAgentSpec({
        ...validBase,
        admin_ui_path: '/api/de.byte5.agent.weather/admin/index.html',
      });
      assert.equal(
        spec.admin_ui_path,
        '/api/de.byte5.agent.weather/admin/index.html',
      );
    });

    it('omits admin_ui_path when not provided (Optional Admin-UI)', () => {
      const spec = parseAgentSpec(validBase);
      assert.equal(spec.admin_ui_path, undefined);
    });

    it('rejects admin_ui_path that does not start with `/`', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          admin_ui_path: 'api/x/admin/index.html',
        }),
      );
    });

    it('rejects admin_ui_path with a protocol scheme', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          admin_ui_path: 'https://example.com/admin/index.html',
        }),
      );
    });

    it('roundtrips a complete spec through JSON', () => {
      const initial = parseAgentSpec({
        ...validBase,
        version: '1.2.3',
        depends_on: ['de.byte5.integration.openweather'],
        tools: [
          {
            id: 'get_forecast',
            description: 'Fetch the forecast',
            input: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
        setup_fields: [{ key: 'api_key', type: 'secret', required: true }],
        playbook: {
          when_to_use: 'weather questions',
          not_for: ['historical climate data'],
          example_prompts: ['Wie wird das Wetter morgen?'],
        },
        network: { outbound: ['api.openweather.org'] },
        slots: { 'client-impl': 'class Client {}', 'toolkit-impl': 'export const tools = []' },
      });
      const json: unknown = JSON.parse(JSON.stringify(initial));
      const reparsed = parseAgentSpec(json);
      assert.deepEqual(reparsed, initial);
    });

    it('defaults builder_settings.auto_fix_enabled to false when omitted (Option-C)', () => {
      const spec = parseAgentSpec(validBase);
      assert.deepEqual(spec.builder_settings, { auto_fix_enabled: false });
    });

    it('accepts builder_settings.auto_fix_enabled = true', () => {
      const spec = parseAgentSpec({
        ...validBase,
        builder_settings: { auto_fix_enabled: true },
      });
      assert.equal(spec.builder_settings.auto_fix_enabled, true);
    });

    it('rejects unknown keys inside builder_settings via strict()', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          builder_settings: { auto_fix_enabled: false, retry_limit: 5 },
        }),
      );
    });

    it('accepts depends_on with npm-scoped names alongside reverse-FQDN', () => {
      // Catch-22 regression for the platform-ID-bifurcation: AgentIdSchema
      // (reverse-FQDN only) was previously also gating depends_on, so
      // Builder-emitted plugins literally could not reference any of the
      // legacy `@omadia/*`-namespaced plugins (`@omadia/memory`,
      // `@omadia/agent-seo-analyst`, etc.) — Zod failed before the
      // manifestLinter even got a chance to check the installed catalog.
      const spec = parseAgentSpec({
        ...validBase,
        depends_on: ['@omadia/agent-seo-analyst', 'de.byte5.integration.odoo'],
      });
      assert.deepEqual(spec.depends_on, [
        '@omadia/agent-seo-analyst',
        'de.byte5.integration.odoo',
      ]);
    });

    it('still rejects malformed depends_on entries', () => {
      assert.throws(() =>
        parseAgentSpec({ ...validBase, depends_on: ['Has Caps'] }),
      );
      assert.throws(() =>
        parseAgentSpec({ ...validBase, depends_on: ['no-scope/name'] }),
      );
    });

    it('accepts spec.jobs with cron + interval schedules', () => {
      const spec = parseAgentSpec({
        ...validBase,
        jobs: [
          {
            name: 'weekly-digest',
            schedule: { cron: '0 8 * * MON' },
            timeoutMs: 60_000,
            overlap: 'skip',
          },
          { name: 'poll', schedule: { intervalMs: 30_000 } },
        ],
      });
      assert.equal(spec.jobs.length, 2);
      assert.equal(spec.jobs[0]?.name, 'weekly-digest');
    });

    it('rejects job names that are not kebab-case', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          jobs: [{ name: 'Weekly Digest', schedule: { cron: '* * * * *' } }],
        }),
      );
    });

    it('accepts spec.permissions with all three sub-blocks (Phase B)', () => {
      const spec = parseAgentSpec({
        ...validBase,
        permissions: {
          graph: {
            entity_systems: ['audit-reports'],
            reads: ['Turn', 'Person'],
            writes: [],
          },
          subAgents: {
            calls: ['@omadia/agent-seo-analyst', 'de.byte5.agent.compliance'],
            calls_per_invocation: 3,
          },
          llm: {
            models_allowed: ['claude-haiku-4-5*'],
            calls_per_invocation: 2,
            max_tokens_per_call: 1024,
          },
        },
      });
      assert.deepEqual(spec.permissions?.graph?.entity_systems, ['audit-reports']);
      assert.equal(spec.permissions?.subAgents?.calls.length, 2);
      assert.equal(spec.permissions?.llm?.max_tokens_per_call, 1024);
    });

    it('permissions.subAgents.calls accepts both ID formats (mirrors depends_on)', () => {
      const spec = parseAgentSpec({
        ...validBase,
        permissions: {
          subAgents: {
            calls: ['@omadia/agent-x', 'de.byte5.agent.y'],
          },
        },
      });
      assert.equal(spec.permissions?.subAgents?.calls.length, 2);
    });

    it('rejects llm models_allowed with non-positive caps', () => {
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          permissions: {
            llm: { models_allowed: ['claude-haiku-4-5'], calls_per_invocation: 0 },
          },
        }),
      );
      assert.throws(() =>
        parseAgentSpec({
          ...validBase,
          permissions: {
            llm: { models_allowed: ['claude-haiku-4-5'], max_tokens_per_call: -1 },
          },
        }),
      );
    });

    it('permissions block is optional — omitted means no gates set', () => {
      const spec = parseAgentSpec({ ...validBase });
      assert.equal(spec.permissions, undefined);
    });
  });

  describe('validateSpecForCodegen', () => {
    it('returns no issues for a clean spec', () => {
      const spec = parseAgentSpec({
        ...validBase,
        tools: [{ id: 'get_weather', description: 'x', input: { type: 'object' } }],
        depends_on: ['de.byte5.integration.openweather'],
      });
      assert.deepEqual(validateSpecForCodegen(spec), []);
    });

    it('flags a reserved exact tool id', () => {
      const spec = parseAgentSpec({
        ...validBase,
        tools: [{ id: 'query_memory', description: 'x', input: { type: 'object' } }],
      });
      const issues = validateSpecForCodegen(spec);
      assert.equal(issues.length, 1);
      assert.equal(issues[0]?.code, 'reserved_tool_id');
      assert.equal(issues[0]?.toolId, 'query_memory');
    });

    it('flags a reserved prefix tool id', () => {
      const spec = parseAgentSpec({
        ...validBase,
        tools: [{ id: 'query_odoo_invoices', description: 'x', input: { type: 'object' } }],
      });
      const issues = validateSpecForCodegen(spec);
      assert.equal(issues.length, 1);
      assert.equal(issues[0]?.code, 'reserved_tool_id');
    });

    it('flags duplicate tool ids', () => {
      const spec = parseAgentSpec({
        ...validBase,
        tools: [
          { id: 'foo', description: 'a', input: { type: 'object' } },
          { id: 'foo', description: 'b', input: { type: 'object' } },
        ],
      });
      const issues = validateSpecForCodegen(spec);
      assert.equal(issues.filter((i) => i.code === 'duplicate_tool_id').length, 1);
    });

    it('flags self-dependency', () => {
      const spec = parseAgentSpec({
        ...validBase,
        depends_on: [validBase.id],
      });
      const issues = validateSpecForCodegen(spec);
      assert.ok(issues.some((i) => i.code === 'self_dependency'));
    });

    it('reports multiple issues when present', () => {
      const spec = parseAgentSpec({
        ...validBase,
        depends_on: [validBase.id],
        tools: [
          { id: 'query_memory', description: 'x', input: { type: 'object' } },
          { id: 'foo', description: 'a', input: { type: 'object' } },
          { id: 'foo', description: 'b', input: { type: 'object' } },
        ],
      });
      const issues = validateSpecForCodegen(spec);
      assert.ok(issues.some((i) => i.code === 'reserved_tool_id'));
      assert.ok(issues.some((i) => i.code === 'duplicate_tool_id'));
      assert.ok(issues.some((i) => i.code === 'self_dependency'));
    });

    it('react-ssr slot in additionalSlots clears missing-component error (Catch-22 fix)', () => {
      // Regression guard: fillSlot writes to `draft.slots` (separate column
      // from `draft.spec.slots`). When the codegen pipeline then runs
      // validateSpecForCodegen on `draft.spec`, the freshly-written slot
      // is invisible via `spec.slots` and the react-ssr slot-check would
      // fire 'ui_route_react_ssr_missing_component_slot' on every call —
      // a Catch-22 that locked the agent out of react-ssr routes entirely.
      // Fix: the validator accepts an `additionalSlots` argument and
      // merges it before the existence check.
      const spec = parseAgentSpec({
        ...validBase,
        tools: [{ id: 'get_items', description: 'x', input: { type: 'object' } }],
        ui_routes: [
          {
            id: 'inbox',
            path: '/dashboard/inbox',
            tab_label: 'Inbox',
            page_title: 'Inbox',
            render_mode: 'react-ssr',
            interactive: true,
            data_binding: { source: 'tool', tool_id: 'get_items' },
          },
        ],
      });
      // Without additionalSlots → error fires (slot is on draft.slots, not spec.slots)
      const withoutAdditional = validateSpecForCodegen(spec);
      assert.ok(
        withoutAdditional.some((i) => i.code === 'ui_route_react_ssr_missing_component_slot'),
        'baseline: missing-slot must fire when neither spec.slots nor additionalSlots has the key',
      );
      // With additionalSlots → no error (mirrors what codegen.ts:646 now does)
      const withAdditional = validateSpecForCodegen(spec, {
        'ui-inbox-component':
          'export default function Page() { return <main data-omadia-page="inbox" />; }',
      });
      assert.ok(
        !withAdditional.some((i) => i.code === 'ui_route_react_ssr_missing_component_slot'),
        'Catch-22 fix: additionalSlots must satisfy the react-ssr slot-existence check',
      );
    });

    it('free-form-html slot in additionalSlots clears missing-render error', () => {
      const spec = parseAgentSpec({
        ...validBase,
        ui_routes: [
          {
            id: 'status',
            path: '/status',
            tab_label: 'Status',
            page_title: 'Status',
            render_mode: 'free-form-html',
          },
        ],
      });
      const withAdditional = validateSpecForCodegen(spec, {
        'ui-status-render': 'return html`<main>OK</main>`;',
      });
      assert.ok(
        !withAdditional.some((i) => i.code === 'ui_route_free_form_missing_render_slot'),
      );
    });
  });

  describe('template registry', () => {
    it('registers a new template id and accepts it via parseAgentSpec', () => {
      const before = getKnownAgentTemplates();
      assert.ok(!before.includes('agent-pure-compute'));

      registerAgentTemplate('agent-pure-compute');

      const after = getKnownAgentTemplates();
      assert.ok(after.includes('agent-pure-compute'));

      const spec = parseAgentSpec({ ...validBase, template: 'agent-pure-compute' });
      assert.equal(spec.template, 'agent-pure-compute');
    });

    it('rejects an empty template id at register-time', () => {
      assert.throws(() => registerAgentTemplate(''));
    });
  });
});
