/**
 * Spec 2042 §5.10, criterion 37 — what a Plugin Builder preview may resolve
 * through `ctx.services`.
 *
 * A preview reads through to the live kernel ServiceRegistry so a draft that
 * depends on an installed integration can be tested against it. It must not
 * get a right the draft or the operator lacks: the draft gets exactly what
 * it would get installed, judged by its own manifest with the same gates an
 * installed plugin passes (`pluginContext.ts`):
 *
 *   - only capabilities its manifest declares (`requires`, `optional_requires`),
 *     and of a versioned name only the declared major;
 *   - never a pool-shaped capability (the operator's database needs an
 *     operator grant a preview cannot have);
 *   - never a raw model client or provider pool, whatever kind the draft's
 *     manifest claims: models go through the gateway;
 *   - resolved as the draft plugin, so per-caller services see who asks.
 *
 * A manifest that cannot be read declares nothing: every lookup is refused.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { RawModelServiceRefusedError, ServiceNotDeclaredError, SharedPoolRefusedError } from '@omadia/plugin-api';
import yaml from 'yaml';

import {
  createServiceGrantGate,
  declaresServiceMajor,
  isRawModelServiceName,
  versionedServiceRef,
} from '../../platform/pluginServiceGrants.js';
import { POOL_SHAPED_CAPABILITIES } from '../../platform/pluginSqlGrants.js';
import { adaptManifestV1, type PluginCatalog } from '../manifestLoader.js';

/** Throws when the draft may not resolve `requested`; returns otherwise. */
export type PreviewServiceGate = (requested: string) => void;

/** A catalog that knows only the draft, as an uploaded (never bundled) plugin. */
function draftCatalog(agentId: string, manifest: unknown): PluginCatalog | undefined {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return undefined;
  const plugin = adaptManifestV1(manifest as Record<string, unknown>);
  if (!plugin) return undefined;
  const entry = { plugin: { ...plugin, id: agentId }, manifest, source_path: 'preview', source_kind: 'manifest-v1', origin: 'uploaded' };
  return {
    get: (id: string) => (id === agentId ? entry : undefined),
    list: () => [entry],
    isBundledId: () => false,
  } as unknown as PluginCatalog;
}

export function createPreviewServiceGate(
  agentId: string,
  manifest: unknown,
  log: (...args: unknown[]) => void,
): PreviewServiceGate {
  const catalog = draftCatalog(agentId, manifest);
  if (!catalog) {
    return (requested) => {
      throw new ServiceNotDeclaredError(agentId, requested);
    };
  }
  const assertDeclared = createServiceGrantGate({ agentId, catalog, isRegisteredByPlugin: () => false, log });
  return (requested) => {
    const versioned = versionedServiceRef(requested);
    const name = versioned ? versioned.name : requested;
    assertDeclared(name);
    if (versioned && !declaresServiceMajor(agentId, catalog, versioned)) {
      throw new ServiceNotDeclaredError(agentId, requested);
    }
    if (POOL_SHAPED_CAPABILITIES.has(name)) throw new SharedPoolRefusedError(agentId, name);
    // Whatever kind the draft's own manifest claims: a draft written by the
    // Builder is no model plugin of the operator's, and its preview reaches
    // models only through the gateway.
    if (isRawModelServiceName(name)) throw new RawModelServiceRefusedError(agentId, name);
  };
}

/** The gate for the draft package at `packageRoot` (its `manifest.yaml`). */
export async function previewServiceGateFor(
  packageRoot: string,
  agentId: string,
  log: (...args: unknown[]) => void,
): Promise<PreviewServiceGate> {
  let manifest: unknown;
  try {
    manifest = yaml.parse(await fs.readFile(path.join(packageRoot, 'manifest.yaml'), 'utf-8'));
  } catch {
    manifest = undefined;
  }
  return createPreviewServiceGate(agentId, manifest, log);
}
