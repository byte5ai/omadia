#!/usr/bin/env tsx
/**
 * OB-29-0 Boot-Smoke für `agent-reference`. Läuft das gesamte Catalog-
 * Boot-Setup ohne den HTTP-Server zu starten und prüft drei Behauptungen:
 *
 *   1. Plugin-Catalog discovers `@omadia/agent-reference-maximum` mit
 *      `is_reference_only: true`.
 *   2. `resolveBuilderReferenceCatalog` registriert den Key `reference`
 *      auf den Package-Root.
 *   3. `read_reference` liefert die `INTEGRATION.md` über den Catalog-Eintrag.
 *
 * Aufruf: `npm run smoke:agent-reference`. Exit 0 = grün, Exit 1 = drift.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBuilderReferenceCatalog } from '../src/plugins/builder/builderReferenceCatalog.js';
import { BuiltInPackageStore } from '../src/plugins/builtInPackageStore.js';
import { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { readReferenceTool } from '../src/plugins/builder/tools/readReference.js';

const REFERENCE_AGENT_ID = '@omadia/agent-reference-maximum';

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packagesDir = path.resolve(here, '..', 'packages');

  const store = new BuiltInPackageStore(packagesDir);
  await store.load();
  const catalog = new PluginCatalog({
    extraSources: () =>
      store.list().map((p) => ({ packageRoot: p.path })),
  });
  await catalog.load();

  // ---- 1. Catalog enthält das Plugin mit dem is_reference_only Marker ----
  const entry = catalog.get(REFERENCE_AGENT_ID);
  if (!entry) {
    fail(`PluginCatalog hat '${REFERENCE_AGENT_ID}' nicht gefunden`);
  }
  if (entry.plugin.is_reference_only !== true) {
    fail(
      `PluginCatalog liefert '${REFERENCE_AGENT_ID}' ohne is_reference_only-Marker`,
    );
  }
  console.log(`✓ catalog.get('${REFERENCE_AGENT_ID}') ok, is_reference_only=true`);

  // ---- 2. Builder-Reference-Catalog hat den 'reference-maximum'-Key ----
  const refCatalog = resolveBuilderReferenceCatalog(catalog);
  const refEntry = refCatalog['reference-maximum'];
  if (!refEntry) {
    fail(`resolveBuilderReferenceCatalog hat keinen 'reference-maximum'-Key`);
  }
  console.log(`✓ resolveBuilderReferenceCatalog['reference-maximum'] root=${refEntry.root}`);

  // ---- 3. read_reference liefert INTEGRATION.md ----
  const result = await readReferenceTool.run(
    { name: 'reference-maximum', file: 'INTEGRATION.md' },
    {
      referenceCatalog: refCatalog,
      // Restliche ctx-Felder werden vom Tool nicht angefasst — Stub mit
      // `unknown as never`-Cast vermeidet die Pflicht, den ganzen Builder-
      // Tool-Context aufzubauen, ohne den Boot-Smoke aufzublähen.
    } as never,
  );
  if (!result.ok) {
    fail(`read_reference fehlgeschlagen: ${result.error}`);
  }
  if (!result.content.includes('Pattern-Index für den BuilderAgent')) {
    fail(`INTEGRATION.md hat unerwarteten Inhalt (Header fehlt)`);
  }
  console.log(`✓ read_reference INTEGRATION.md ok (${result.bytes} bytes)`);

  // ---- 4. OB-29-1: Manifest declares permissions.subAgents.calls ----
  // The PluginCatalog has parsed the new permission block correctly when
  // permissions_summary.sub_agents_calls is non-empty AND budget defaulted
  // to the manifest value (3 in our manifest).
  const refPlugin = entry.plugin;
  const subAgentsCalls = refPlugin.permissions_summary.sub_agents_calls ?? [];
  if (subAgentsCalls.length === 0) {
    fail('manifest permissions.subAgents.calls not parsed (empty)');
  }
  if (!subAgentsCalls.includes('@omadia/agent-seo-analyst')) {
    fail(
      `manifest permissions.subAgents.calls missing seo-analyst whitelist; got: ${subAgentsCalls.join(', ')}`,
    );
  }
  const budget =
    refPlugin.permissions_summary.sub_agents_calls_per_invocation ?? 5;
  if (budget !== 3) {
    fail(
      `manifest permissions.subAgents.calls_per_invocation expected 3, got ${budget}`,
    );
  }
  console.log(
    `✓ manifest permissions.subAgents.calls=${JSON.stringify(subAgentsCalls)}, calls_per_invocation=${budget}`,
  );

  // ---- 5. OB-29-2: Manifest declares permissions.graph.entity_systems ----
  const entitySystems =
    refPlugin.permissions_summary.graph_entity_systems ?? [];
  if (entitySystems.length === 0) {
    fail('manifest permissions.graph.entity_systems not parsed (empty)');
  }
  if (!entitySystems.includes('personal-notes')) {
    fail(
      `manifest permissions.graph.entity_systems missing 'personal-notes'; got: ${entitySystems.join(', ')}`,
    );
  }
  console.log(
    `✓ manifest permissions.graph.entity_systems=${JSON.stringify(entitySystems)}`,
  );

  // ---- 6. OB-29-3: Manifest declares permissions.llm.* ----
  const llmModels = refPlugin.permissions_summary.llm_models_allowed ?? [];
  if (llmModels.length === 0) {
    fail('manifest permissions.llm.models_allowed not parsed (empty)');
  }
  if (!llmModels.some((m) => m.startsWith('claude-haiku'))) {
    fail(
      `manifest permissions.llm.models_allowed missing haiku model; got: ${llmModels.join(', ')}`,
    );
  }
  const llmCalls = refPlugin.permissions_summary.llm_calls_per_invocation ?? 5;
  const llmTokens =
    refPlugin.permissions_summary.llm_max_tokens_per_call ?? 4096;
  if (llmCalls !== 2) {
    fail(`manifest permissions.llm.calls_per_invocation expected 2, got ${llmCalls}`);
  }
  if (llmTokens !== 1024) {
    fail(
      `manifest permissions.llm.max_tokens_per_call expected 1024, got ${llmTokens}`,
    );
  }
  console.log(
    `✓ manifest permissions.llm.models_allowed=${JSON.stringify(llmModels)}, calls_per_invocation=${llmCalls}, max_tokens=${llmTokens}`,
  );

  // ---- 7. OB-29-4: parseToolEmittedChoice round-trip ----
  const { parseToolEmittedChoice } = await import(
    '@omadia/orchestrator'
  );
  const sampleResult = JSON.stringify({
    ok: true,
    _pendingUserChoice: {
      question: 'Welcher Marcel?',
      options: [
        { label: 'Marcel Wege', value: 'note:n1' },
        { label: 'Marcel Müller', value: 'note:n2' },
      ],
    },
  });
  const parsed = parseToolEmittedChoice(sampleResult);
  if (!parsed || parsed.options.length !== 2) {
    fail('parseToolEmittedChoice round-trip failed');
  }
  console.log(
    `✓ parseToolEmittedChoice round-trip ok (question="${parsed.question}", ${parsed.options.length} options)`,
  );

  console.log('\nOB-29-0/1/2/3/4 boot-smoke OK');
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
