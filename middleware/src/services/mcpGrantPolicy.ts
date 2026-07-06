/**
 * Runtime enforcement policy for MCP tool grants (epic #459 W1, issue #454 —
 * hardened across two codex-review folds).
 *
 * Two enforcement layers consume this module:
 *
 * 1. **Dispatch guard** (`mcpDispatchDenial`, wired into `McpManager` as its
 *    call guard): runs on EVERY tool call, so policy changes apply instantly
 *    without waiting for a registry rebuild. Denies (a) pairs whose current
 *    verdict needs an ack that is missing or stale, and (b) pairs with no
 *    current verdict at all — "never scanned" must not be a bypass (codex
 *    fold 2; pre-0008 installs see a clear re-discover message on first use
 *    instead of a silent unscanned call).
 * 2. **Hydration filter** (`isMcpGrantBlocked`): keeps known-risky tool specs
 *    out of the model context entirely. Only known-bad pairs are filtered
 *    here (not unknowns), so existing installs keep their tool surface
 *    visible while the dispatch guard enforces scanning.
 *
 * Refresh points: boot, after every discover scan, after every ack. The
 * discover/ack routes additionally bump the affected grants' config epoch so
 * the registry diff actually rebuilds the agents whose tool surface changed
 * (a bare `reload()` sees no graph change from verdict rows alone).
 */
import { CURRENT_VERIFIER_VERSION, type Severity } from './skillVerdict.js';

import type { AgentGraphStore } from '@omadia/orchestrator';

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

let blockedBySeverity: ReadonlyMap<string, Severity> = new Map<string, Severity>();
let scannedPairs: ReadonlySet<string> = new Set<string>();
let refreshGeneration = 0;

/** Recompute the policy state from the persisted verdicts + acks. Concurrent
 *  refreshes are serialized by generation: only the most recently STARTED
 *  refresh publishes, so an older read finishing late can never overwrite a
 *  newer blocklist with stale data (codex fold 2, race finding). */
export async function refreshMcpGrantPolicy(graph: AgentGraphStore): Promise<void> {
  refreshGeneration += 1;
  const generation = refreshGeneration;
  const [verdicts, acks] = await Promise.all([
    graph.listMcpToolVerdicts(CURRENT_VERIFIER_VERSION),
    graph.listMcpToolVerdictAcks(CURRENT_VERIFIER_VERSION),
  ]);
  if (generation !== refreshGeneration) return; // a newer refresh superseded us
  const ackByKey = new Map(acks.map((a) => [key(a.serverId, a.toolName), a]));
  const nextBlocked = new Map<string, Severity>();
  const nextScanned = new Set<string>();
  for (const v of verdicts) {
    const k = key(v.serverId, v.toolName);
    nextScanned.add(k);
    if (!MCP_SEVERITIES_NEEDING_ACK.has(v.severity)) continue;
    const ack = ackByKey.get(k);
    if (!ack || ack.contentHash !== v.contentHash) {
      nextBlocked.set(k, v.severity);
    }
  }
  blockedBySeverity = nextBlocked;
  scannedPairs = nextScanned;
}

/** Hydration filter: known-bad pairs only (spec stays out of model context). */
export function isMcpGrantBlocked(serverId: string, toolName: string): boolean {
  return blockedBySeverity.has(key(serverId, toolName));
}

/** Dispatch guard for `McpManager` — returns a model-facing denial string, or
 *  null to allow. Fail-closed on unscanned pairs. */
export function mcpDispatchDenial(serverId: string, toolName: string): string | null {
  const k = key(serverId, toolName);
  const severity = blockedBySeverity.get(k);
  if (severity) {
    return `Error: MCP tool "${toolName}" is blocked by the scan-verdict policy (unacknowledged "${severity}"). An operator must acknowledge it in the MCP Control Center before it can run.`;
  }
  if (!scannedPairs.has(k)) {
    return `Error: MCP tool "${toolName}" has no current scan verdict. An operator must run Discover on its server in the MCP Control Center so the tool is scanned before use.`;
  }
  return null;
}

/** Test seam: reset the module state. */
export function resetMcpGrantPolicyForTests(): void {
  blockedBySeverity = new Map<string, Severity>();
  scannedPairs = new Set<string>();
  refreshGeneration = 0;
}
