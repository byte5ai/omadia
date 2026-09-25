/**
 * #1071 — per-session in-process lock, shared by EVERY `ChatSessionStore`
 * instance: each orchestrator builds its own store over the same
 * `/memories/chat-sessions` directory, so an instance-level map would not
 * serialise a registry agent's SessionLogger mirror against the web sender or
 * the PUT route. All read-modify-write paths (proactive append, client
 * merge-save, server turn append, snapshot capture/clear, reset, delete) run
 * under it, so one cannot lose — or resurrect — another's update.
 *
 * Keyed by session id only: unrelated stores (tests) that reuse an id merely
 * serialise. Locked bodies must call only unlocked helpers (`get`/`save`),
 * never another locked method, or the chain deadlocks. Map values are the
 * tail of each chain and never reject. Not a cross-process lock.
 */
const SESSION_LOCKS = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = SESSION_LOCKS.get(id) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => undefined);
  SESSION_LOCKS.set(id, tail);
  try {
    return await run;
  } finally {
    if (SESSION_LOCKS.get(id) === tail) SESSION_LOCKS.delete(id);
  }
}
