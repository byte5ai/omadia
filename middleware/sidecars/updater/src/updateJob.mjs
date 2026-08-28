/**
 * The update itself (#432, slice 4) — platform-independent since #696.
 *
 * Sequencing is the safety property here, so it is spelled out rather than
 * inferred:
 *
 *   1. resolve every target FIRST — an unknown or scaled service aborts before
 *      anything is touched
 *   2. verify EVERY new image is available before replacing ANY instance — a
 *      typo'd tag or a registry outage must not be discovered halfway through,
 *      with the middleware already gone
 *   3. persist the chosen version where the platform's own tooling will read
 *      it, so the operator's next routine deploy does not silently revert the
 *      stack (compose only — see `canPersistPin`)
 *   4. replace in the configured order (middleware before web-ui: it applies
 *      the schema migrations at boot)
 *   5. gate EVERY replaced service on its own `/health` REPORTING THE NEW
 *      VERSION — not just the middleware's, or a web-ui that never came up
 *      would ride along on the middleware's answer
 *   6. on failure, roll every replaced instance back to its previous image and
 *      restore the previous pin
 *
 * What rollback does NOT undo: schema migrations. The kernel migrations under
 * `middleware/migrations/` are forward-only and are applied automatically at
 * boot by the harness-orchestrator plugin, so a rolled-back image can meet a
 * migrated database. That is documented in docs/upgrading.md as the reason to
 * snapshot the volume before a major bump; it is not something this sidecar
 * can honestly promise away.
 */

import { PROTECTED_SERVICES } from './config.mjs';
import { waitForHealthyVersion } from './health.mjs';

export { detectComposeProject } from './engine/docker.mjs';

/**
 * The six numbered steps above, as a machine-readable progress marker. The
 * free-text trail (`log`) is for humans reading a log; the phase is what the
 * admin page renders as a stepper, so it must not depend on parsing English.
 *
 * @typedef {'resolve' | 'preflight' | 'pin' | 'replace' | 'health_gate' | 'rollback' | 'done'} UpdatePhase
 */

/**
 * Why an update did not land, in a shape the UI can decode without parsing
 * the human-readable `error` string.
 *
 *   - `health_gate` — every service was replaced but one of them never
 *     reported the target version. `service` names which, `reason` is the
 *     health waiter's verdict (`never_reachable` / `version_never_matched`),
 *     `observedVersion` what its `/health` last said, if anything.
 *   - `replace` — a service could not be moved to the new image.
 *
 * @typedef {{
 *   kind: 'health_gate',
 *   service?: string,
 *   reason: string,
 *   observedVersion: string | null,
 * } | {
 *   kind: 'replace',
 *   service: string | null,
 * }} UpdateFailure
 *
 * @typedef {{
 *   ok: boolean,
 *   rolledBack: boolean,
 *   error?: string,
 *   failure?: UpdateFailure,
 * }} UpdateResult
 */

/**
 * @param {{
 *   engine: import('./engine/index.mjs').UpdateEngine,
 *   config: any,
 *   targetVersion: string,
 *   log: (msg: string) => void,
 *   setPhase?: (phase: UpdatePhase) => void,
 *   healthWaiter?: typeof waitForHealthyVersion,
 * }} opts
 * @returns {Promise<UpdateResult>}
 */
