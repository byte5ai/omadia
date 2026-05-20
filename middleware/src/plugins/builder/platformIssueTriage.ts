import { createHash } from 'node:crypto';

import type { BuildError } from './buildErrorParser.js';
import type { InstallFailure } from './installCommit.js';
import type { ToolSmokeResult, AdminRouteSmokeResult } from './runtimeSmoke.js';
import { FORBIDDEN_INTERNAL_PACKAGES } from './forbiddenInternalPackages.js';

/**
 * Platform-issue triage (concept plan: docs/plans/native-issue-reporting.md).
 *
 * Two-stage pipeline that decides whether a build/runtime failure
 * represents a platform bug worth reporting as a GitHub issue, or merely
 * an agent-spec problem the operator should fix in their own draft.
 *
 *   Stage 1 — deterministic gate: only failures originating from core
 *   packages (forbidden-import gate hits, codegen-internal errors,
 *   schema violations on built-in routes, build/runtime failures whose
 *   stack frames point into the platform) become candidates. Agent-spec
 *   problems (slot validation, lint, manifest conflicts) are dropped
 *   immediately — they are never platform bugs.
 *
 *   Stage 2 — LLM triage: an Anthropic-backed prompt classifies the
 *   candidate as 'Platform' | 'Agent' | 'Ambiguous' with a confidence
 *   score in [0, 1]. Only 'Platform' with confidence >= 0.7 reaches
 *   the operator as an issue suggestion. The threshold is intentionally
 *   conservative — false negatives (we miss a real bug) are cheaper
 *   than false positives (we spam the upstream repo).
 *
 * Fingerprints are stable hashes of the normalized stack-frame path
 * plus error code, suitable for de-duplicating identical failures
 * across operators without exposing source paths verbatim.
 */

export type TriageClassification = 'platform' | 'agent' | 'ambiguous';

export interface TriageResult {
  classification: TriageClassification;
  /** [0, 1]. Always 1.0 for outcomes resolved by the deterministic gate. */
  confidence: number;
  /** Operator-facing one-liner explaining why this classification was chosen. */
  reason: string;
}

/** Result of the deterministic gate (Stage 1). */
export type GateResult =
  | { kind: 'platform-candidate'; markers: GateMarker[] }
  | { kind: 'agent'; markers: GateMarker[] }
  | { kind: 'unknown' };

export type GateMarker =
  | 'forbidden-import'
  | 'codegen-internal'
  | 'ingest-internal'
  | 'core-stack-frame'
  | 'admin-route-schema-violation'
  | 'agent-spec-validation';

/**
 * Subset of failure context the triage layer cares about. Callers pass
 * the parts they have; the gate only inspects what is present. This
 * decouples the triage from the exact shape of installCommit /
 * runtimeSmoke results — future fields land here without ripple
 * changes.
 */
export interface TriageContext {
  /** A short summary of the failure as the operator would see it. */
  summary: string;
  /** Failing tsc / build errors, if available. */
  buildErrors?: BuildError[];
  /** Discriminated install-pipeline failure, if available. */
  installFailure?: Pick<InstallFailure, 'reason' | 'code' | 'message'> & {
    details?: unknown;
  };
  /** Runtime-smoke tool results, if available. */
  toolResults?: ToolSmokeResult[];
  /** Runtime-smoke admin-route results, if available. */
  adminRouteResults?: AdminRouteSmokeResult[];
  /** Raw stderr/stdout tails, if available. */
  stderrTail?: string;
  /** When set, the gate uses this list of core-package path prefixes
   *  instead of the default. Test seam. */
  corePathPrefixes?: readonly string[];
}

/**
 * Minimal contract for the LLM triage client. Implementations route to
 * Anthropic / Bedrock / a fixture. Returning a confidence < 0 or
 * NaN is normalized to 0 by the orchestrator.
 */
export interface TriageLlmClient {
  classify(input: {
    summary: string;
    gate: GateResult;
    contextExcerpt: string;
  }): Promise<TriageResult>;
}

export interface TriageDecision extends TriageResult {
  fingerprint: string;
  gate: GateResult;
  /** True when classification === 'platform' AND confidence >= threshold. */
  reportable: boolean;
}

/**
 * Default core-package path prefixes used by the deterministic gate.
 * A stack frame whose normalized path starts with any of these is
 * treated as a platform-side failure. Plugin slots live in
 * `<plugin>/src/slots/…` and never match.
 */
