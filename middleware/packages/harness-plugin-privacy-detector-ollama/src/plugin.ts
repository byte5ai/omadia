/**
 * @omadia/plugin-privacy-detector-ollama — plugin entry point.
 *
 * Activation wiring:
 *   1. Read setup fields (endpoint, model, max-input, timeout).
 *   2. Probe the sidecar's `/api/tags` once for visibility (fail-open
 *      — a Down sidecar logs but does not abort activation; per-call
 *      detect() returns zero hits when the sidecar is unreachable).
 *   3. Resolve the `privacyDetectorRegistry` service published by
 *      `harness-plugin-privacy-guard` (Slice 3.1) and register the
 *      Ollama NER detector with it. Throws if the registry is absent
 *      — that means privacy-guard is not installed, which is a
 *      configuration error the operator must fix.
 *   4. Return a `close()` handle that unregisters the detector on
 *      deactivate.
 *
 * Manifest declares `requires: ['privacy.detector@1']` so the kernel's
 * capability resolver activates privacy-guard before this plugin and
 * the registry lookup at step 3 is guaranteed to succeed.
 */

import {
  PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
  type PluginContext,
  type PrivacyDetectorRegistry,
} from '@omadia/plugin-api';

import { createOllamaNerDetector } from './nerDetector.js';
import { createOllamaChatClient } from './ollamaClient.js';

export interface OllamaDetectorPluginHandle {
  close(): Promise<void>;
}

const DEFAULT_ENDPOINT = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2:3b';
// Slice 3.2.1 raises the input-budget default from 8000 → 32000 so real
// tenant turns (system-prompt with memory + tool-doc easily hits 22kb)
// don't hit the skip path. Operators can crank it down for speed.
const DEFAULT_MAX_INPUT_CHARS = 32_000;
// Slice 3.2.1 raises the timeout default from 5s → 15s so a 3b model on
// commodity hardware can warm-load + generate JSON inside the deadline.
// 5s consistently fail-opened on the john.doe smoke; 15s leaves
// breathing room for cold first-call without making the user wait
// forever (orchestrator turn already shows tool-trace progress).
const DEFAULT_TIMEOUT_MS = 15_000;

export async function activate(
  ctx: PluginContext,
): Promise<OllamaDetectorPluginHandle> {
  ctx.log('[privacy-detector-ollama] activating');

  const enabled = readBoolean(ctx, 'enabled', false);

  const registry = ctx.services.get<PrivacyDetectorRegistry>(
    PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
  );
  if (registry === undefined) {
    throw new Error(
      `[privacy-detector-ollama] requires the '${PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME}' service — ` +
        'install @omadia/plugin-privacy-guard before this plugin.',
    );
  }

  // Off by default: a 3B-model /api/chat round-trip is ~10-15s on
  // commodity hardware and would gate every chat turn on the slowest
  // detector. Operators that need higher recall on free-text PII flip
  // `enabled: true` in the post-install editor; everyone else gets fast
  // chats backed by regex + Presidio (sub-millisecond) with the Ollama
  // detector visible but inert in the Store UI.
  if (!enabled) {
    ctx.log(
      '[privacy-detector-ollama] ready (disabled — enable in Store UI to opt in to free-text NER detection)',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[privacy-detector-ollama] deactivating');
      },
    };
  }

  const endpoint = readString(ctx, 'ollama_endpoint', DEFAULT_ENDPOINT);
  const model = readString(ctx, 'ollama_model', DEFAULT_MODEL);
  const maxInputChars = readNumber(
    ctx,
    'ollama_max_input_chars',
    DEFAULT_MAX_INPUT_CHARS,
  );
  const timeoutMs = readNumber(ctx, 'ollama_timeout_ms', DEFAULT_TIMEOUT_MS);

  const client = createOllamaChatClient({ baseUrl: endpoint });

  // Boot-time visibility ping. Awaited intentionally — a down sidecar at
  // boot is the kind of thing the operator wants surfaced in the same
  // log line as activation. We do NOT abort if it fails: per-call
  // detect() already fail-opens, so a sidecar that comes up later still
  // contributes hits.
  const sidecarOk = await client.health().catch(() => false);

  const detectorId = `ollama:${model}`;
  const detector = createOllamaNerDetector({
    client,
    model,
    detectorId,
    maxInputChars,
    timeoutMs,
    log: (msg) => ctx.log(msg),
  });

  const dispose = registry.register(detector);

  ctx.log(
    `[privacy-detector-ollama] ready (endpoint=${endpoint}, model=${model}, ` +
      `sidecar=${sidecarOk ? 'ok' : 'unreachable'}, max_input_chars=${maxInputChars}, ` +
      `timeout_ms=${timeoutMs})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[privacy-detector-ollama] deactivating');
      dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Config readers — tolerate missing/malformed inputs by falling back to
// safe defaults so a half-configured plugin still boots.
// ---------------------------------------------------------------------------

function readString(ctx: PluginContext, key: string, fallback: string): string {
  const raw = ctx.config.get<unknown>(key);
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return fallback;
}

function readNumber(ctx: PluginContext, key: string, fallback: number): number {
  const raw = ctx.config.get<unknown>(key);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function readBoolean(
  ctx: PluginContext,
  key: string,
  fallback: boolean,
): boolean {
  const raw = ctx.config.get<unknown>(key);
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
  }
  return fallback;
}
