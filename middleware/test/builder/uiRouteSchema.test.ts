import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  UiRouteSchema,
  RenderModeSchema,
  UiTemplateSchema,
  DataBindingSchema,
  ItemTemplateSchema,
  isTabLabelValid,
} from '../../src/plugins/builder/uiRouteSchema.js';

import {
  parseAgentSpec,
  validateSpecForCodegen,
} from '../../src/plugins/builder/agentSpec.js';

import { validateSpec } from '../../src/plugins/builder/manifestLinter.js';

const validRouteBase = {
  id: 'inbox',
  path: '/dashboard',
  tab_label: 'PR Inbox',
  page_title: 'GitHub PR Inbox',
} as const;

const validSpecBase = {
  id: 'de.byte5.agent.github-prs',
  name: 'GitHub PR Inbox',
  description: 'PR inbox agent',
  category: 'productivity',
  domain: 'dev.github',
  skill: { role: 'PR inbox assistant' },
  playbook: { when_to_use: 'when user asks about PRs' },
  tools: [
    { id: 'list_my_open_prs', description: 'Lists open PRs', input: {} },
  ],
} as const;

describe('UiRouteSchema', () => {
  describe('basic parsing + defaults', () => {
    it('accepts a minimal valid route and applies defaults', () => {
      const parsed = UiRouteSchema.parse(validRouteBase);
      assert.equal(parsed.id, 'inbox');
      assert.equal(parsed.render_mode, 'library');
      assert.equal(parsed.refresh_seconds, 60);
      assert.equal(parsed.interactive, false);
      assert.equal(parsed.ui_template, undefined);
      assert.equal(parsed.data_binding, undefined);
    });

    it('accepts all three render modes', () => {
      for (const mode of ['library', 'react-ssr', 'free-form-html'] as const) {
        const parsed = UiRouteSchema.parse({ ...validRouteBase, render_mode: mode });
        assert.equal(parsed.render_mode, mode);
      }
    });

    it('accepts refresh_seconds=0 (no auto-refresh)', () => {
      const parsed = UiRouteSchema.parse({ ...validRouteBase, refresh_seconds: 0 });
      assert.equal(parsed.refresh_seconds, 0);
    });

    it('rejects unknown top-level keys via strict()', () => {
      assert.throws(() =>
        UiRouteSchema.parse({ ...validRouteBase, unknown_field: 'oops' }),
      );
    });
  });

  describe('id validation', () => {
    it('rejects uppercase id', () => {
      assert.throws(() => UiRouteSchema.parse({ ...validRouteBase, id: 'Inbox' }));
    });

    it('rejects id starting with digit', () => {
      assert.throws(() => UiRouteSchema.parse({ ...validRouteBase, id: '1inbox' }));
    });

    it('rejects id with underscore (slot-key uses dashes)', () => {
      assert.throws(() => UiRouteSchema.parse({ ...validRouteBase, id: 'my_inbox' }));
    });

    it('accepts dashed slug', () => {
      const parsed = UiRouteSchema.parse({ ...validRouteBase, id: 'pr-inbox' });
      assert.equal(parsed.id, 'pr-inbox');
    });
  });

  describe('path validation', () => {
    it('rejects path without leading slash', () => {
      assert.throws(() => UiRouteSchema.parse({ ...validRouteBase, path: 'dashboard' }));
    });

    it('rejects path with trailing slash', () => {
      assert.throws(() => UiRouteSchema.parse({ ...validRouteBase, path: '/dashboard/' }));
    });

    it('rejects path with uppercase characters', () => {
      assert.throws(() => UiRouteSchema.parse({ ...validRouteBase, path: '/Dashboard' }));
    });

    it('accepts nested paths', () => {
      const parsed = UiRouteSchema.parse({ ...validRouteBase, path: '/team/inbox' });
      assert.equal(parsed.path, '/team/inbox');
    });
  });

  describe('tab_label + page_title constraints', () => {
    it('enforces tab_label max 24 chars', () => {
      assert.throws(() =>
        UiRouteSchema.parse({ ...validRouteBase, tab_label: 'X'.repeat(25) }),
      );
    });

    it('enforces page_title max 80 chars', () => {
      assert.throws(() =>
        UiRouteSchema.parse({ ...validRouteBase, page_title: 'X'.repeat(81) }),
      );
    });

    it('rejects empty tab_label', () => {
      assert.throws(() => UiRouteSchema.parse({ ...validRouteBase, tab_label: '' }));
    });

    it('isTabLabelValid helper agrees with schema', () => {
      assert.equal(isTabLabelValid('PR Inbox'), true);
      assert.equal(isTabLabelValid(''), false);
      assert.equal(isTabLabelValid('   '), false);
      assert.equal(isTabLabelValid('X'.repeat(25)), false);
      assert.equal(isTabLabelValid('X'.repeat(24)), true);
    });
  });

  describe('refresh_seconds bounds', () => {
    it('rejects negative refresh_seconds', () => {
      assert.throws(() =>
        UiRouteSchema.parse({ ...validRouteBase, refresh_seconds: -1 }),
      );
    });

    it('rejects refresh_seconds above 3600', () => {
      assert.throws(() =>
        UiRouteSchema.parse({ ...validRouteBase, refresh_seconds: 3601 }),
      );
    });

    it('rejects non-integer refresh_seconds', () => {
      assert.throws(() =>
        UiRouteSchema.parse({ ...validRouteBase, refresh_seconds: 60.5 }),
      );
    });
  });

  describe('data_binding shape', () => {
    it('accepts a valid tool binding', () => {
      const parsed = UiRouteSchema.parse({
        ...validRouteBase,
        data_binding: { source: 'tool', tool_id: 'list_my_open_prs' },
      });
      assert.equal(parsed.data_binding?.tool_id, 'list_my_open_prs');
    });

    it('rejects non-tool source (future expansion not yet supported)', () => {
      assert.throws(() =>
        UiRouteSchema.parse({
          ...validRouteBase,
          data_binding: { source: 'service', tool_id: 'foo' },
        }),
      );
    });

    it('rejects tool_id with dashes (must be snake_case)', () => {
      assert.throws(() =>
        DataBindingSchema.parse({ source: 'tool', tool_id: 'list-prs' }),
      );
    });

    it('accepts optional args record', () => {
      const parsed = DataBindingSchema.parse({
        source: 'tool',
        tool_id: 'foo_bar',
        args: { org: 'byte5', limit: 10 },
      });
      assert.deepEqual(parsed.args, { org: 'byte5', limit: 10 });
    });
  });

  describe('item_template shape', () => {
    it('accepts minimal item_template (title only)', () => {
      const parsed = ItemTemplateSchema.parse({ title: '${item.title}' });
      assert.equal(parsed.title, '${item.title}');
    });

    it('rejects empty title', () => {
      assert.throws(() => ItemTemplateSchema.parse({ title: '' }));
    });

    it('rejects unknown fields via strict()', () => {
      assert.throws(() =>
        ItemTemplateSchema.parse({ title: '${item.title}', icon: 'foo' }),
      );
    });
  });

  describe('enum schemas', () => {
    it('RenderModeSchema accepts the three modes', () => {
      assert.equal(RenderModeSchema.parse('library'), 'library');
      assert.equal(RenderModeSchema.parse('react-ssr'), 'react-ssr');
      assert.equal(RenderModeSchema.parse('free-form-html'), 'free-form-html');
    });

    it('RenderModeSchema rejects unknown modes', () => {
      assert.throws(() => RenderModeSchema.parse('next-component'));
    });

    it('UiTemplateSchema accepts list-card and kpi-tiles', () => {
      assert.equal(UiTemplateSchema.parse('list-card'), 'list-card');
      assert.equal(UiTemplateSchema.parse('kpi-tiles'), 'kpi-tiles');
    });
  });
});

