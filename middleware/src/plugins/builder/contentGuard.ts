/**
 * ContentGuard — rule-based diff that detects silent capability loss
 * during AgentSpec mutations. Sits inside `patch_spec` between the raw
 * JSON-Patch application and the draft-store write: if the next spec
 * silently removes tools / capabilities / depends_on / network.outbound
 * entries that the previous spec declared, the patch is rejected with a
 * structured violation list so the LLM can either re-issue with the
 * removal acknowledged or restore the dropped entry.
 *
 * Rationale (B.7-3): the Builder-Agent loops on `fill_slot` until tsc is
 * green (B.7-2). A naive way to make tsc happy is to drop the offending
 * tool from the spec and the matching toolkit handler. Without this
 * guard, that capability silently disappears from the user's plugin and
 * the user only notices when the installed agent fails at runtime.
 *
 * The check is strictly set-shrink-only: ADDING new tools/caps/etc. is
 * always allowed; REMOVING is allowed iff the user's most recent message
 * mentions the removed id (case-insensitive substring match — bewusst
 * lax, false-positives are cheaper than false-negatives because silent
 * removal is the higher-impact failure).
 */

import type { AgentSpecSkeleton } from './types.js';

export interface ContentGuardViolation {
  field: 'tools' | 'setup_fields' | 'depends_on' | 'network.outbound';
  removed: readonly string[];
  message: string;
}

export interface ContentGuardResult {
  ok: boolean;
  violations: ContentGuardViolation[];
}

export interface CheckSpecDeltaOptions {
  /**
   * The user's most recent message text. Used to detect explicit removal
   * intent — if any removed id/name appears as a case-insensitive
   * substring of this string, the violation is downgraded to allowed.
   * Empty / undefined ⇒ no override (every removal triggers).
   */
  userIntent?: string;
}

export function checkSpecDelta(
  prev: unknown,
  next: unknown,
  opts: CheckSpecDeltaOptions = {},
): ContentGuardResult {
  const prevSpec = (prev ?? {}) as AgentSpecSkeleton;
  const nextSpec = (next ?? {}) as AgentSpecSkeleton;
  const userIntent = (opts.userIntent ?? '').toLowerCase();

  const violations: ContentGuardViolation[] = [];

  const removedTools = filterUnacknowledged(
    setDiff(extractToolIds(prevSpec), extractToolIds(nextSpec)),
    userIntent,
  );
  if (removedTools.length > 0) {
    violations.push({
      field: 'tools',
      removed: removedTools,
      message:
        `would silently remove tool(s): ${removedTools.join(', ')}. ` +
        'If this is intentional, restate the removal in the user-facing chat ' +
        '(or echo the tool name in your reasoning before patching) so the ' +
        'guard can confirm intent. Otherwise, add the tool back to the patch.',
    });
  }

  const removedSetupFields = filterUnacknowledged(
    setDiff(extractSetupFieldKeys(prevSpec), extractSetupFieldKeys(nextSpec)),
    userIntent,
  );
  if (removedSetupFields.length > 0) {
    violations.push({
      field: 'setup_fields',
      removed: removedSetupFields,
      message:
        `would silently remove setup_field(s): ${removedSetupFields.join(', ')}. ` +
        'These are credential/configuration inputs the user already filled — ' +
        'dropping them silently would orphan stored vault entries.',
    });
  }

  const removedDeps = filterUnacknowledged(
    setDiff(extractStringArray(prevSpec, 'depends_on'), extractStringArray(nextSpec, 'depends_on')),
    userIntent,
  );
  if (removedDeps.length > 0) {
    violations.push({
      field: 'depends_on',
      removed: removedDeps,
      message: `would silently remove depends_on entry: ${removedDeps.join(', ')}.`,
    });
  }

  const removedHosts = filterUnacknowledged(
    setDiff(
      extractNestedStringArray(prevSpec, 'network', 'outbound'),
      extractNestedStringArray(nextSpec, 'network', 'outbound'),
    ),
    userIntent,
  );
  if (removedHosts.length > 0) {
    violations.push({
      field: 'network.outbound',
      removed: removedHosts,
      message: `would silently remove network.outbound host: ${removedHosts.join(', ')}.`,
    });
  }

  return { ok: violations.length === 0, violations };
}

/** Convenience formatter for tool-result `error` fields. */
export function formatViolations(violations: readonly ContentGuardViolation[]): string {
  if (violations.length === 0) return 'no content-guard violations';
  return violations.map((v) => `[${v.field}] ${v.message}`).join('\n');
}

function extractToolIds(spec: unknown): string[] {
  const tools = (spec as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (t && typeof t === 'object' ? (t as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string');
}

function extractSetupFieldKeys(spec: unknown): string[] {
  const fields = (spec as { setup_fields?: unknown }).setup_fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .map((f) => (f && typeof f === 'object' ? (f as { key?: unknown }).key : undefined))
    .filter((k): k is string => typeof k === 'string');
}

function extractStringArray(spec: unknown, field: string): string[] {
  const v = (spec as Record<string, unknown>)[field];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function extractNestedStringArray(spec: unknown, parent: string, child: string): string[] {
  const p = (spec as Record<string, unknown>)[parent];
  if (p === null || typeof p !== 'object') return [];
  const c = (p as Record<string, unknown>)[child];
  if (!Array.isArray(c)) return [];
  return c.filter((x): x is string => typeof x === 'string');
}

function setDiff(prev: readonly string[], next: readonly string[]): string[] {
  const nextSet = new Set(next);
  return prev.filter((x) => !nextSet.has(x));
}

function filterUnacknowledged(
  removed: readonly string[],
  userIntent: string,
): string[] {
  if (userIntent.length === 0) return [...removed];
  return removed.filter((id) => !userIntent.includes(id.toLowerCase()));
}
