/**
 * Concrete {@link AttachmentReader} factory (#268 sub-problem 2).
 *
 * Builds the byte source the orchestrator uses for attachment auto-ingest +
 * the `read_attachment` tool, over the shared S3/Tigris bucket. The store is
 * duck-typed to just the `getStream` shape so this package never has to
 * import `@aws-sdk` or depend on `@omadia/diagrams` at type level — the
 * kernel passes whatever `tigrisStore` service it has.
 *
 * `readByStorageKey` drains the store's Readable into a Buffer.
 * `readByUrl` uses global `fetch`. Both return `undefined` (never throw) on
 * a missing store or any I/O failure, so the feature is inert when the
 * bucket env is unconfigured.
 */

import type { Readable } from 'node:stream';

import type { AttachmentReader } from './tools/readAttachmentTool.js';
import { guardAttachmentRead } from './audienceFloorGuard.js';

/** Minimal structural view of the kernel's `tigrisStore` service. */
export interface AttachmentByteStore {
  getStream(key: string): Promise<{
    stream: Readable;
    contentType: string | undefined;
    contentLength: number | undefined;
  }>;
}

async function drainToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Last path segment of a storage key, used as a best-effort fileName. */
function fileNameFromKey(key: string): string | undefined {
  const seg = key.split('/').pop();
  return seg && seg.length > 0 ? seg : undefined;
}

/**
 * #575 — wrap a reader so every handle redemption passes the audience floor.
 *
 * The check rides with the handle rather than sitting at each call site, which
 * is the point spec §5.2 makes: a storage key outlives the turn that minted it,
 * and a resolution site added later would otherwise silently escape the guard.
 * Wrapping the reader covers `read_attachment`, the orchestrator's own
 * `ingestAttachments`, and anything added next, by construction.
 *
 * A refusal returns `undefined` — the reader's existing "unavailable" contract —
 * rather than throwing, so no caller needs new error handling. That does mean a
 * denial is indistinguishable from "unknown key" *to the model*, and that is
 * deliberate rather than sloppy: a message confirming that the key exists but
 * is off-limits would leak the document's existence to a room that may not know
 * it. The real reason goes to the operator log, where it is actionable and not
 * a side channel.
 *
 * Inert when no audience source is installed, like every other guard here.
 */
export function audienceGuardedAttachmentReader(inner: AttachmentReader): AttachmentReader {
  return {
    async readByStorageKey(storageKey) {
      const refusal = await guardAttachmentRead();
      if (refusal !== undefined) {
        console.warn(`[harness-orchestrator] attachment read refused by audience floor: ${refusal}`);
        return undefined;
      }
      return inner.readByStorageKey(storageKey);
    },
    async readByUrl(url) {
      const refusal = await guardAttachmentRead();
      if (refusal !== undefined) {
        console.warn(`[harness-orchestrator] attachment fetch refused by audience floor: ${refusal}`);
        return undefined;
      }
      return inner.readByUrl(url);
    },
  };
}

/**
 * Construct an {@link AttachmentReader}. When `store` is `undefined`
 * (bucket env not set), `readByStorageKey` always resolves to `undefined`
 * and the feature is inert; `readByUrl` still works via `fetch`.
 *
 * Unguarded on its own — `plugin.ts` wraps it in
 * {@link audienceGuardedAttachmentReader} at the single construction site.
 */
export function createAttachmentReader(
  store: AttachmentByteStore | undefined,
): AttachmentReader {
  return {
    async readByStorageKey(storageKey) {
      if (!store) return undefined;
      try {
        const { stream, contentType } = await store.getStream(storageKey);
        const bytes = await drainToBuffer(stream);
        const fileName = fileNameFromKey(storageKey);
        return {
          bytes,
          ...(contentType ? { contentType } : {}),
          ...(fileName ? { fileName } : {}),
        };
      } catch {
        return undefined;
      }
    },
    async readByUrl(url) {
      try {
        const res = await fetch(url);
        if (!res.ok) return undefined;
        const buf = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') ?? undefined;
        return { bytes: buf, ...(contentType ? { contentType } : {}) };
      } catch {
        return undefined;
      }
    },
  };
}
