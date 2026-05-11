import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSETS } from '../../platform/assets.js';
import type { PluginCatalog } from '../manifestLoader.js';

/**
 * `agent-seo-analyst` lives under `<middleware>/packages/` in dev and
 * `/app/packages/` in prod (Dockerfile COPY). The 3×`..` from this module's
 * location resolves to the right MIDDLEWARE_ROOT in both layouts (no `..`
 * crosses past it, so Bug-Pattern-7-safe). Anything that DOES need a
 * `..`-crossing path goes through `ASSETS` instead — see `src/platform/
 * assets.ts`.
 */
const MIDDLEWARE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const SEO_ANALYST_ROOT = path.join(
  MIDDLEWARE_ROOT,
  'packages',
  'agent-seo-analyst',
);

/**
 * BuilderAgent reference-implementation **essentials**. The `read_reference`
 * tool exposes whitelisted views of multiple packages so the LLM can pick
 * the closest reference for the agent it is designing.
 *
 * What lives here vs. auto-discovered (Theme G, 2026-05-04):
 *   - **Essentials** (this map): things the BuilderAgent always needs but
 *     that are NOT integration-kind plugins — the seo-analyst reference
 *     and the two boilerplate templates. They live outside the plugin
 *     catalog (no manifest.yaml at the boilerplate root).
 *   - **Integrations** (auto-discovered): every plugin with `kind: integration`
 *     in the live `PluginCatalog` is added at boot by
 *     `resolveBuilderReferenceCatalog()`. The short-name is
 *     `integration-<tail-of-id>`. Use the resolver instead of this raw map
 *     for any new caller — direct use of this map skips auto-discovery.
 */
const BUILDER_REFERENCE_ESSENTIALS: Readonly<
  Record<string, { root: string; description: string }>
> = {
  'reference-maximum': {
    root: ASSETS.referencePackage.root,
    description:
      'Builder-Reference-Maximum (OB-29 abgeschlossen). Lauffähige, ' +
      'credential-lose Codebase, die ALLE auf der Plugin-API verfügbaren ' +
      'Patterns in einer Stelle demonstriert: Multi-Tool, Smart-Cards, ' +
      'BG-Jobs, Routes, ctx.memory, Service.provide, ctx.subAgent.ask ' +
      '(OB-29-1), generic ctx.knowledgeGraph.ingestEntities (OB-29-2), ' +
      'ctx.llm.complete (OB-29-3), tool-emittiertes _pendingUserChoice ' +
      '(OB-29-4). Lies INTEGRATION.md ZUERST — sie ist der kanonische ' +
      'Pattern-Index, jeder Pattern-Block trägt Datei:Zeile-Referenzen. ' +
      'PRIMÄRE Pattern-Quelle für komplexe Specs (≥2 Tools, KG-Ingest, ' +
      'Smart-Cards, Sub-Agent-Delegation, LLM-Calls). seo-analyst bleibt ' +
      'als Sekundär für Compact-No-API-Cases.',
  },
  'seo-analyst': {
    root: SEO_ANALYST_ROOT,
    description:
      'Compact agent reference: manifest.yaml, plugin.ts, toolkit.ts, ' +
      'fetcher.ts, skills/. Best for an agent without external HTTP API.',
  },
  boilerplate: {
    root: path.join(ASSETS.boilerplate.root, 'agent-integration'),
    description:
      'The template the BuilderAgent fills slots into for an agent that ' +
      'wraps a single external API. manifest.yaml, plugin.ts, client.ts, ' +
      'toolkit.ts, skills/, template.yaml — pick this when the spec has ' +
      'a non-empty `depends_on` and at least one tool.',
  },
  'boilerplate-pure-llm': {
    root: path.join(ASSETS.boilerplate.root, 'agent-pure-llm'),
    description:
      'Sister template for agents that need NO external API: pure system-' +
      'prompt + LLM reasoning. manifest.yaml, plugin.ts (empty toolkit), ' +
      'skills/, template.yaml — pick this when the spec has empty ' +
      '`depends_on` and no tools, e.g. a brainstorming coach.',
  },
};

/**
 * Theme G (2026-05-04): the BuilderAgent's `read_reference`-catalog used to
 * be a hand-maintained map of integration-plugin paths. That broke twice:
 * (1) every new integration required a paths.ts patch — silently skipped
 * by anyone landing the integration plugin, and (2) the LLM's call site
 * (`read_reference({name: '<integration>', file: 'INTEGRATION.md'})`) had
 * no path to discover what `<integration>` keys are actually available
 * for a given install.
 *
 * The fix is data-driven: at boot, after `pluginCatalog.load()` has run
 * over both the built-in and uploaded package stores, this resolver
 * iterates the catalog, picks every `kind: 'integration'` entry, and
 * registers it under `integration-<tail-of-id>`. The package root for
 * `read_reference` is taken from the manifest's `source_path` (already
 * an absolute path on disk).
 *
 * Hot-install caveat: the BuilderAgent is constructed once at boot and
 * holds the catalog snapshot. A user installing a new integration plugin
 * mid-session will not see it in `list_references` until the next
 * middleware restart. That is acceptable today (integrations are added
 * rarely); making the catalog per-turn is a future refactor (Theme A).
 */
export function resolveBuilderReferenceCatalog(
  pluginCatalog: PluginCatalog,
): Readonly<Record<string, { root: string; description: string }>> {
  const out: Record<string, { root: string; description: string }> = {
    ...BUILDER_REFERENCE_ESSENTIALS,
  };
  for (const entry of pluginCatalog.list()) {
    if (entry.plugin.kind !== 'integration') continue;
    // Split on `.` (legacy `de.byte5.integration.X`) or `/` (post-Welle-1
    // `@omadia/integration-X`) so the npm-scope namespace doesn't bleed
    // into the integration key.
    const tail = entry.plugin.id.split(/[./]/).pop() ?? entry.plugin.id;
    const key = `integration-${tail}`;
    if (key in out) {
      // Defensive: never override an essential. Two integrations with
      // the same id-tail are vanishingly rare; if it happens, fall back
      // to the full plugin id as the catalog key so neither shadows the
      // other.
      const fallback = entry.plugin.id;
      if (fallback in out) continue;
      out[fallback] = catalogEntryFor(entry);
      continue;
    }
    out[key] = catalogEntryFor(entry);
  }
  return out;
}

function catalogEntryFor(
  entry: ReturnType<PluginCatalog['list']>[number],
): { root: string; description: string } {
  // `source_path` is the absolute path to manifest.yaml. The package root
  // is its dirname.
  const root = path.dirname(entry.source_path);
  return {
    root,
    description:
      `Integration plugin '${entry.plugin.id}' v${entry.plugin.version}. ` +
      'Source of truth for cross-integration code is `INTEGRATION.md` at ' +
      'the package root — read it with `read_reference({name: ..., file: ' +
      "'INTEGRATION.md'})` before writing any code that consumes this " +
      'plugin. Do NOT reconstruct service names or method signatures ' +
      'from training memory; they drift.',
  };
}
