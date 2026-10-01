/**
 * Which attachment store the kernel publishes as the `tigrisStore` service.
 *
 * 1. S3-compatible storage (Tigris on Fly, MinIO in compose) when all four of
 *    BUCKET_NAME / AWS_ENDPOINT_URL_S3 / AWS_ACCESS_KEY_ID /
 *    AWS_SECRET_ACCESS_KEY are set. Unchanged, and it keeps precedence.
 * 2. Otherwise a local directory when ATTACHMENT_STORE_DIR is set
 *    (`filesystemObjectStore.ts`). The desktop app sets it into the user's data
 *    folder when its "Attachments" switch is on. Single-machine only: nothing
 *    shares the directory between instances.
 * 3. Otherwise no store. Features that persist attachments stay off, as before.
 *
 * The service keeps its `tigrisStore` name because the consumers resolve it by
 * that name; the backend is an implementation detail behind the same three
 * methods.
 *
 * `/health` reports the outcome (`attachmentStoreHealth`), so a caller that
 * asked for a store can see whether it got one. The desktop supervisor checks
 * it after every boot; before this existed the wizard's switch was stored and
 * never read, and nothing could tell.
 */
import { createTigrisStore } from '@omadia/diagrams';
import type { TigrisStore } from '@omadia/diagrams';

import type { Config } from '../config.js';
import { createFilesystemObjectStore } from './filesystemObjectStore.js';

export type AttachmentStoreBackend = 's3' | 'filesystem' | 'none';

/** The config slice the choice depends on. `Pick` makes a missing schema key a compile error. */
export type AttachmentStoreEnv = Pick<
  Config,
  | 'BUCKET_NAME'
  | 'AWS_ENDPOINT_URL_S3'
  | 'AWS_ACCESS_KEY_ID'
  | 'AWS_SECRET_ACCESS_KEY'
  | 'ATTACHMENT_STORE_DIR'
>;

export interface AttachmentStoreSelection {
  readonly backend: AttachmentStoreBackend;
  readonly store: TigrisStore | undefined;
  /** One boot-log line: what was chosen, and why when nothing was. */
  readonly message: string;
}

/** The constructors, injectable so the choice is testable without S3 or a disk. */
export interface AttachmentStoreFactories {
  readonly s3: typeof createTigrisStore;
  readonly filesystem: typeof createFilesystemObjectStore;
}

const DEFAULT_FACTORIES: AttachmentStoreFactories = {
  s3: createTigrisStore,
  filesystem: createFilesystemObjectStore,
};

export function selectAttachmentStore(
  env: AttachmentStoreEnv,
  factories: AttachmentStoreFactories = DEFAULT_FACTORIES,
): AttachmentStoreSelection {
  const dir = env.ATTACHMENT_STORE_DIR?.trim() || undefined;

  if (env.BUCKET_NAME && env.AWS_ENDPOINT_URL_S3 && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    const store = factories.s3({
      endpoint: env.AWS_ENDPOINT_URL_S3,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      bucket: env.BUCKET_NAME,
    });
    const ignored = dir ? '; ATTACHMENT_STORE_DIR ignored, S3 takes precedence' : '';
    return {
      backend: 's3',
      store,
      message: `[middleware] tigris attachment store ready (bucket=${env.BUCKET_NAME})${ignored}`,
    };
  }

  if (dir) {
    try {
      return {
        backend: 'filesystem',
        store: factories.filesystem(dir),
        message: `[middleware] filesystem attachment store ready (dir=${dir})`,
      };
    } catch (err) {
      // Degrade like a missing bucket does, but say why: the desktop asked for
      // this store and will warn when /health reports none.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        backend: 'none',
        store: undefined,
        message: `[middleware] filesystem attachment store DISABLED (ATTACHMENT_STORE_DIR=${dir} is not usable: ${reason})`,
      };
    }
  }

  return {
    backend: 'none',
    store: undefined,
    message:
      '[middleware] attachment store DISABLED (neither BUCKET_NAME / AWS_* nor ATTACHMENT_STORE_DIR set)',
  };
}

/**
 * The `/health` projection. The backend only: `/health` is unauthenticated, so
 * no bucket name, endpoint or path.
 */
export function attachmentStoreHealth(
  selection: Pick<AttachmentStoreSelection, 'backend'>,
): { readonly store: AttachmentStoreBackend } {
  return { store: selection.backend };
}
