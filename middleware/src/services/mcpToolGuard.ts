/**
 * Discovery-time risk scan for MCP tool descriptors (epic #459 W1, issue #454).
 *
 * A remote MCP server's tool list (name/description/inputSchema) is third-party
 * text that ends up in an agent's tool specs once granted — the same
 * prompt-injection surface skillGuard screens on the skill side (see the
 * Invariant Labs GitHub-MCP disclosure: the payload rode in through a tool's
 * declared description). This scan runs inside `POST /mcp-servers/:id/discover`
 * BEFORE `setMcpDiscoveredTools` persists anything.
 *
 * Reuse contract: the regex layer is skillGuard's `regexPatternVerifier` run
 * over an MCP-shaped haystack; severity aggregation is skillVerdict's
 * `computeVerdict` (content-shape agnostic). New here: a JSON-structural
 * verifier for `inputSchema`, because prose-tuned regexes alone miss
 * schema-borne payloads.
 */
import { createHash } from 'node:crypto';

import { regexPatternVerifier, type SkillRisk } from './skillGuard.js';
import {
  CURRENT_VERIFIER_VERSION,
  computeVerdict,
  type Severity,
  type SkillVerdictRiskCodesEntry,
} from './skillVerdict.js';

import type { McpToolDescriptor } from '@omadia/orchestrator';

/** Serialized descriptors beyond this size are not scanned line-by-line; the
 *  verdict degrades to `too_large_to_scan` (visible, never silently passed). */
const MAX_SCAN_BYTES = 256 * 1024;

/** Input property names that read as credential harvesting when a remote tool
 *  asks for them as arguments. Deliberately conservative: `token`/`api_key`
 *  style names are common in legitimate integrations and stay unflagged; these
 *  are the "no legitimate tool asks the model for this" set. */
const HARVEST_PROPERTY_NAMES = new Set([
  'password',
  'passwort',
  'private_key',
  'privatekey',
  'seed_phrase',
  'seedphrase',
  'mnemonic',
  'wallet_secret',
  'credit_card',
  'creditcard',
  'ssn',
]);

export interface McpToolVerdict {
  readonly serverId: string;
  readonly toolName: string;
  readonly verifierVersion: string;
  readonly contentHash: string;
  readonly severity: Severity;
  readonly riskCodes: readonly SkillVerdictRiskCodesEntry[];
  readonly computedAt: Date;
}

/** Canonical serialization of the scannable surface of a tool descriptor.
 *  Key order in `inputSchema` follows JSON.stringify of the object as received;
 *  discovery always re-scans, so hash stability only needs to hold within a
 *  single server's responses, not across SDK re-orderings. */
export function mcpToolContentHash(tool: McpToolDescriptor): string {
  const canonical = JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Walk every string embedded in the schema (property names, descriptions,
 *  defaults, const/enum values) with a bounded depth so a hostile schema cannot
 *  stack-overflow the scanner. */
function collectSchemaStrings(
  node: unknown,
  out: Array<{ path: string; value: string }>,
  path: string,
  depth: number,
): void {
  if (depth > 16 || out.length >= 512) return;
  if (typeof node === 'string') {
    out.push({ path, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectSchemaStrings(item, out, `${path}[${i}]`, depth + 1));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      out.push({ path: `${path}.${key}`, value: key });
      collectSchemaStrings(value, out, `${path}.${key}`, depth + 1);
    }
  }
}

/**
 * JSON-structural verifier for `inputSchema` — the part prose regexes cannot
 * cover. Flags credential-harvest-shaped input properties. The regex layer
 * already sees the full serialized schema through the haystack, so injection
 * text hidden in defaults/enums is caught there; this verifier adds the
 * structural signal that survives even injection-free phrasing.
 */
export function structuralSchemaVerifier(tool: McpToolDescriptor): SkillRisk[] {
  const schema = tool.inputSchema;
  if (!schema) return [];
  const strings: Array<{ path: string; value: string }> = [];
  collectSchemaStrings(schema, strings, '$', 0);
  const risks: SkillRisk[] = [];
  const harvestHit = strings.find(
    (s) => HARVEST_PROPERTY_NAMES.has(s.value.toLowerCase().replace(/[\s-]/g, '_')),
  );
  if (harvestHit) {
    risks.push({
      code: 'credential_harvest',
      severity: 'warn',
      excerpt: `inputSchema ${harvestHit.path}: "${harvestHit.value}"`,
    });
  }
  return risks;
}

/** Scan one discovered tool descriptor. Deterministic, synchronous, no I/O. */
export function scanMcpToolForRisks(tool: McpToolDescriptor): SkillRisk[] {
  const haystack = [
    tool.name,
    tool.description ?? '',
    JSON.stringify(tool.inputSchema ?? {}),
  ].join('\n');
  // Reuse the skill-side regex layer verbatim: empty frontmatter, MCP haystack
  // as body. One risk per code, EN+DE patterns, bounded quantifiers.
  const regexRisks = regexPatternVerifier({}, haystack);
  const structuralRisks = structuralSchemaVerifier(tool);
  // Dedupe by code (regex layer may already have flagged credential_harvest).
  const seen = new Set(regexRisks.map((r) => r.code));
  return [...regexRisks, ...structuralRisks.filter((r) => !seen.has(r.code))];
}

/** Compute the persistable verdict row for one discovered tool. */
export function computeMcpToolVerdict(
  serverId: string,
  tool: McpToolDescriptor,
): McpToolVerdict {
  const contentHash = mcpToolContentHash(tool);
  const serializedBytes = Buffer.byteLength(
    JSON.stringify({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? {} }),
    'utf8',
  );
  if (serializedBytes > MAX_SCAN_BYTES) {
    return {
      serverId,
      toolName: tool.name,
      verifierVersion: CURRENT_VERIFIER_VERSION,
      contentHash,
      severity: 'too_large_to_scan',
      riskCodes: [],
      computedAt: new Date(),
    };
  }
  const risks = scanMcpToolForRisks(tool);
  const computed = computeVerdict(contentHash, risks);
  return {
    serverId,
    toolName: tool.name,
    verifierVersion: CURRENT_VERIFIER_VERSION,
    contentHash,
    severity: computed.severity,
    riskCodes: computed.riskCodes,
    computedAt: new Date(),
  };
}

/** Scan a whole discovery batch. A scanner crash on one descriptor must not
 *  take down discovery: that tool degrades to `scan_failed` (visible, and the
 *  grant gate treats it as not-ackable-as-clean rather than silently passed). */
export function scanDiscoveredTools(
  serverId: string,
  tools: readonly McpToolDescriptor[],
): McpToolVerdict[] {
  return tools.map((tool) => {
    try {
      return computeMcpToolVerdict(serverId, tool);
    } catch {
      // The hash itself may be what threw (hostile getter, circular schema) —
      // fall back to a name-only hash so the failure row is still keyable.
      let contentHash: string;
      try {
        contentHash = mcpToolContentHash(tool);
      } catch {
        contentHash = createHash('sha256').update(`scan_failed:${tool.name}`, 'utf8').digest('hex');
      }
      return {
        serverId,
        toolName: tool.name,
        verifierVersion: CURRENT_VERIFIER_VERSION,
        contentHash,
        severity: 'scan_failed' as Severity,
        riskCodes: [],
        computedAt: new Date(),
      };
    }
  });
}
