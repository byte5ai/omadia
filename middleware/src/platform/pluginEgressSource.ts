import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

import type { LlmProviderCatalog } from '@omadia/llm-provider';

import { effectiveKind } from '../api/admin-v1.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import { extractAuditConfig, extractOutboundAllowlist } from './pluginContext.js';
import { isPublicIp } from './ssrfGuard.js';
import type { PluginEgressPermission, PluginEgressSource } from './pluginEgressGuard.js';
import type { PreviewEgressRoots } from './previewEgressRoots.js';

const ROOTS_TTL_MS = 5_000;

/**
 * Spec 2042 §5.10 — what the plugin egress guard knows about the instance:
 * where installed packages live, each plugin's effective network permission
 * (the same resolution `ctx.http` uses) and the endpoints of the installed
 * model providers. Read per request, so an install, an uninstall or an
 * operator's host change applies to the next request. Builder previews
 * (`previews`, ADR-0017) are read live, ahead of the installed roots.
 */
export function createPluginEgressSource(deps: {
  readonly catalog: PluginCatalog;
  readonly installedRegistry: InstalledRegistry;
  readonly llmProviderCatalog: LlmProviderCatalog;
  readonly previews?: PreviewEgressRoots;
}): PluginEgressSource {
  const realRoots = new Map<string, string>();
  const real = (dir: string): string => {
    const cached = realRoots.get(dir);
    if (cached !== undefined) return cached;
    let resolved = dir;
    try {
      resolved = realpathSync(dir);
    } catch {
      // A package directory that is gone keeps its configured path.
    }
    realRoots.set(dir, resolved);
    return resolved;
  };

  const isModelPlugin = (pluginId: string): boolean => {
    const entry = deps.catalog.get(pluginId);
    if (!entry) return false;
    if (effectiveKind(entry.plugin.kind) === 'model') return true;
    // Until the release train moved them, the LLM provider plugins are of
    // kind `extension` and say what they are with an `llm_provider:` block.
    const manifest = entry.manifest as Record<string, unknown> | undefined;
    return manifest?.['llm_provider'] !== undefined && manifest['llm_provider'] !== null;
  };

  // Asked on every outbound request of the process, the kernel's included:
  // the roots are rebuilt at most once per interval, so an install shows up
  // within it and a request costs no catalog walk.
  let roots: { at: number; value: ReadonlyArray<{ root: string; pluginId: string }> } | undefined;
  const buildRoots = (): ReadonlyArray<{ root: string; pluginId: string }> =>
    deps.catalog
      .list()
      .filter((entry) => entry.origin === 'installed')
      .flatMap((entry) => {
        const dir = path.dirname(entry.source_path);
        const resolved = real(dir);
        const own = [{ root: dir, pluginId: entry.plugin.id }];
        return resolved === dir ? own : [...own, { root: resolved, pluginId: entry.plugin.id }];
      });

  return {
    pluginRoots: () => {
      const at = Date.now();
      if (!roots || at - roots.at > ROOTS_TTL_MS) roots = { at, value: buildRoots() };
      return deps.previews ? [...deps.previews.roots(), ...roots.value] : roots.value;
    },

    permissionOf: (pluginId): PluginEgressPermission | undefined => {
      const preview = deps.previews?.permissionOf(pluginId);
      if (preview !== undefined) return preview;
      const entry = deps.catalog.get(pluginId);
      if (!entry) return undefined;
      const config = deps.installedRegistry.get(pluginId)?.config ?? {};
      const outbound = extractOutboundAllowlist(pluginId, deps.catalog, (key) => config[key]);
      const webScanner = entry.plugin.permissions_summary.network_web_scanner === true;
      // The same modes as `ctx.http`: only a declared web scanner gets the
      // operator's hosts or `public-web`.
      const audit = webScanner ? extractAuditConfig(pluginId, deps.catalog, deps.installedRegistry) : undefined;
      const mode = audit?.auditMode ?? 'single-host';
      return {
        isModelPlugin: isModelPlugin(pluginId),
        hosts: mode === 'allowlist' ? [...outbound, ...(audit?.extraHosts ?? [])] : outbound,
        publicWeb: mode === 'public-web',
      };
    },

    modelProviderHosts: () => {
      const hosts = new Set<string>();
      for (const desc of deps.llmProviderCatalog.list()) {
        const host = hostOf(desc.baseURL);
        if (host && !isLocalHost(host)) hosts.add(host);
      }
      // Literal hosts of model plugins. Wildcards are left out on purpose:
      // `*.googleapis.com` of a model plugin must not cut an integration off
      // the rest of Google's APIs.
      for (const entry of deps.catalog.list()) {
        if (!isModelPlugin(entry.plugin.id)) continue;
        const config = deps.installedRegistry.get(entry.plugin.id)?.config ?? {};
        for (const h of extractOutboundAllowlist(entry.plugin.id, deps.catalog, (key) => config[key])) {
          const host = h.trim().toLowerCase();
          if (!host.includes('*') && !isLocalHost(host)) hosts.add(host);
        }
      }
      return hosts;
    },
  };
}

/**
 * A local model server (Ollama on `localhost:11434`) shares its host with
 * every other local service; blocking the host would cut every plugin off
 * loopback. Local and private hosts are therefore not model endpoints here:
 * reaching them is decided by the plugin's network permission alone.
 */
function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'host.docker.internal') return true;
  return isIP(host) !== 0 && !isPublicIp(host);
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
