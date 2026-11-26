/**
 * ADR-0167 — the node-id namespaces the kernel writes itself. None of them is
 * ever a plugin's entity system: the graph providers upsert a node by its id
 * whatever its type, so an entity of system `turn` would merge a plugin's
 * `extras` into another user's turn.
 *
 * Used by the write guard (`boundedGraphServices.ts`, `entityWriteGuard`) and
 * by the manifest loader, which drops such a declaration from
 * `permissions.graph.entity_systems` so the summary an operator sees is what
 * the plugin can write.
 */
import type { ChannelKind } from '@omadia/plugin-api';

/**
 * Channel identities are `<channelKind>:<channelUserId>` (`channelIdentityNodeId`),
 * and a channel user id can itself hold a colon (Teams `29:…`). Keyed by
 * `ChannelKind`, so a new channel kind must be added here to compile.
 */
const CHANNEL_KIND_NAMESPACES: { readonly [K in ChannelKind]: true } = {
  teams: true,
  telegram: true,
  slack: true,
  discord: true,
  whatsapp: true,
  imessage: true,
  email: true,
  web: true,
  api: true,
};

/**
 * The `*NodeId` helpers in plugin-api, process ids, the `dataset` entity
 * system, the review queues and every channel kind.
 */
const KERNEL_NODE_NAMESPACES: ReadonlySet<string> = new Set([
  'session',
  'turn',
  'plan',
  'planstep',
  'user',
  'mk',
  'excerpt',
  'inconsistency',
  'merge',
  'excerpt-merge',
  'topic',
  'run',
  'agent',
  'tool',
  'fact',
  'process',
  'dataset',
  ...Object.keys(CHANNEL_KIND_NAMESPACES),
]);

/**
 * True when `system` can never be a plugin's entity system: a kernel node
 * namespace, or a value with a colon in it (the node id would then start with
 * another namespace, `turn:atlas:` + model + id).
 */
export function isKernelReservedSystem(system: string): boolean {
  return system.includes(':') || KERNEL_NODE_NAMESPACES.has(system);
}
