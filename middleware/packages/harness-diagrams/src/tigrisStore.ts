import type { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

/**
 * Thin S3 wrapper used for both Tigris (production on Fly) and MinIO (local
 * docker-compose). Uses the `@aws-sdk/client-s3` v3 client because Tigris
 * auto-provisions the AWS-style env vars (`AWS_ACCESS_KEY_ID` etc.).
 *
 * Only three operations are surfaced: exists/put/stream. The proxy route
 * streams bytes from `getStream`; the service calls `exists` to short-circuit
 * re-renders and `put` to upload a fresh PNG.
 */
export interface TigrisStore {
  exists(key: string): Promise<boolean>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  getStream(key: string): Promise<{ stream: Readable; contentType: string | undefined; contentLength: number | undefined }>;
}

export interface TigrisStoreOptions {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createTigrisStore(options: TigrisStoreOptions): TigrisStore {
  const clientConfig: S3ClientConfig = {
    region: 'auto',
    endpoint: options.endpoint,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    // MinIO speaks path-style by default; Tigris supports both but is happiest
    // with path-style when endpoint is a non-virtual host. One flag works for
    // both backends.
    forcePathStyle: true,
  };
  const client = new S3Client(clientConfig);

  return {
    async exists(key: string): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },

    async put(key: string, body: Buffer, contentType = 'image/png'): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // Cache for 24h; the signed URL's TTL is the real access gate.
          CacheControl: 'private, max-age=86400, immutable',
        }),
      );
    },

    async getStream(key) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: options.bucket, Key: key }),
      );
      const body = response.Body;
      if (!body) {
        throw new Error(`Empty response body for key ${key}`);
      }
      // Node SDK v3 returns `Readable` in the Node runtime; assert+cast so we
      // can pipe it directly to the Express response. In the browser runtime
      // this would be a WebStream; we never run there.
      return {
        stream: body as Readable,
        contentType: response.ContentType ?? undefined,
        contentLength: response.ContentLength ?? undefined,
      };
    },
  };
}

interface AwsErrorLike {
  $metadata?: { httpStatusCode?: number };
  name?: string;
  Code?: string;
}

/** Distinguish "object not here" from real infrastructure errors. */
export function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as AwsErrorLike;
  if (e.$metadata?.httpStatusCode === 404) return true;
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
  if (e.Code === 'NoSuchKey' || e.Code === 'NotFound') return true;
  return false;
}
