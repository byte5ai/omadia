import type { DevGateView } from '@/app/admin/dev-platform/_lib/api';

/**
 * Epic #470 W3 — pure helpers for the chat job card. Kept framework-free so the
 * parse + gate-matching logic is unit-testable without a DOM.
 *
 * Delivery mechanism note: a dev job launched from chat surfaces as a normal
 * `dev_job_start` tool call in the chat stream (a `tool_use` paired with its
 * `tool_result`). The tool result is the documented §3 contract string
 * `{"status":"job_started","jobId":…,"repoId":…,"phase":"queued"}`. The chat UI
 * detects that call, parses the seed below, and mounts a live card that
 * subscribes to the W0 job-event SSE tail (`/jobs/:id/events`). No separate
 * `dev_job_card` stream event is needed — the tool_use/tool_result pair already
 * reaches the web-ui, per-turn and per-session correct.
 */

/** The seed a `dev_job_start` tool result carries into the live card. */
export interface DevJobCardSeed {
  jobId: string;
  repoId: string;
  phase: string;
}

/**
 * Parse a `dev_job_start` tool-result string. Returns the card seed only for a
 * successful launch (`status === 'job_started'` with string `jobId`/`repoId`);
 * returns `null` for a refusal/`Error:` string or any non-launch payload, so the
 * caller falls back to the plain tool row.
 */
export function parseDevJobStartResult(output: string | undefined): DevJobCardSeed | null {
  if (!output) return null;
  const trimmed = output.trim();
  if (!trimmed.startsWith('{')) return null; // `Error: …` and prose never parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj['status'] !== 'job_started') return null;
  const jobId = obj['jobId'];
  const repoId = obj['repoId'];
  if (typeof jobId !== 'string' || jobId.length === 0) return null;
  if (typeof repoId !== 'string') return null;
  const phase = typeof obj['phase'] === 'string' ? obj['phase'] : 'queued';
  return { jobId, repoId, phase };
}

/**
 * Find the waiting gate that belongs to a job. The gate inbox
 * (`GET /gates?status=waiting`) is job-keyed; a job parks at exactly one gate at
 * a time, so the first match wins. Returns `null` when the job is not gated.
 */
export function findGateForJob(
  gates: readonly DevGateView[],
  jobId: string,
): DevGateView | null {
  return gates.find((g) => g.jobId === jobId) ?? null;
}
