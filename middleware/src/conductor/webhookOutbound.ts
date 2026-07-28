import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

import { fetch as undiciFetch } from 'undici';

import { createGuardedAgent, isPublicIp } from '../platform/ssrfGuard.js';

/**
 * Shared outbound-HTTP plumbing for Conductor webhooks (issue #437): the
 * run-lifecycle dispatcher (`webhookDispatcher.ts`) and the ad-hoc `webhook.post`
 * Designer action both call `postWebhook`, so the SSRF guard and request shape
 * never drift between the two call sites.
 *
 * Reuses the SAME defence `httpAccessor.ts` applies to plugin `public-web` scans
 * (see `platform/ssrfGuard.ts`): a literal-IP pre-check up front (never triggers
 * DNS), plus a guarded undici `Agent` whose custom `lookup` re-validates every
 * resolved address at connect time — closing the DNS-rebinding gap a hostname
 * allow-check alone would leave open.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

/** Thrown for any URL a Conductor webhook may not target (bad scheme, private /
 *  loopback / link-local / metadata address). Callers surface this as a 4xx. */
export class WebhookUrlNotAllowedError extends Error {}

/** Validate scheme + literal-IP host. Does NOT resolve DNS — the guarded agent in
 *  `postWebhook` re-checks every resolved address at connect time, so a hostname
 *  that later rebinds to a private address is still blocked. */
export function assertOutboundUrlAllowed(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WebhookUrlNotAllowedError(`invalid URL '${rawUrl}'`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebhookUrlNotAllowedError(`only http/https URLs are permitted (got '${parsed.protocol}')`);
  }
  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (isIP(host) !== 0 && !isPublicIp(host)) {
    throw new WebhookUrlNotAllowedError(`'${host}' is a private, loopback, link-local or otherwise non-public address`);
  }
  return parsed;
}

/** `sha256=<hex>` HMAC over the exact bytes sent — the receiver recomputes it over
 *  the raw request body it read, mirroring the inbound route's own verification. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export interface PostWebhookResult {
  ok: boolean;
  status: number;
  bodySnippet: string;
}

/**
 * POST `body` to `url` behind the SSRF-guarded dispatcher, with the signature +
 * delivery headers already attached by the caller. Throws `WebhookUrlNotAllowedError`
 * (pre-check) or lets a network/guard error (DNS rebind, timeout, connection refused)
 * propagate — callers treat any throw or a non-2xx `status` as a failed attempt.
 */
export async function postWebhook(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
}): Promise<PostWebhookResult> {
  assertOutboundUrlAllowed(input.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    // The guarded Agent's `lookup` re-validates every resolved address before undici
    // connects to it — a rebind between `assertOutboundUrlAllowed` and now is refused
    // there (as a plain connect error), not silently permitted.
    const res = await undiciFetch(input.url, {
      method: 'POST',
      headers: input.headers,
      body: input.body,
      dispatcher: createGuardedAgent(),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.status >= 200 && res.status < 300, status: res.status, bodySnippet: text.slice(0, MAX_RESPONSE_BODY_BYTES) };
  } finally {
    clearTimeout(timer);
  }
}