describe('AgentSpec integration', () => {
  it('legacy specs without ui_routes default to []', () => {
    const spec = parseAgentSpec(validSpecBase);
    assert.deepEqual(spec.ui_routes, []);
  });

  it('accepts a spec with one library-mode ui_route', () => {
    const spec = parseAgentSpec({
      ...validSpecBase,
      ui_routes: [
        {
          ...validRouteBase,
          render_mode: 'library',
          ui_template: 'list-card',
          data_binding: { source: 'tool', tool_id: 'list_my_open_prs' },
          item_template: { title: '${item.title}' },
        },
      ],
    });
    assert.equal(spec.ui_routes.length, 1);
    assert.equal(spec.ui_routes[0]?.render_mode, 'library');
  });

  it('serialises losslessly through JSON.stringify + parse', () => {
    const original = parseAgentSpec({
      ...validSpecBase,
      ui_routes: [validRouteBase],
    });
    const round = parseAgentSpec(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(round, original);
  });
});

describe('validateSpecForCodegen — ui_routes cross-checks', () => {
  function buildSpec(uiRoute: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return parseAgentSpec({
      ...validSpecBase,
      ...extra,
      ui_routes: [uiRoute],
    });
  }

  it('passes with a valid library + tool-binding route', () => {
    const spec = buildSpec({
      ...validRouteBase,
      render_mode: 'library',
      ui_template: 'list-card',
      data_binding: { source: 'tool', tool_id: 'list_my_open_prs' },
      item_template: { title: '${item.title}' },
    });
    const issues = validateSpecForCodegen(spec);
    assert.deepEqual(issues, []);
  });

  it('flags data_binding.tool_id pointing to a non-existent tool', () => {
    const spec = buildSpec({
      ...validRouteBase,
      render_mode: 'library',
      ui_template: 'list-card',
      data_binding: { source: 'tool', tool_id: 'nonexistent_tool' },
      item_template: { title: '${item.title}' },
    });
    const issues = validateSpecForCodegen(spec);
    const found = issues.find((i) => i.code === 'ui_route_data_binding_unknown_tool');
    assert.ok(found, 'expected ui_route_data_binding_unknown_tool issue');
    assert.equal(found?.routeId, 'inbox');
  });

  it('flags library-mode without ui_template', () => {
    const spec = buildSpec({
      ...validRouteBase,
      render_mode: 'library',
    });
    const issues = validateSpecForCodegen(spec);
    assert.ok(issues.some((i) => i.code === 'ui_route_library_missing_template'));
  });

  it('flags list-card without item_template', () => {
    const spec = buildSpec({
      ...validRouteBase,
      render_mode: 'library',
      ui_template: 'list-card',
    });
    const issues = validateSpecForCodegen(spec);
    assert.ok(issues.some((i) => i.code === 'ui_route_library_missing_item_template'));
  });

  it('flags react-ssr without component slot', () => {
    const spec = buildSpec({
      ...validRouteBase,
      render_mode: 'react-ssr',
    });
    const issues = validateSpecForCodegen(spec);
    assert.ok(issues.some((i) => i.code === 'ui_route_react_ssr_missing_component_slot'));
  });

  it('passes react-ssr when component slot is filled', () => {
    const spec = parseAgentSpec({
      ...validSpecBase,
      ui_routes: [{ ...validRouteBase, render_mode: 'react-ssr' }],
      slots: { 'ui-inbox-component': 'export default () => <div/>;' },
    });
    const issues = validateSpecForCodegen(spec);
    assert.equal(
      issues.filter((i) => i.code === 'ui_route_react_ssr_missing_component_slot').length,
      0,
    );
  });

  it('flags free-form-html without render slot', () => {
    const spec = buildSpec({
      ...validRouteBase,
      render_mode: 'free-form-html',
    });
    const issues = validateSpecForCodegen(spec);
    assert.ok(issues.some((i) => i.code === 'ui_route_free_form_missing_render_slot'));
  });

  it('rejects interactive=true for library mode (B.13 only allows react-ssr)', () => {
    const spec = buildSpec({
      ...validRouteBase,
      render_mode: 'library',
      ui_template: 'kpi-tiles',
      interactive: true,
    });
    const issues = validateSpecForCodegen(spec);
    assert.ok(issues.some((i) => i.code === 'ui_route_interactive_not_supported'));
  });

  it('rejects interactive=true for free-form-html mode', () => {
    const spec = parseAgentSpec({
      ...validSpecBase,
      ui_routes: [
        {
          ...validRouteBase,
          render_mode: 'free-form-html',
          interactive: true,
        },
      ],
      slots: { 'ui-inbox-render': 'return html`<div/>`;' },
    });
    const issues = validateSpecForCodegen(spec);
    assert.ok(issues.some((i) => i.code === 'ui_route_interactive_not_supported'));
  });

  it('B.13 — ACCEPTS interactive=true when render_mode=react-ssr', () => {
    const spec = parseAgentSpec({
      ...validSpecBase,
      ui_routes: [
        {
          ...validRouteBase,
          render_mode: 'react-ssr',
          interactive: true,
        },
      ],
      slots: { 'ui-inbox-component': 'export default () => <div data-omadia-page="inbox"/>;' },
    });
    const issues = validateSpecForCodegen(spec);
    assert.equal(
      issues.filter((i) => i.code === 'ui_route_interactive_not_supported').length,
      0,
      'react-ssr + interactive=true is the supported combination',
    );
  });

  it('routeId is populated on ui_route issues for traceability', () => {
    const spec = buildSpec({
      ...validRouteBase,
      id: 'specific-route',
      render_mode: 'library',
    });
    const issues = validateSpecForCodegen(spec);
    const uiIssues = issues.filter((i) => i.routeId);
    assert.ok(uiIssues.every((i) => i.routeId === 'specific-route'));
  });
});

describe('manifestLinter — ui_routes uniqueness', () => {
  it('passes with distinct ids, paths, and tab_labels', () => {
    const result = validateSpec({
      ...validSpecBase,
      ui_routes: [
        { ...validRouteBase, id: 'a', path: '/a', tab_label: 'A' },
        { ...validRouteBase, id: 'b', path: '/b', tab_label: 'B' },
      ],
    });
    const uiViolations = result.violations.filter((v) => v.kind.startsWith('ui_route_'));
    assert.deepEqual(uiViolations, []);
  });

  it('flags duplicate ui_route id', () => {
    const result = validateSpec({
      ...validSpecBase,
      ui_routes: [
        { ...validRouteBase, id: 'inbox', path: '/a', tab_label: 'A' },
        { ...validRouteBase, id: 'inbox', path: '/b', tab_label: 'B' },
      ],
    });
    assert.ok(result.violations.some((v) => v.kind === 'ui_route_id_duplicate'));
  });

  it('flags duplicate path', () => {
    const result = validateSpec({
      ...validSpecBase,
      ui_routes: [
        { ...validRouteBase, id: 'a', path: '/dash', tab_label: 'A' },
        { ...validRouteBase, id: 'b', path: '/dash', tab_label: 'B' },
      ],
    });
    assert.ok(result.violations.some((v) => v.kind === 'ui_route_path_duplicate'));
  });

  it('flags duplicate tab_label', () => {
    const result = validateSpec({
      ...validSpecBase,
      ui_routes: [
        { ...validRouteBase, id: 'a', path: '/a', tab_label: 'Inbox' },
        { ...validRouteBase, id: 'b', path: '/b', tab_label: 'Inbox' },
      ],
    });
    assert.ok(result.violations.some((v) => v.kind === 'ui_route_tab_label_duplicate'));
  });

  it('skips uniqueness checks for malformed entries (defensive)', () => {
    const result = validateSpec({
      ...validSpecBase,
      ui_routes: [null, 'not-an-object', 42],
    });
    const uiViolations = result.violations.filter((v) => v.kind.startsWith('ui_route_'));
    assert.deepEqual(uiViolations, []);
  });
});