export async function runUpdate(opts) {
  const {
    engine,
    config,
    targetVersion,
    log,
    setPhase = () => {},
    healthWaiter = waitForHealthyVersion,
  } = opts;

  // 1 — resolve targets before touching anything.
  setPhase('resolve');
  const targets = [];
  for (const service of config.services) {
    if (PROTECTED_SERVICES.includes(service) || service === config.selfService) {
      throw new Error(`refusing to update protected service "${service}"`);
    }
    const target = await engine.resolveTarget(service);
    target.newImage = `${target.repo}:${targetVersion}`;
    targets.push(target);
    log(`resolved ${service}: ${target.currentImage} → ${target.newImage}`);
  }

  // 2 — every new image must be obtainable before anything is replaced.
  setPhase('preflight');
  await engine.preflight(targets, targetVersion, log);

  // 3 — persist the pin, where the platform allows it.
  setPhase('pin');
  let previousPin = null;
  if (engine.canPersistPin) {
    try {
      previousPin = await engine.pin(targetVersion);
      log(`pinned ${targetVersion} in ${engine.pinDescription()}`);
    } catch (err) {
      throw new Error(
        `could not write ${engine.pinDescription()}: ${err instanceof Error ? err.message : String(err)} — refusing to update, the change would be reverted by the next routine deploy`,
      );
    }
  } else {
    log(
      'this platform cannot persist the version pin — a later routine deploy will use whatever the operator has configured locally',
    );
  }

  // 4 — replace.
  setPhase('replace');
  const replaced = [];
  let replacing = null;
  try {
    for (const target of targets) {
      replacing = target.service;
      // Recorded BEFORE the call, not after. `replace()` can fail *past the
      // point of mutation* — on Fly the machine is already carrying the new
      // image when the wait-for-started step throws — and a bookkeeping entry
      // written only on success makes that invisible: rollback finds nothing
      // to restore and the operator is told "rolled back" while the service
      // is running the new build. Recording pessimistically is safe in the
      // other direction, because restoring an image the service never left is
      // a no-op.
      replaced.push({ service: target.service, previousImage: target.currentImage });
      await engine.replace(target, target.newImage, log);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`replace failed: ${message}`);
    setPhase('rollback');
    await rollback({ engine, replaced, previousPin, log });
    return {
      ok: false,
      rolledBack: true,
      error: message,
      failure: { kind: 'replace', service: replacing },
    };
  }

  // 5 — health gate on the NEW version, for EVERY service that has a health
  // URL. Gating only the middleware was a hole: it applies the migrations and
  // is the noisiest thing to get wrong, but a web-ui that never came up left
  // the middleware happily reporting the new version, the gate satisfied, and
  // the update declared landed with half the stack down. A service with no
  // configured URL is skipped and SAID to be skipped — silence there would be
  // the same lie in a smaller box.
  setPhase('health_gate');
  for (const target of targets) {
    // `healthUrls` is what `loadConfig` produces; the `healthUrl` fallback
    // keeps a config object from before this existed gating the middleware
    // exactly as it always did, rather than silently gating nothing.
    const url =
      config.healthUrls?.[target.service] ??
      (target.service === 'middleware' ? config.healthUrl : undefined);
    if (typeof url !== 'string' || url.length === 0) {
      log(`no health URL configured for ${target.service} — not gated`);
      continue;
    }
    log(`waiting for ${target.service} at ${url} to report ${targetVersion}`);
    const health = await healthWaiter({
      url,
      expectVersion: targetVersion,
      timeoutMs: config.healthTimeoutMs,
      log,
    });
    if (health.ok) {
      log(`health gate passed for ${target.service} (${health.reason})`);
      continue;
    }

    // 6 — revert. The first service that fails ends the run: the stack is
    // already inconsistent, and spending another timeout window on the next
    // one only delays the rollback.
    const reason = `health gate failed for ${target.service}: ${health.reason} (observed version: ${health.observedVersion ?? 'none'})`;
    log(reason);
    setPhase('rollback');
    await rollback({ engine, replaced, previousPin, log });
    return {
      ok: false,
      rolledBack: true,
      error: reason,
      failure: {
        kind: 'health_gate',
        service: target.service,
        reason: health.reason,
        observedVersion: health.observedVersion ?? null,
      },
    };
  }

  setPhase('done');
  return { ok: true, rolledBack: false };
}

/**
 * Best-effort restore of every instance this run replaced, in reverse order.
 * Rollback failures are logged and swallowed: one service that refuses to come
 * back must not stop the others from being restored.
 */
async function rollback({ engine, replaced, previousPin, log }) {
  log('rolling back');
  if (engine.canPersistPin) {
    try {
      await engine.restorePin(previousPin);
      log(`restored the version pin to ${previousPin ?? '(unset)'}`);
    } catch (err) {
      log(
        `could not restore ${engine.pinDescription()}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const entry of [...replaced].reverse()) {
    try {
      // Re-resolve: the previous replace may have produced a new container id,
      // and on Fly the machine's config version has moved on.
      const fresh = await engine.resolveTarget(entry.service);
      await engine.replace(fresh, entry.previousImage, log);
      log(`rolled ${entry.service} back to ${entry.previousImage}`);
    } catch (err) {
      log(
        `rollback of ${entry.service} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
