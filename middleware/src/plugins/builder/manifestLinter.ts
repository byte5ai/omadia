/**
 * Manifest-Linter (B.8) — second-tier validation gate after the B.7 tsc-
 * gate + Content-Guard. Catches semantic issues that compile cleanly but
 * crash at install / runtime:
 *
 *   - depends_on entries that don't resolve to a known plugin id
 *   - depends_on self-reference (loop)
 *   - duplicate tool ids within the spec
 *   - tool ids that don't match the snake_case regex
 *   - network.outbound hosts that are wildcards / URLs / non-host strings
 *   - setup_fields with duplicate keys
 *   - spec.id in a reserved namespace (collision with platform built-ins)
 *
 * Pure data-in / data-out — no I/O, no side effects. Wired into
 * patch_spec / fill_slot in B.8-2 as an additional gate.
 *
 * Design notes:
 *   - Single-call surface (`validateSpec`). Sub-checks are inlined to
 *     keep the violation list ordered (read top-to-bottom matches the
 *     spec field order).
 *   - Cross-ref data flows in via the optional `knownPluginIds`
 *     provider. When omitted (or empty), the depends_on resolvability
 *     check is skipped — useful for unit tests that don't want to wire
 *     a fake catalog.
 *   - Capability-vocabulary check is reserved for when AgentSpec
 *     finally carries an explicit `capabilities[]` field; today the
 *     codegen derives capabilities from `tools[]` so there is nothing
 *     to validate at the spec level.
 */

import { lookupServiceType } from './serviceTypeRegistry.js';
import type { AgentSpecSkeleton } from './types.js';

export type ViolationKind =
  | 'depends_on_unresolvable'
  | 'depends_on_self_reference'
  | 'tool_id_duplicate'
  | 'tool_id_invalid_syntax'
  | 'network_outbound_invalid'
  | 'setup_field_key_duplicate'
  | 'reserved_id'
  | 'external_read_unknown_service'
  | 'external_read_integration_missing';

export interface ManifestViolation {
  kind: ViolationKind;
  /** JSON-pointer to the offending field, e.g. "/depends_on/0", "/tools/2/id". */
  path: string;
  message: string;
}

export interface ValidateSpecOptions {
  /** Provider for the set of known plugin ids (built-in + installed).
   *  When omitted or empty, depends_on resolvability is NOT checked
   *  (lets unit tests skip the dependency entirely). */
  knownPluginIds?: () => readonly string[];
  /** Override reserved-namespace prefixes. Defaults to platform / core. */
  reservedIdPrefixes?: ReadonlyArray<string>;
}

const DEFAULT_RESERVED_PREFIXES: ReadonlyArray<string> = [
  'de.byte5.platform.',
  'core.',
];

const TOOL_ID_RE = /^[a-z][a-z0-9_]*$/;
/** Bare hostname: at least one label + dot + TLD ≥ 2 chars. No protocol,
 *  no wildcard, no path. Case-insensitive. */
const HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

export interface ValidateSpecResult {
  ok: boolean;
  violations: ManifestViolation[];
}

