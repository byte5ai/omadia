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
 * Returns a JSON string (the action-step result contract) describing the response.
 */
export async function invokeWebhookPostAction(input: unknown): Promise<string> {
  const obj = asRecord(input);
  const url = typeof obj.url === 'string' ? obj.url.trim() : '';
  if (!url) throw new Error("webhook.post: 'url' is required");

  const body = asRecord(obj.body);
  const bodyStr = JSON.stringify(body);
  if (Buffer.byteLength(bodyStr, 'utf8') > MAX_BODY_BYTES) {
    throw new Error(`webhook.post: body exceeds ${String(MAX_BODY_BYTES)} bytes`);
  }

  const result = await postWebhook({
    url,
    headers: { 'content-type': 'application/json', ...normalizeHeaders(obj.headers) },
    body: bodyStr,
  });
  return JSON.stringify({ ok: result.ok, status: result.status });
}