const DEFAULT_CORE_PATH_PREFIXES: readonly string[] = [
  'middleware/src/',
  'middleware/packages/harness-',
  'middleware/packages/plugin-api/',
  'middleware/packages/plugin-ui-helpers/',
  'packages/harness-',
  'packages/plugin-api/',
  'packages/plugin-ui-helpers/',
];

const PLATFORM_INGEST_REASONS = new Set<string>([
  // Reasons that should never come from operator-provided spec data:
  // they fire when the platform itself rejected its own output.
  'ingest_failed',
  'codegen_failed',
  'pipeline_failed',
]);

const AGENT_INGEST_REASONS = new Set<string>([
  // Reasons that always reflect an operator-side problem.
  'spec_invalid',
  'conflict',
  'too_large',
  'manifest_invalid',
  'draft_not_found',
]);

/**
 * Default reportable threshold for LLM-triaged candidates.
 */
export const DEFAULT_REPORTABLE_CONFIDENCE = 0.7;

/**
 * Hashes context into a stable de-dup fingerprint. Inputs are
 * normalized so cosmetic differences (column numbers, ms-timestamps,
 * randomized temp paths) do not split fingerprints across runs.
 */
export function computeFingerprint(context: {
  buildErrors?: BuildError[];
  installFailure?: { code?: string; reason?: string };
  toolResults?: ToolSmokeResult[];
  stderrTail?: string;
}): string {
  const hash = createHash('sha256');
  const code =
    context.installFailure?.code ??
    context.installFailure?.reason ??
    (context.buildErrors?.[0]?.code ?? 'unknown');
  hash.update(`code:${code}\n`);

  if (context.buildErrors && context.buildErrors.length > 0) {
    for (const err of context.buildErrors.slice(0, 5)) {
      hash.update(`tsc:${normalizePath(err.path)}:${err.code}\n`);
    }
  }
  if (context.toolResults && context.toolResults.length > 0) {
    for (const t of context.toolResults) {
      if (t.status === 'ok') continue;
      hash.update(`tool:${t.toolId}:${t.status}\n`);
    }
  }
  if (context.stderrTail) {
    for (const frame of extractStackFrames(context.stderrTail).slice(0, 3)) {
      hash.update(`frame:${normalizePath(frame)}\n`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Stage 1 — deterministic gate. Examines structured failure data and
 * decides which bucket the failure belongs in. Returns 'unknown' when
 * the gate has no opinion (the LLM-stage then takes over).
 */
export function classifyByGate(context: TriageContext): GateResult {
  const markers: GateMarker[] = [];
  const corePrefixes = context.corePathPrefixes ?? DEFAULT_CORE_PATH_PREFIXES;

  if (context.installFailure) {
    const reason = context.installFailure.reason;
    if (AGENT_INGEST_REASONS.has(reason)) {
      return { kind: 'agent', markers: ['agent-spec-validation'] };
    }
    if (PLATFORM_INGEST_REASONS.has(reason)) {
      markers.push(
        reason === 'codegen_failed' ? 'codegen-internal' : 'ingest-internal',
      );
    }
  }

  if (
    context.adminRouteResults?.some(
      (r) => r.status === 'schema_violation',
    )
  ) {
    markers.push('admin-route-schema-violation');
  }

  const combinedText = combineForScan(context);
  if (containsForbiddenImportHint(combinedText)) {
    markers.push('forbidden-import');
  }

  const frames = extractStackFrames(context.stderrTail ?? '');
  if (frames.some((f) => isCoreFrame(f, corePrefixes))) {
    markers.push('core-stack-frame');
  }
  if (
    context.buildErrors?.some((e) =>
      isCorePath(e.path, corePrefixes),
    )
  ) {
    markers.push('core-stack-frame');
  }

  if (markers.length === 0) {
    return { kind: 'unknown' };
  }
  return { kind: 'platform-candidate', markers };
}

/**
 * Two-stage classifier. The LLM is only invoked when the gate is
 * 'platform-candidate' or 'unknown'; gate-rejected agent failures
 * skip the LLM entirely.
 */
export async function classifyPlatformError(
  context: TriageContext,
  deps: {
    llm: TriageLlmClient;
    reportableConfidence?: number;
  },
): Promise<TriageDecision> {
  const gate = classifyByGate(context);
  const fingerprint = computeFingerprint(context);

  if (gate.kind === 'agent') {
    return {
      classification: 'agent',
      confidence: 1.0,
      reason: 'Deterministic gate matched an agent-spec failure pattern.',
      fingerprint,
      gate,
      reportable: false,
    };
  }

  const threshold = deps.reportableConfidence ?? DEFAULT_REPORTABLE_CONFIDENCE;
  const llmResult = await deps.llm.classify({
    summary: context.summary,
    gate,
    contextExcerpt: buildContextExcerpt(context),
  });

  const normalizedConfidence = Number.isFinite(llmResult.confidence)
    ? Math.min(Math.max(llmResult.confidence, 0), 1)
    : 0;

  const reportable =
    llmResult.classification === 'platform' && normalizedConfidence >= threshold;

  return {
    classification: llmResult.classification,
    confidence: normalizedConfidence,
    reason: llmResult.reason,
    fingerprint,
    gate,
    reportable,
  };
}

// ── internals ───────────────────────────────────────────────────────────────

/**
 * Path normalization: strip leading absolute prefixes, normalize
 * separators, drop line/column suffixes. The aim is "same source file,
 * same hash bucket" across machines, build dirs, and Windows vs.
 * Unix runs.
 */
function normalizePath(p: string): string {
  if (!p) return '';
  let s = p.replace(/\\/g, '/').trim();
  // Strip absolute leading bits and common build prefixes.
  s = s.replace(/^.*?(?=middleware\/|packages\/|web-ui\/|dist\/)/, '');
  // Drop trailing `:line:col` or `(line,col)` suffixes that some loaders attach.
  s = s.replace(/[:(]\d+[:,]\d+\)?$/, '');
  // Strip /home/... or /Users/... absolute prefixes if no known root matched.
  s = s.replace(/^\/(Users|home|var|tmp)\/[^/]+\//, '~/');
  return s;
}

function extractStackFrames(stderrOrTrace: string): string[] {
  if (!stderrOrTrace) return [];
  const frames: string[] = [];
  // Node-style frames: `at module.fn (/abs/path/file.js:42:7)`.
  // Also bare paths: `at /abs/path/file.js:42:7`.
  const re = /at\s+(?:[\w$.<>[\] ]+\s+\()?([^)\s]+:\d+:\d+)\)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderrOrTrace)) !== null) {
    if (m[1]) frames.push(m[1]);
    if (frames.length >= 20) break;
  }
  return frames;
}

function isCoreFrame(frame: string, corePrefixes: readonly string[]): boolean {
  const normalized = normalizePath(frame);
  return corePrefixes.some((p) => normalized.includes(p));
}

function isCorePath(p: string, corePrefixes: readonly string[]): boolean {
  const normalized = normalizePath(p);
  return corePrefixes.some((prefix) => normalized.includes(prefix));
}

function containsForbiddenImportHint(text: string): boolean {
  if (!text) return false;
  for (const specifier of FORBIDDEN_INTERNAL_PACKAGES.keys()) {
    if (text.includes(specifier)) return true;
  }
  // Generic markers the platform emits when a forbidden import was
  // rejected pre-build.
  if (/forbidden[\s_-]?import/i.test(text)) return true;
  if (/standalone[\s_-]?compile[\s_-]?contract/i.test(text)) return true;
  return false;
}

function combineForScan(context: TriageContext): string {
  const parts: string[] = [];
  if (context.summary) parts.push(context.summary);
  if (context.installFailure?.message) parts.push(context.installFailure.message);
  if (context.installFailure?.code) parts.push(context.installFailure.code);
  if (context.buildErrors) {
    for (const e of context.buildErrors) parts.push(e.message, e.path);
  }
  if (context.stderrTail) parts.push(context.stderrTail);
  return parts.join('\n');
}

function buildContextExcerpt(context: TriageContext): string {
  const lines: string[] = [];
  lines.push(`Summary: ${context.summary}`);
  if (context.installFailure) {
    lines.push(
      `Install failure: reason=${context.installFailure.reason} code=${context.installFailure.code}`,
    );
    lines.push(`Message: ${truncate(context.installFailure.message, 400)}`);
  }
  if (context.buildErrors && context.buildErrors.length > 0) {
    lines.push(`Build errors (first 5):`);
    for (const e of context.buildErrors.slice(0, 5)) {
      lines.push(`  ${e.path}:${String(e.line)}:${String(e.col)} ${e.code} ${truncate(e.message, 200)}`);
    }
  }
  if (context.toolResults && context.toolResults.length > 0) {
    const failing = context.toolResults.filter((t) => t.status !== 'ok');
    if (failing.length > 0) {
      lines.push(`Tool smoke failures:`);
      for (const t of failing) {
        lines.push(`  ${t.toolId}: ${t.status} ${truncate(t.errorMessage ?? '', 200)}`);
      }
    }
  }
  if (context.stderrTail) {
    lines.push(`Stderr tail:\n${truncate(context.stderrTail, 800)}`);
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
