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
 * Construct an {@link AttachmentReader}. When `store` is `undefined`
 * (bucket env not set), `readByStorageKey` always resolves to `undefined`
 * and the feature is inert; `readByUrl` still works via `fetch`.
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
