import { realpathSync } from 'node:fs';

import type { PluginEgressPermission } from './pluginEgressGuard.js';

/**
 * ADR-0017 — Builder previews are plugins for the network sandbox too. A
 * draft runs in-process from its extract under the previews directory, so its
 * own `fetch` or `node:http(s)` call would otherwise be attributed to the
 * kernel and let through. The preview runtime registers each active extract
 * with the draft manifest's network permission (never a model plugin) and
 * removes it on close. Anything else under the previews directory (an extract
 * whose preview was closed while its code still runs, a stale directory) is
 * attributed to {@link UNREGISTERED_PREVIEW_ID} with no network permission.
 */

/** Egress attribution of code under the previews root no preview owns. */
export const UNREGISTERED_PREVIEW_ID = 'builder-preview';

const NO_NETWORK: PluginEgressPermission = { isModelPlugin: false, hosts: [], publicWeb: false };

export interface PreviewEgressNetwork {
  readonly outbound: readonly string[];
  readonly publicWeb: boolean;
}

export interface PreviewEgressRoots {
  /** Register an active preview extract; returns its unregister. */
  register(input: { readonly packageRoot: string; readonly agentId: string; readonly network: PreviewEgressNetwork }): () => void;
  /** Roots for the egress guard, the specific ones before the catch-all. */
  roots(): ReadonlyArray<{ readonly root: string; readonly pluginId: string }>;
  /** Permission of a preview egress id; `undefined` for any other id. */
  permissionOf(pluginId: string): PluginEgressPermission | undefined;
}

function realOrSelf(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The egress id of a registered preview — distinct from an installed
 *  plugin of the same name, so the draft never borrows its permission. */
export function previewEgressId(agentId: string, seq: number): string {
  return `preview:${agentId}#${String(seq)}`;
}

export function createPreviewEgressRoots(previewsRoot: string): PreviewEgressRoots {
  const active = new Map<string, { readonly roots: readonly string[]; readonly permission: PluginEgressPermission }>();
  let seq = 0;
  const catchAll = [...new Set([previewsRoot, realOrSelf(previewsRoot)])];

  return {
    register({ packageRoot, agentId, network }) {
      seq += 1;
      const id = previewEgressId(agentId, seq);
      active.set(id, {
        roots: [...new Set([packageRoot, realOrSelf(packageRoot)])],
        permission: { isModelPlugin: false, hosts: [...network.outbound], publicWeb: network.publicWeb },
      });
      return () => {
        active.delete(id);
      };
    },
    roots() {
      const specific = [...active.entries()].flatMap(([pluginId, entry]) =>
        entry.roots.map((root) => ({ root, pluginId })),
      );
      return [...specific, ...catchAll.map((root) => ({ root, pluginId: UNREGISTERED_PREVIEW_ID }))];
    },
    permissionOf(pluginId) {
      if (pluginId === UNREGISTERED_PREVIEW_ID) return NO_NETWORK;
      return active.get(pluginId)?.permission;
    },
  };
}
