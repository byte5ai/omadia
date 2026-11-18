import type { Predicate } from '@omadia/conductor-core';

import { postWebhook } from './webhookOutbound.js';

/**
 * Issue #437 — the `webhook.post` built-in Designer action: an `action` step whose
 * `actionId` is this constant fires an ad-hoc outbound POST to an operator-supplied
 * URL, still behind the shared SSRF guard (`webhookOutbound.ts`). Registered as a
 * built-in in `index.ts` (prepended to the action catalog + special-cased ahead of
 * `dynamicAgentRuntime.invokeAgentTool`) rather than requiring an installed plugin.
 *
 * Unlike the run-lifecycle dispatcher, an ad-hoc step has no subscription/secret to
 * sign with — the workflow author supplies the request shape directly in `step.input`,
 * which is graph JSON. Deliberately NOT wired to Vault-held secrets here: a step
 * needing an authenticated header should reference a plugin connector action instead
 * (`webhook.post` covers the "call an arbitrary/public URL" case in the acceptance
 * criteria, not authenticated delivery).
 */

export const WEBHOOK_POST_ACTION_ID = 'webhook.post';

/**
 * Issue #1703 — the exit postcondition a `webhook.post` step gets when its author
 * declared none: the delivery counts as a step failure unless the receiver answered 2xx.
 *
 * The action keeps REPORTING the refusal in its result (`{ ok: false, status }`) rather
 * than throwing, because a throw is caught by the run executor before the engine ever
 * runs — it ends the run with no transition, so a graph could never take its error path.
 * As a postcondition the same refusal becomes `unmet`, which fires the step's
 * `fallbackTransitionId` (FR-024) and, when none is declared, surfaces as the
 * `postcondition_unmet_no_fallback` stuck decision. Either way the run ends `failed`
 * and the step's recorded `postcondition_outcome` is `unmet`, next to the `status` the
 * result put in the run context.
 *
 * Applied by `RealStepEffects.runActionStep`; a step that declares its own postcondition
 * (to tolerate a 404, say, or to branch on `status`) is evaluated on that alone.
 */
export const WEBHOOK_POST_DEFAULT_POSTCONDITION: Predicate = {
  op: 'eq',
  path: 'stepResult.data.ok',
  value: true,
};

const MAX_HEADERS = 20;
const MAX_HEADER_LEN = 4_096;
const MAX_BODY_BYTES = 256 * 1024;

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Keep only string→string entries, dropping anything else — bounds count + length
 *  so a malformed/hostile graph can't build an oversized request. */
function normalizeHeaders(v: unknown): Record<string, string> {
  const src = asRecord(v);
  const out: Record<string, string> = {};
  let n = 0;
  for (const [key, value] of Object.entries(src)) {
    if (n >= MAX_HEADERS) break;
    if (typeof value !== 'string') continue;
    if (key.length > MAX_HEADER_LEN || value.length > MAX_HEADER_LEN) continue;
    // The signature/delivery-id headers are dispatcher-owned; an ad-hoc step must
    // never spoof them on an unrelated request.
    if (key.toLowerCase().startsWith('x-omadia-')) continue;
    out[key] = value;
    n += 1;
  }
  return out;
}

/**
 * `invokeAction`-compatible handler: `(toolId, input) => Promise<string | undefined>`.
 * Input shape: `{ url: string, body?: object, headers?: Record<string,string> }`.
 * Returns a JSON string (the action-step result contract): `{ ok, status }`, where
 * `ok` is the receiver's 2xx-ness.
 *
 * A non-2xx is reported, NOT thrown (issue #1703) — see
 * `WEBHOOK_POST_DEFAULT_POSTCONDITION` for why, and for what makes the refusal fail
 * the step. A guard rejection (`WebhookUrlNotAllowedError`), an oversized body and a
 * transport error still throw: those produce no response to branch on.
 *
 * `deps.send` is a test seam, like `ConductorWebhookDispatcher`'s `sendRequest`;
 * production leaves it unset.
 */
export async function invokeWebhookPostAction(
  input: unknown,
  deps: { send?: typeof postWebhook } = {},
): Promise<string> {
  const obj = asRecord(input);
  const url = typeof obj.url === 'string' ? obj.url.trim() : '';
  if (!url) throw new Error("webhook.post: 'url' is required");

  const body = asRecord(obj.body);
  const bodyStr = JSON.stringify(body);
  if (Buffer.byteLength(bodyStr, 'utf8') > MAX_BODY_BYTES) {
    throw new Error(`webhook.post: body exceeds ${String(MAX_BODY_BYTES)} bytes`);
  }

  const result = await (deps.send ?? postWebhook)({
    url,
    headers: { 'content-type': 'application/json', ...normalizeHeaders(obj.headers) },
    body: bodyStr,
  });
  return JSON.stringify({ ok: result.ok, status: result.status });
}
