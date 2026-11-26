/**
 * Filesystem-backed object store: what the kernel publishes as `tigrisStore`
 * on a single-machine install that has no S3 bucket. The desktop app's
 * "Attachments" switch points `ATTACHMENT_STORE_DIR` at the user's data
 * folder; `attachmentStore.ts` decides when this store is used.
 *
 * It implements the S3 store's contract from `@omadia/diagrams`
 * (`exists` / `put` / `getStream`), so every consumer of the `tigrisStore`
 * service (the orchestrator's attachment reader, the Teams attachment store)
 * works against it unchanged. That includes the edges: the same default
 * content type on `put`, and a miss that `isNotFound()` recognises.
 *
 * Keys never become paths. A key is caller data: `read_attachment` passes a
 * storage key the model chose, and an S3 bucket answers a hostile key with a
 * harmless 404. A directory joined with that key would read or overwrite
 * anything the process can reach. So an object lives under the SHA-256 of its
 * key (`<root>/<2 hex>/<64 hex>`), which confines every key to this directory
 * by construction: there is no sanitiser that could miss a spelling. The
 * metadata file next to it keeps the key and the content type.
 *
 * Writes go to a temp file in the same directory and are renamed into place,
 * so a reader never sees half an object. The directory is created owner-only
 * and objects are written owner-only: attachments are user files.
 *
 * Not provided: expiry. An S3 bucket gets a 90-day lifecycle rule
 * (`scripts/setup-tigris-lifecycle.ts`); objects here stay until someone
 * deletes them.
 */
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TigrisStore } from '@omadia/diagrams';

/** S3's own key limit. A longer key is not one any caller mints. */
const MAX_KEY_BYTES = 1024;

/** The S3 store's default, so a caller that omits the type gets the same answer on both backends. */
const DEFAULT_CONTENT_TYPE = 'image/png';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface ObjectLocation {
  readonly dir: string;
  readonly data: string;
  readonly meta: string;
}

interface ObjectMeta {
  readonly key: string;
  readonly contentType: string;
}

/**
 * Open (and create, owner-only) the store at `rootDir`.
 *
 * Throws when the directory cannot be created or written, on purpose: the
 * kernel then reports no attachment store on `/health` instead of one that
 * fails on the first upload.
 */
export function createFilesystemObjectStore(rootDir: string): TigrisStore {
  const root = path.resolve(rootDir);
  mkdirSync(root, { recursive: true, mode: DIR_MODE });
  accessSync(root, fsConstants.R_OK | fsConstants.W_OK);

  /** Where `key` lives, or null for a key no caller can have stored. */
  const locate = (key: string): ObjectLocation | null => {
    if (typeof key !== 'string' || key.length === 0) return null;
    if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) return null;
    const digest = createHash('sha256').update(key, 'utf8').digest('hex');
    const dir = path.join(root, digest.slice(0, 2));
    const data = path.join(dir, digest);
    return { dir, data, meta: `${data}.json` };
  };

  return {
    async exists(key: string): Promise<boolean> {
      const at = locate(key);
      if (at === null) return false;
      try {
        return (await stat(at.data)).isFile();
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },

    async put(key: string, body: Buffer, contentType = DEFAULT_CONTENT_TYPE): Promise<void> {
      const at = locate(key);
      if (at === null) {
        throw new TypeError(`object key must be a non-empty string of at most ${MAX_KEY_BYTES} bytes`);
      }
      await mkdir(at.dir, { recursive: true, mode: DIR_MODE });
      // Metadata first: once the bytes are visible, their type is too.
      const meta: ObjectMeta = { key, contentType };
      await writeAtomically(at.meta, JSON.stringify(meta));
      await writeAtomically(at.data, body);
    },

    async getStream(key: string) {
      const at = locate(key);
      if (at === null) throw notFound();
      const handle = await open(at.data, 'r').catch((err: unknown) => {
        throw isMissing(err) ? notFound() : err;
      });
      try {
        // Size from the open handle, not the path: a concurrent put renames a
        // new file into place, and the length must describe the bytes streamed.
        const { size } = await handle.stat();
        const contentType = await readContentType(at.meta);
        return { stream: handle.createReadStream(), contentType, contentLength: size };
      } catch (err) {
        await handle.close();
        throw err;
      }
    },
  };
}

async function writeAtomically(target: string, data: string | Buffer): Promise<void> {
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data, { mode: FILE_MODE, flag: 'wx' });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** The stored content type, or undefined when the metadata is missing or unreadable. */
async function readContentType(metaPath: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const contentType = (parsed as { contentType?: unknown }).contentType;
    return typeof contentType === 'string' ? contentType : undefined;
  } catch {
    return undefined;
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Shaped so `isNotFound()` from `@omadia/diagrams` recognises it, like an S3 404. */
function notFound(): Error {
  const err = new Error('object not found');
  err.name = 'NotFound';
  return err;
}
