/**
 * ADR-0187 (#1986) — generated files are recorded with their owner and chat.
 *
 * A plugin that writes generated files to an object store (Office exports,
 * rendered diagrams) records every key a turn produced. The kernel files the
 * key under the turn's person (canonical omadia user id) and chat
 * (`sessionScope`). The same bytes produced in two chats share one
 * content-addressed object, so a key has one record per (person, chat).
 *
 * When a chat is deleted, a person is erased (memory purge, axis "User") or
 * all memory is purged, the kernel drops the matching records. A key left
 * without any record is deleted through the producer's registered deleter.
 * A producer that is not active at that moment keeps its key pending; the
 * kernel retries on the next release.
 *
 * Kernel-provided. Plugins declare `optional_requires: ["generatedObjects@1"]`.
 */

export const GENERATED_OBJECTS_SERVICE_NAME = 'generatedObjects';
export const GENERATED_OBJECTS_CAPABILITY = 'generatedObjects@1';

/** Deletes one object from the producer's store. Throws on a failure. */
export type GeneratedObjectDeleter = (storageKey: string) => Promise<void>;

export interface GeneratedObjectsService {
  /**
   * Record that the CURRENT turn produced `storageKey` in `producer`'s store
   * (the plugin id). Person and chat come from the turn; outside a turn the
   * record has neither and only a full purge releases it. Never throws: a
   * failed record is logged by the kernel (the file then falls back to the
   * bucket's lifecycle rule).
   */
  record(producer: string, storageKey: string): Promise<void>;
  /**
   * Register how `producer`'s objects are deleted. One deleter per producer;
   * the returned function unregisters it (call it from `close()`).
   */
  registerDeleter(producer: string, deleter: GeneratedObjectDeleter): () => void;
}
