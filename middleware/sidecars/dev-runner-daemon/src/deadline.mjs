/**
 * Epic #470 W1 — one deadline, used by every loop that can hang.
 *
 * Three copies of this function grew independently (proxy DNS, reaper pass, image
 * pull), each rediscovering the same rule the hard way, so it lives in one place:
 *
 *   THE TIMER MUST NOT BE `unref`'d. An unref'd timer never fires when node is
 *   otherwise idle, so the awaited race never settles and the caller hangs —
 *   exactly the failure the deadline exists to prevent. It is always cleared in
 *   `finally`, so it cannot keep the process alive either.
 *
 * The hung work is abandoned, not cancelled: pass `onTimeout` when the caller
 * holds something abortable (a socket, an AbortController).
 */

/**
 * Reject if `p` has not settled within `ms`.
 *
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {string} label Named in the rejection: `<label> exceeded <ms>ms`.
 * @param {() => void} [onTimeout] Called once, on timeout only, before the reject.
 * @returns {Promise<T>}
 */
export function withDeadline(p, ms, label, onTimeout) {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) {
        try {
          onTimeout();
        } catch {
          // An abort that throws must not replace the timeout with its own error.
        }
      }
      reject(new Error(`${label} exceeded ${ms}ms`));
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
