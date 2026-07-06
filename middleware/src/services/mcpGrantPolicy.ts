/**
 * Runtime enforcement policy for MCP tool grants (epic #459 W1, issue #454 —
 * codex-review fold).
 *
 * The grant-time gate in the Builder routes fails closed, but grants that
 * already exist can go stale: a tool that was benign when granted may come
 * back `high_risk` on re-discover, or an ack may be invalidated by a content
 * change. This module keeps a process-wide blocklist of (server, tool) pairs
 * whose CURRENT verdict needs an ack that is missing or stale; both hydration
 * paths (sub-agent tools and top-level DomainTools) consult it synchronously.
 *
 * Refresh points: boot (before initial hydration), after every discover scan,
 * and after every ack — each followed by a registry reload so rebuilt agents
 * pick the new policy up. Residual gap, documented on #454: grants created
 * before migration 0008 have no verdict rows and stay callable until their
 * server is re-discovered once (the W6 periodic re-scan closes this for good);
 * blocking every unknown pair at runtime would silently strip working tools
 * from existing installs on upgrade.
 */
import { type Severity } from './skillVerdict.js';

import type { AgentGraphStore } from '@omadia/orchestrator';
import { CURRENT_VERIFIER_VERSION } from './skillVerdict.js';

/** Severities that must be explicitly acknowledged before a grant is usable.
 *  `scan_failed`/`too_large_to_scan` are "not scanned clean" — treating them
 *  as silently grantable would make crashing the scanner a bypass. */
export const MCP_SEVERITIES_NEEDING_ACK: ReadonlySet<Severity> = new Set([
  'high_risk',
  'scan_failed',
  'too_large_to_scan',
]);

function key(serverId: string, toolName: string): string {
  return `${serverId} ${toolName}`;
}

let blockedPairs: ReadonlySet<string> = new Set<string>();

/** Recompute the blocklist from the persisted verdicts + acks. Never throws
 *  into callers' request paths — callers decide how to handle a rejection. */
export async function refreshMcpGrantPolicy(graph: AgentGraphStore): Promise<void> {
  const [verdicts, acks] = await Promise.all([
    graph.listMcpToolVerdicts(CURRENT_VERIFIER_VERSION),
    graph.listMcpToolVerdictAcks(CURRENT_VERIFIER_VERSION),
  ]);
  const ackByKey = new Map(acks.map((a) => [key(a.serverId, a.toolName), a]));
  const next = new Set<string>();
  for (const v of verdicts) {
    if (!MCP_SEVERITIES_NEEDING_ACK.has(v.severity)) continue;
    const ack = ackByKey.get(key(v.serverId, v.toolName));
    if (!ack || ack.contentHash !== v.contentHash) {
      next.add(key(v.serverId, v.toolName));
    }
  }
  blockedPairs = next;
}

/** Synchronous read for hydration paths. */
export function isMcpGrantBlocked(serverId: string, toolName: string): boolean {
  return blockedPairs.has(key(serverId, toolName));
}

/** Test seam: reset the module state. */
export function resetMcpGrantPolicyForTests(): void {
  blockedPairs = new Set<string>();
}
