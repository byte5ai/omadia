import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'yaml';

import { generate, CodegenError } from '../../src/plugins/builder/codegen.js';
import { parseAgentSpec, type AgentSpec } from '../../src/plugins/builder/agentSpec.js';
import { _resetCacheForTests } from '../../src/plugins/builder/boilerplateSource.js';
import {
  _resetServiceTypeRegistryForTests,
  registerServiceType,
} from '../../src/plugins/builder/serviceTypeRegistry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'minimal-spec.json');

function loadFixture(): {
  spec: AgentSpec;
  slots: Record<string, string>;
} {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, unknown>;
  const slots = raw['slots'] as Record<string, string>;
  // Spec without slots — slots are passed as separate generate() argument.
  const { slots: _ignored, ...specInput } = raw;
  void _ignored;
  return { spec: parseAgentSpec(specInput), slots };
}

describe('codegen.generate', () => {
  beforeEach(() => {
    _resetCacheForTests();
    // Phase 5B: registry is empty by default. Tests seed the same
    // entries the kernel-side serviceTypeRegistry shipped pre-5B so the
    // existing codegen / lint expectations stay valid; production
    // installations populate the registry via the integration plugins'
    // own bootstrap.
    _resetServiceTypeRegistryForTests();
    registerServiceType('odoo.client', {
      providedBy: 'de.byte5.integration.odoo',
      typeImport: { from: '@omadia/integration-odoo', name: 'OdooClient' },
    });
    registerServiceType('odoo.cache', {
      providedBy: 'de.byte5.integration.odoo',
      typeImport: { from: '@omadia/integration-odoo', name: 'OdooResponseCache' },
    });
    registerServiceType('confluence.client', {
      providedBy: 'de.byte5.integration.confluence',
      typeImport: {
        from: '@omadia/integration-confluence',
        name: 'ConfluenceClient',
      },
    });
    registerServiceType('confluence.toolkit', {
      providedBy: 'de.byte5.integration.confluence',
      typeImport: {
        from: '@omadia/integration-confluence',
        name: 'LocalSubAgentTool[]',
      },
    });
    registerServiceType('microsoft365.graph', {
      providedBy: 'de.byte5.integration.microsoft365',
      typeImport: {
        from: '@omadia/integration-microsoft365',
        name: 'Microsoft365Accessor',
      },
    });
  });

  it('produces a file map for the minimal weather spec', async () => {
    const { spec, slots } = loadFixture();
    const out = await generate({ spec, slots });

    // Expected post-rename + post-substitution file paths
    assert.ok(out.has('manifest.yaml'));
    assert.ok(out.has('package.json'));
    assert.ok(out.has('plugin.ts'));
    assert.ok(out.has('client.ts'));
    assert.ok(out.has('toolkit.ts'));
    assert.ok(out.has('types.ts'));
    assert.ok(out.has('index.ts'));
    assert.ok(out.has('tsconfig.json'));
    assert.ok(out.has('skills/weather-expert.md'));
    // Original placeholder filename must be gone
    assert.equal(out.has('skills/{{AGENT_SLUG}}-expert.md'), false);
  });

  it('substitutes top-level placeholders', async () => {
    const { spec, slots } = loadFixture();
    const out = await generate({ spec, slots });

    const manifestText = out.get('manifest.yaml')!.toString('utf-8');
    assert.match(manifestText, /id:\s*"de\.byte5\.agent\.weather"/);
    assert.match(manifestText, /name:\s*"Weather Forecast Agent"/);
    assert.match(manifestText, /api\.openweather\.org/);
    assert.match(manifestText, /de\.byte5\.integration\.openweather/);

    const pluginText = out.get('plugin.ts')!.toString('utf-8');
    assert.match(pluginText, /AGENT_ID = 'de\.byte5\.agent\.weather'/);
  });

  it('injects the toolkit-impl slot between markers', async () => {
    const { spec, slots } = loadFixture();
    const out = await generate({ spec, slots });

    const toolkitText = out.get('toolkit.ts')!.toString('utf-8');
    assert.match(toolkitText, /weather toolkit impl placeholder/);
    // markers preserved
    assert.match(toolkitText, /\/\/ #region builder:toolkit-impl/);
    assert.match(toolkitText, /\/\/ #endregion/);
    // default {{CAPABILITY_ID}} that lived between markers must be gone
    assert.equal(toolkitText.includes('{{CAPABILITY_ID}}'), false);
  });

  it('injects the client-impl slot between markers', async () => {
    const { spec, slots } = loadFixture();
    const out = await generate({ spec, slots });

    const clientText = out.get('client.ts')!.toString('utf-8');
    assert.match(clientText, /weather client impl placeholder/);
    assert.match(clientText, /\/\/ #region builder:client-impl/);
    assert.match(clientText, /\/\/ #endregion/);
  });

  it('injects the skill-prompt slot via HTML-comment markers in MD', async () => {
    const { spec, slots } = loadFixture();
    const out = await generate({ spec, slots });

    const skillText = out.get('skills/weather-expert.md')!.toString('utf-8');
    assert.match(skillText, /Wetter-Recherche-Assistent/);
    assert.match(skillText, /<!-- #region builder:skill-prompt -->/);
    assert.match(skillText, /<!-- #endregion -->/);
    // Frontmatter survived
    assert.match(skillText, /id: weather_expert_system/);
  });

  it('leaves no {{TOKEN}} residue in any text file', async () => {
    const { spec, slots } = loadFixture();
    const out = await generate({ spec, slots });

    const RESIDUE = /\{\{[A-Z][A-Z0-9_]*\}\}/;
    for (const [relPath, buf] of out) {
      if (relPath.endsWith('.png')) continue;
      const text = buf.toString('utf-8');
      assert.equal(
        RESIDUE.test(text),
        false,
        `placeholder residue in ${relPath}: ${(text.match(RESIDUE) ?? [])[0] ?? ''}`,
      );
    }
  });

  it('reproduces manifest capabilities for multi-tool specs', async () => {
    const { spec: base, slots } = loadFixture();
    const spec = parseAgentSpec({
      ...base,
      tools: [
        { id: 'get_forecast', description: 'Wetter-Forecast', input: { type: 'object' } },
        { id: 'get_alerts', description: 'Wetterwarnungen', input: { type: 'object' } },
      ],
    });
    const out = await generate({ spec, slots });

    const manifestYaml = out.get('manifest.yaml')!.toString('utf-8');
    const parsed = yaml.parse(manifestYaml) as { capabilities: Array<{ id: string }> };
    assert.equal(parsed.capabilities.length, 2);
    const ids = parsed.capabilities.map((c) => c.id);
    assert.ok(ids.includes('get_forecast'));
    assert.ok(ids.includes('get_alerts'));
  });

  it('throws CodegenError when a required slot is missing', async () => {
    const { spec, slots } = loadFixture();
    const partial = { ...slots };
    delete partial['toolkit-impl'];

    await assert.rejects(
      () => generate({ spec, slots: partial }),
      (err: unknown) => {
        assert.ok(err instanceof CodegenError);
        assert.ok(
          err.issues.some(
            (i) => i.code === 'missing_required_slot' && i.detail.includes('toolkit-impl'),
          ),
        );
        return true;
      },
    );
  });

  it('fails fast with one issue per unresolved placeholder source', async () => {
    // Same fail-fast contract as before — workspace review surfaced that
    // an unresolved placeholder used to throw one residue PER FILE the
    // token appeared in (manifest.yaml + README.md + …), burying the
    // signal. The fix collapses to a single actionable issue per missing
    // manifest source. depends_on used to be the regression case; with
    // B.6-9.1 (DEPENDS_ON_YAML derived placeholder) it no longer fails,
    // so we exercise the same path via OUTBOUND_HOST (network.outbound[0]).
    const { slots } = loadFixture();
    const spec = parseAgentSpec({
      id: 'de.byte5.agent.lonely',
      name: 'Lonely',
      description: 'no outbound',
      category: 'other',
      depends_on: [],
      tools: [{ id: 'do_thing', description: 'x', input: { type: 'object' } }],
      skill: { role: 'x' },
      playbook: { when_to_use: 'x', not_for: ['x'], example_prompts: ['x', 'y'] },
      network: { outbound: [] }, // <-- OUTBOUND_HOST resolves to undefined
    });
    await assert.rejects(
      () => generate({ spec, slots }),
      (err: unknown) => {
        assert.ok(err instanceof CodegenError);
        const residues = err.issues.filter(
          (i) => i.code === 'placeholder_residue',
        );
        // Exactly one residue per missing source (here: network.outbound[0] →
        // OUTBOUND_HOST), not one per file the placeholder appears in.
        assert.equal(residues.length, 1);
        const detail = residues[0]!.detail;
        assert.match(detail, /\{\{OUTBOUND_HOST\}\}/);
        assert.match(detail, /network\.outbound\[0\]/);
        return true;
      },
    );
  });

  it('renders depends_on: [] when spec.depends_on is empty (B.6-9.1)', async () => {
    // Self-contained agent (PAT/OAuth in own setup_fields, no parent
    // integration plugin) — depends_on must render as an empty YAML list,
    // not fail the codegen with a residue error.
    const { slots } = loadFixture();
    const spec = parseAgentSpec({
      id: 'de.byte5.agent.standalone',
      name: 'Standalone',
      description: 'self-contained agent with no parent integration',
      category: 'other',
      depends_on: [],
      tools: [{ id: 'do_thing', description: 'x', input: { type: 'object' } }],
      skill: { role: 'x' },
      playbook: { when_to_use: 'x', not_for: ['x'], example_prompts: ['x', 'y'] },
      network: { outbound: ['api.example.com'] },
    });
    const files = await generate({ spec, slots });
    const manifest = files.get('manifest.yaml');
    assert.ok(manifest);
    const text = manifest.toString('utf-8');
    assert.match(text, /^depends_on: \[\]$/m);
    assert.ok(!text.includes('{{INTEGRATION_ID}}'));
    assert.ok(!text.includes('{{DEPENDS_ON_YAML}}'));
  });

  it('renders depends_on as a block-list when spec.depends_on has entries (B.6-9.1)', async () => {
    const { slots } = loadFixture();
    const spec = parseAgentSpec({
      id: 'de.byte5.agent.weather',
      name: 'Weather',
      description: 'fixture',
      category: 'analysis',
      depends_on: [
        'de.byte5.integration.openweather',
        'de.byte5.integration.geocode',
      ],
      tools: [{ id: 'do_thing', description: 'x', input: { type: 'object' } }],
      skill: { role: 'x' },
      playbook: { when_to_use: 'x', not_for: ['x'], example_prompts: ['x', 'y'] },
      network: { outbound: ['api.example.com'] },
    });
    const files = await generate({ spec, slots });
    const manifest = files.get('manifest.yaml');
    assert.ok(manifest);
    const text = manifest.toString('utf-8');
    // yaml v2 omits quotes for plain scalars where unambiguous; both
    // forms are valid YAML, so we accept either.
    assert.match(
      text,
      /depends_on:\n {2}- "?de\.byte5\.integration\.openweather"?\n {2}- "?de\.byte5\.integration\.geocode"?/,
    );
    assert.ok(!text.includes('{{DEPENDS_ON_YAML}}'));
  });

  it('emits top-level admin_ui_path in manifest.yaml when spec sets it (S+7.7)', async () => {
    // Optional Operator-Admin-UI: when the spec carries `admin_ui_path`,
    // codegen must inject it as a top-level YAML field so manifestLoader
    // picks it up after install and web-dev can iframe the URL.
    const { slots } = loadFixture();
    const spec = parseAgentSpec({
      id: 'de.byte5.agent.unifi',
      name: 'UniFi',
      description: 'unifi tracker',
      category: 'other',
      depends_on: [],
      tools: [{ id: 'do_thing', description: 'x', input: { type: 'object' } }],
      skill: { role: 'x' },
      playbook: { when_to_use: 'x', not_for: ['x'], example_prompts: ['x', 'y'] },
      network: { outbound: ['api.example.com'] },
      admin_ui_path: '/api/unifi/admin/index.html',
    });
    const files = await generate({ spec, slots });
    const manifest = files.get('manifest.yaml');
    assert.ok(manifest);
    const text = manifest.toString('utf-8');
    assert.match(text, /^admin_ui_path: ['"]?\/api\/unifi\/admin\/index\.html['"]?$/m);
  });

  it('omits admin_ui_path from manifest.yaml when spec does not set it', async () => {
    const { slots } = loadFixture();
    const spec = parseAgentSpec({
      id: 'de.byte5.agent.no.ui',
      name: 'NoUI',
      description: 'agent without admin UI',
      category: 'other',
      depends_on: [],
      tools: [{ id: 'do_thing', description: 'x', input: { type: 'object' } }],
      skill: { role: 'x' },
      playbook: { when_to_use: 'x', not_for: ['x'], example_prompts: ['x', 'y'] },
      network: { outbound: ['api.example.com'] },
    });
    const files = await generate({ spec, slots });
    const manifest = files.get('manifest.yaml');
    assert.ok(manifest);
    const text = manifest.toString('utf-8');
    assert.ok(!/^admin_ui_path:/m.test(text));
  });

  it('emits assets/admin-ui/index.html with the default body when slot is omitted', async () => {
    // S+7.7: the boilerplate ships a fully-styled admin-UI shell with a
    // marker region for `admin-ui-body`. When the agent does not fill the
    // slot, the file still ends up in the package — substituted with
    // {{AGENT_NAME}} etc. — so the route mount has SOMETHING to serve.
    const { spec, slots } = loadFixture();
    const out = await generate({ spec, slots });
    const html = out.get('assets/admin-ui/index.html');
    assert.ok(html, 'admin-ui index.html must be in the output');
    const text = html.toString('utf-8');
    assert.match(text, /<title>Weather Forecast Agent · Admin<\/title>/);
    assert.match(text, /<!-- #region builder:admin-ui-body -->/);
    // Default content explains how to customize.
    assert.match(text, /admin-ui-body/);
    // No residue of the slug-placeholder.
    assert.ok(!text.includes('{{AGENT_SLUG}}'));
    assert.ok(!text.includes('{{AGENT_NAME}}'));
  });

  it('injects the admin-ui-body slot content when provided', async () => {
    const { spec, slots } = loadFixture();
    const out = await generate({
      spec,
      slots: {
        ...slots,
        'admin-ui-body': '<h2>Custom UI</h2>\n<p>Operator-defined content.</p>',
      },
    });
    const html = out.get('assets/admin-ui/index.html')!.toString('utf-8');
    assert.match(html, /<h2>Custom UI<\/h2>/);
    assert.match(html, /Operator-defined content/);
    // Default placeholder text must be replaced, not appended alongside.
    assert.ok(!html.includes('admin-ui-body</code> füllen'));
  });

  it('links the shared harness stylesheet and ships no inline <head> styles', async () => {
    // Step 3.2: the boilerplate index.html now <link>s the middleware-served
    // /bot-api/_harness/admin-ui.css instead of carrying its own ad-hoc
    // <style> in <head>. Guard against an accidental revert that would
    // re-introduce the system-ui look + per-plugin theming drift.
    const { spec, slots } = loadFixture();
    const out = await generate({ spec, slots });
    const html = out.get('assets/admin-ui/index.html')!.toString('utf-8');

    // The shared stylesheet is linked exactly once.
    const linkMatches = html.match(
      /<link\s+rel="stylesheet"\s+href="\/bot-api\/_harness\/admin-ui\.css"\s*\/?>/g,
    );
    assert.ok(linkMatches, 'expected <link> to /bot-api/_harness/admin-ui.css');
    assert.equal(linkMatches.length, 1, 'stylesheet must be linked exactly once');

    // No <style> block inside <head>. Inline <style> inside the body slot
    // is intentional and still permitted — only the head must stay clean.
    const headMatch = html.match(/<head>([\s\S]*?)<\/head>/);
    assert.ok(headMatch, 'index.html must contain a <head>');
    assert.ok(
      !/<style\b/.test(headMatch[1]!),
      '<head> must not carry inline <style>',
    );

    // body class hook for the harness scope.
    assert.match(html, /<body[^>]*class="[^"]*\bharness-admin\b/);

    // The body-slot comment surfaces the iframe height constraint to the
    // LLM, so it can size content responsively. Step 3.3 — admin-ui CLAUDE.md.
    assert.match(html, /1000\s*px\s*fixed/i);
  });

  it('throws CodegenError for reserved tool id', async () => {
    const { slots } = loadFixture();
    const spec = parseAgentSpec({
      id: 'de.byte5.agent.weather',
      name: 'X',
      description: 'x',
      category: 'analysis',
      depends_on: ['de.byte5.integration.openweather'],
      tools: [{ id: 'query_memory', description: 'x', input: { type: 'object' } }],
      skill: { role: 'x' },
      playbook: { when_to_use: 'x', not_for: ['x'], example_prompts: ['x', 'y'] },
      network: { outbound: ['x.example.com'] },
    });
    await assert.rejects(
      () => generate({ spec, slots }),
      (err: unknown) => {
        assert.ok(err instanceof CodegenError);
        assert.ok(err.issues.some((i) => i.code === 'spec_validation'));
        return true;
      },
    );
  });

  it('returns Buffer values', async () => {
    const { spec, slots } = loadFixture();
    const out = await generate({ spec, slots });
    for (const [, buf] of out) {
      assert.ok(Buffer.isBuffer(buf));
    }
  });

  // --- Theme A: external_reads -------------------------------------------

  it('produces output identical to baseline when external_reads is empty', async () => {
    const { spec, slots } = loadFixture();
    const out = await generate({ spec, slots });

    const pluginText = out.get('plugin.ts')!.toString('utf-8');
    assert.match(pluginText, /\/\/ #region builder:external-reads-imports/);
    assert.match(pluginText, /\/\/ #region builder:external-reads-init/);
    // No injected `import { z } from 'zod'` line in plugin.ts.
    assert.ok(!/^import \{ z \} from 'zod';$/m.test(pluginText));
    // No actual lookup-call (the boilerplate's region comment mentions
    // `ctx.services.get(...)` as documentation; we want to assert the
    // CALL form `ctx.services.get<...>(...)` is absent).
    assert.ok(
      !/const __svc_\w+ = ctx\.services\.get</.test(pluginText),
      'no codegen-emitted service lookups expected',
    );

    const pkgJson = JSON.parse(out.get('package.json')!.toString('utf-8')) as {
      peerDependencies?: Record<string, string>;
    };
    assert.deepEqual(pkgJson.peerDependencies, { zod: '^3.23.8' });
  });

  it('synthesises imports + body + peerDependencies for one external_read', async () => {
    const { slots } = loadFixture();
    const spec = parseAgentSpec({
      id: 'de.byte5.agent.hr-list',
      name: 'HR List',
      description: 'x',
      category: 'productivity',
      depends_on: ['de.byte5.integration.odoo'],
      tools: [{ id: 'do_thing', description: 'x', input: { type: 'object' } }],
      external_reads: [
        {
          id: 'list_employees',
          description: 'List Odoo HR employees',
          service: 'odoo.client',
          model: 'hr.employee',
          method: 'execute',
          args: [{ model: 'hr.employee', method: 'search_read' }],
          kwargs: {},
        },
      ],
      skill: { role: 'x' },
      playbook: { when_to_use: 'x', not_for: ['x'], example_prompts: ['x', 'y'] },
      network: { outbound: ['x.example.com'] },
    });
    const out = await generate({ spec, slots });
    const pluginText = out.get('plugin.ts')!.toString('utf-8');

    assert.match(pluginText, /import \{ z \} from 'zod';/);
    assert.match(
      pluginText,
      /import type \{ OdooClient \} from '@omadia\/integration-odoo';/,
    );
    assert.match(
      pluginText,
      /import type \{ ToolDescriptor \} from '\.\/toolkit\.js';/,
    );
    assert.match(
      pluginText,
      /const __svc_odoo_client = ctx\.services\.get<OdooClient>\('odoo\.client'\);/,
    );
    assert.match(pluginText, /__externalReadsTools\.push\(\{/);
    assert.match(pluginText, /id: "list_employees",/);
    assert.match(pluginText, /\["execute"\]!\(/);
    assert.match(pluginText, /\/\/ #region builder:external-reads-imports/);
    assert.match(pluginText, /\/\/ #region builder:external-reads-init/);

    const pkgJson = JSON.parse(out.get('package.json')!.toString('utf-8')) as {
      peerDependencies?: Record<string, string>;
    };
    assert.equal(
      pkgJson.peerDependencies?.['@omadia/integration-odoo'],
      '*',
    );
    assert.equal(pkgJson.peerDependencies?.['zod'], '^3.23.8');
  });

  it('emits one service-lookup block when two external_reads share a service', async () => {
    const { slots } = loadFixture();
    const spec = parseAgentSpec({
      id: 'de.byte5.agent.confluence-double',
      name: 'Confluence Double',
      description: 'x',
      category: 'documents',
      depends_on: ['de.byte5.integration.confluence'],
      tools: [{ id: 'do_thing', description: 'x', input: { type: 'object' } }],
      external_reads: [
        {
          id: 'fetch_page_a',
          description: 'a',
          service: 'confluence.client',
          method: 'getPage',
          args: ['111'],
        },
        {
          id: 'fetch_page_b',
          description: 'b',
          service: 'confluence.client',
          method: 'getPage',
          args: ['222'],
        },
      ],
      skill: { role: 'x' },
      playbook: { when_to_use: 'x', not_for: ['x'], example_prompts: ['x', 'y'] },
      network: { outbound: ['x.example.com'] },
    });
    const out = await generate({ spec, slots });
    const pluginText = out.get('plugin.ts')!.toString('utf-8');

    const lookupHits = pluginText.match(
      /ctx\.services\.get<ConfluenceClient>\('confluence\.client'\)/g,
    );
    assert.equal(lookupHits?.length ?? 0, 1);
    assert.match(pluginText, /id: "fetch_page_a",/);
    assert.match(pluginText, /id: "fetch_page_b",/);
  });

  it('throws CodegenError when external_reads references an unknown service', async () => {
    const { slots } = loadFixture();
    const spec = parseAgentSpec({
      id: 'de.byte5.agent.bad',
      name: 'Bad',
      description: 'x',
      category: 'other',
      depends_on: [],
      tools: [{ id: 'do_thing', description: 'x', input: { type: 'object' } }],
      external_reads: [
        {
          id: 'broken',
          description: 'x',
          service: 'totally.invented.service',
          method: 'm',
        },
      ],
      skill: { role: 'x' },
      playbook: { when_to_use: 'x', not_for: ['x'], example_prompts: ['x', 'y'] },
      network: { outbound: ['x.example.com'] },
    });
    await assert.rejects(
      () => generate({ spec, slots }),
      (err: unknown) => {
        assert.ok(err instanceof CodegenError);
        assert.ok(
          err.issues.some(
            (i) =>
              i.code === 'spec_validation' && /unknown service/.test(i.detail),
          ),
        );
        return true;
      },
    );
  });

  it('applies result_mapping when set', async () => {
    const { slots } = loadFixture();
    const spec = parseAgentSpec({
      id: 'de.byte5.agent.mapped',
      name: 'Mapped',
      description: 'x',
      category: 'analysis',
      depends_on: ['de.byte5.integration.odoo'],
      tools: [{ id: 'do_thing', description: 'x', input: { type: 'object' } }],
      external_reads: [
        {
          id: 'list_employees',
          description: 'x',
          service: 'odoo.client',
          method: 'execute',
          args: [],
          result_mapping: { employees: 'data', count: 'length' },
        },
      ],
      skill: { role: 'x' },
      playbook: { when_to_use: 'x', not_for: ['x'], example_prompts: ['x', 'y'] },
      network: { outbound: ['x.example.com'] },
    });
    const out = await generate({ spec, slots });
    const pluginText = out.get('plugin.ts')!.toString('utf-8');
    assert.match(pluginText, /__mapped\["employees"\] = __src\?\.\["data"\];/);
    assert.match(pluginText, /__mapped\["count"\] = __src\?\.\["length"\];/);
    assert.match(pluginText, /return __mapped;/);
  });
});