export function validateSpec(
  spec: unknown,
  opts: ValidateSpecOptions = {},
): ValidateSpecResult {
  const violations: ManifestViolation[] = [];
  const reservedPrefixes = opts.reservedIdPrefixes ?? DEFAULT_RESERVED_PREFIXES;
  const known = new Set(opts.knownPluginIds?.() ?? []);

  const s = (spec ?? {}) as AgentSpecSkeleton;
  const specId = typeof s.id === 'string' ? s.id : null;

  // 7. Reserved IDs (checked first so the violation list stays at the
  //    top when a brand-new agent picks a forbidden prefix).
  if (specId) {
    for (const prefix of reservedPrefixes) {
      if (specId.startsWith(prefix)) {
        violations.push({
          kind: 'reserved_id',
          path: '/id',
          message:
            `spec.id '${specId}' is in the reserved namespace '${prefix}*'. ` +
            'Pick a different prefix (e.g. `de.byte5.agent.<your-name>`).',
        });
        break;
      }
    }
  }

  // 1+1b. depends_on resolvable + self-reference
  const depsOn = Array.isArray(s.depends_on) ? s.depends_on : [];
  depsOn.forEach((dep, i) => {
    if (typeof dep !== 'string') return;
    if (specId && dep === specId) {
      violations.push({
        kind: 'depends_on_self_reference',
        path: `/depends_on/${String(i)}`,
        message: `depends_on[${String(i)}] references its own spec.id ('${dep}'). Remove the self-reference.`,
      });
      return;
    }
    if (known.size > 0 && !known.has(dep)) {
      violations.push({
        kind: 'depends_on_unresolvable',
        path: `/depends_on/${String(i)}`,
        message:
          `depends_on entry '${dep}' is not in the installed plugin catalog. ` +
          'Install the dependency first, or correct the id.',
      });
    }
  });

  // 2+3. tools[].id duplicates + syntactic check
  const tools = Array.isArray(s.tools) ? (s.tools as unknown[]) : [];
  const toolIdIndices = new Map<string, number[]>();
  tools.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const id = (t as { id?: unknown }).id;
    if (typeof id !== 'string') return;
    if (!TOOL_ID_RE.test(id)) {
      violations.push({
        kind: 'tool_id_invalid_syntax',
        path: `/tools/${String(i)}/id`,
        message:
          `tool id '${id}' must be snake_case (lowercase letters, digits, ` +
          `underscore; start with a letter). E.g. 'get_forecast'.`,
      });
    }
    const list = toolIdIndices.get(id) ?? [];
    list.push(i);
    toolIdIndices.set(id, list);
  });
  for (const [id, indices] of toolIdIndices) {
    if (indices.length > 1) {
      const first = indices[0] ?? 0;
      violations.push({
        kind: 'tool_id_duplicate',
        path: `/tools/${String(first)}/id`,
        message:
          `tool id '${id}' is duplicated at indices ${indices.join(', ')}. ` +
          'Each tool must have a unique id.',
      });
    }
  }

  // 5. network.outbound[] hosts
  const network = (s as { network?: { outbound?: unknown } }).network;
  const outbound = Array.isArray(network?.outbound) ? network.outbound : [];
  outbound.forEach((host, i) => {
    if (typeof host !== 'string') return;
    const invalid =
      host.length === 0 ||
      host.includes('://') ||
      host.includes('*') ||
      host.includes('/') ||
      !HOST_RE.test(host);
    if (invalid) {
      violations.push({
        kind: 'network_outbound_invalid',
        path: `/network/outbound/${String(i)}`,
        message:
          `network.outbound[${String(i)}] '${host}' must be a bare hostname ` +
          `(no protocol, no wildcards, no path; must contain a TLD). ` +
          `E.g. 'api.example.com'.`,
      });
    }
  });

  // 8+9. external_reads[] surface checks (Theme A). Each entry binds a
  //      `service` name to a typed lookup at codegen time; both the
  //      service-name and the providing plugin must resolve, otherwise
  //      the generated code crashes at activate() time with an
  //      unhelpful `ctx.services.get('...')` returned `undefined` error.
  const externalReads = Array.isArray(
    (s as { external_reads?: unknown }).external_reads,
  )
    ? ((s as { external_reads: unknown[] }).external_reads)
    : [];
  externalReads.forEach((er, i) => {
    if (!er || typeof er !== 'object') return;
    const svcName = (er as { service?: unknown }).service;
    if (typeof svcName !== 'string' || svcName.length === 0) return;
    const reg = lookupServiceType(svcName);
    if (!reg) {
      violations.push({
        kind: 'external_read_unknown_service',
        path: `/external_reads/${String(i)}/service`,
        message:
          `external_reads[${String(i)}].service '${svcName}' is not a known ` +
          'service. See `serviceTypeRegistry.ts` for the supported names ' +
          "(e.g. 'odoo.client', 'confluence.client', 'microsoft365.graph').",
      });
      return;
    }
    if (!depsOn.includes(reg.providedBy)) {
      violations.push({
        kind: 'external_read_integration_missing',
        path: `/external_reads/${String(i)}/service`,
        message:
          `external_reads[${String(i)}].service '${svcName}' is provided by ` +
          `'${reg.providedBy}' but spec.depends_on does not include it. ` +
          `Add '${reg.providedBy}' to depends_on so the service resolves at activate-time.`,
      });
    }
  });

  // 6. setup_fields[].key unique
  const setupFields = Array.isArray(s.setup_fields) ? (s.setup_fields as unknown[]) : [];
  const setupKeyIndices = new Map<string, number[]>();
  setupFields.forEach((f, i) => {
    if (!f || typeof f !== 'object') return;
    const key = (f as { key?: unknown }).key;
    if (typeof key !== 'string') return;
    const list = setupKeyIndices.get(key) ?? [];
    list.push(i);
    setupKeyIndices.set(key, list);
  });
  for (const [key, indices] of setupKeyIndices) {
    if (indices.length > 1) {
      const first = indices[0] ?? 0;
      violations.push({
        kind: 'setup_field_key_duplicate',
        path: `/setup_fields/${String(first)}/key`,
        message:
          `setup_fields key '${key}' is duplicated at indices ${indices.join(', ')}. ` +
          'Each field must have a unique key.',
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

export function formatViolations(violations: readonly ManifestViolation[]): string {
  if (violations.length === 0) return 'no manifest violations';
  return violations.map((v) => `[${v.kind}] ${v.path}: ${v.message}`).join('\n');
}
