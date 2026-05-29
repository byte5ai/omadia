import { createHash } from 'node:crypto';
import type { TigrisStore } from '@omadia/diagrams';
import { renderXlsx } from './xlsxRenderer.js';
import { renderDocx } from './docxRenderer.js';
import { signDocumentUrl } from './signing.js';
import type {
  DocxDescriptor,
  OfficeArtifact,
  RenderResult,
  XlsxDescriptor,
} from './types.js';

export interface OfficeServiceOptions {
  readonly store: TigrisStore;
  readonly secret: string;
  readonly publicBaseUrl: string;
  readonly tenantId: string;
  readonly signedUrlTtlSec: number;
  readonly log?: (msg: string) => void;
}

/**
 * Renders a descriptor to bytes, persists them to Tigris under a
 * content-addressed key, and returns a signed `/documents` URL.
 *
 * Mirrors `@omadia/diagrams`' DiagramService: bytes live in object storage,
 * never in the LLM context; the tool returns only the compact URL + metadata.
 * The storage key is `documents/<tenant>/<sha256>/<filename>` — the sha dir
 * gives content-addressing (idempotent re-renders hit the cache), the trailing
 * filename segment is what the `/documents` route uses as the download name.
 */
export class OfficeService {
  constructor(private readonly opts: OfficeServiceOptions) {}

  async createXlsx(descriptor: XlsxDescriptor): Promise<OfficeArtifact> {
    return this.persist(await renderXlsx(descriptor));
  }

  async createDocx(descriptor: DocxDescriptor): Promise<OfficeArtifact> {
    return this.persist(await renderDocx(descriptor));
  }

  private async persist(result: RenderResult): Promise<OfficeArtifact> {
    const sha = createHash('sha256').update(result.buffer).digest('hex');
    const key = `documents/${this.opts.tenantId}/${sha}/${result.filename}`;

    const cacheHit = await this.opts.store.exists(key);
    if (!cacheHit) {
      await this.opts.store.put(key, result.buffer, result.mediaType);
    }

    const url = signDocumentUrl({
      key,
      secret: this.opts.secret,
      ttlSec: this.opts.signedUrlTtlSec,
      publicBaseUrl: this.opts.publicBaseUrl,
    });

    this.opts.log?.(
      `[office] ${result.ext} ${cacheHit ? 'cache-hit' : 'stored'} key=…${sha.slice(-12)}/${result.filename} bytes=${String(result.buffer.length)} rows=${String(result.rowsWritten)}`,
    );

    return {
      url,
      filename: result.filename,
      mediaType: result.mediaType,
      sizeBytes: result.buffer.length,
      rowsWritten: result.rowsWritten,
      cacheHit,
    };
  }
}
