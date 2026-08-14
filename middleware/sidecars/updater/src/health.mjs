/**
 * Health gate for the self-update (#432).
 *
 * "The containers restarted" is not the success condition — "the new build is
 * serving" is. This polls the middleware's own `/health`, which reports
 * `version` since slice 1, and only calls the update done when that version is
 * the one that was asked for.
 *
 * When the target image carries no version stamp (a locally built image via
 * docker-compose.build.yaml), the version can never match; the gate then falls
 * back to plain reachability and says so in the step log, rather than failing
 * an update that actually worked.
 */

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, version: string | null }>}
 */
async function probe(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, version: null };
    const body = await res.json();
    const version =
      body && typeof body === 'object' && typeof body.version === 'string'
        ? body.version
        : null;
    return { ok: true, version };
  } catch {
    return { ok: false, version: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll until the target version is serving, or give up.
 *
 * @param {{
 *   url: string,
 *   expectVersion: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   probeTimeoutMs?: number,
 *   log?: (msg: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   probeImpl?: typeof probe,
 * }} opts
 * @returns {Promise<{ ok: boolean, reason: string, observedVersion: string | null }>}
 */
export async function waitForHealthyVersion(opts) {
  const {
    url,
    expectVersion,
    timeoutMs = 5 * 60_000,
    intervalMs = 3_000,
    probeTimeoutMs = 5_000,
    log = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    probeImpl = probe,
  } = opts;

  const deadline = now() + timeoutMs;
  let sawReachable = false;
  let lastVersion = null;

  while (now() < deadline) {
    const result = await probeImpl(url, probeTimeoutMs);
    if (result.ok) {
      sawReachable = true;
      lastVersion = result.version;
      if (result.version === expectVersion) {
        return { ok: true, reason: 'version_match', observedVersion: result.version };
      }
      // An unstamped build cannot be version-matched. Accept reachability, but
      // make the weaker guarantee explicit in the trail.
      if (result.version === null || result.version === 'unknown') {
        log(
          'health reachable but the new image carries no version stamp — accepting on reachability alone',
        );
        return { ok: true, reason: 'reachable_unstamped', observedVersion: result.version };
      }
    }
    await sleep(intervalMs);
  }

  return {
    ok: false,
    reason: sawReachable ? 'version_never_matched' : 'never_reachable',
    observedVersion: lastVersion,
  };
}

export const __probeForTests = probe;
