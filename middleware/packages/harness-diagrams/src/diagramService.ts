import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { buildCacheKey } from './cacheKey.js';
import type { KrokiClient } from './krokiClient.js';
import { signUrl } from './signing.js';
import type { TigrisStore } from './tigrisStore.js';
import {
  ALLOWED_DIAGRAM_KINDS,
  DiagramRenderTooLargeError,
  DiagramSourceTooLargeError,
  UnsupportedDiagramKindError,
  type DiagramKind,
  type RenderInput,
  type RenderOutput,
} from './types.js';

/**
 * Key prefix allowlist for brand-asset substitution. Keeps the
 * `render_diagram` tool from being usable as an arbitrary-blob-fetcher
 * via the Tigris bucket.
 */
const BRAND_ASSET_PREFIXES: readonly string[] = ['teams-attachments/'];

/** Synthetic URL that Claude writes into the diagram spec as a placeholder
 * for the brand logo. The service swaps this for a base64 data URL before
 * the spec reaches Kroki (which has no public-egress and cannot follow
 * `/attachments/…` signed URLs reliably). */
const BRAND_LOGO_PLACEHOLDER = 'brand://logo';

/**
 * Thin orchestration layer between Kroki (rendering) and Tigris (storage).
 *
 * Contract:
 *   render(input) → verified, cached PNG in object-storage + a signed,
 *   short-lived URL the Teams Adaptive Card can embed directly.
 *
 * Invariants:
 *   - `kind` is always one of ALLOWED_DIAGRAM_KINDS (enforced at the boundary).
 *   - Source size is capped (default 64 KB) so a runaway LLM can't DoS Kroki.
 *   - Rendered PNG is capped (default 900 KB) so Teams always accepts the card.
 *   - Content-addressed cache key means re-renders are free after the first hit.
 */
export interface DiagramServiceOptions {
  kroki: KrokiClient;
  store: TigrisStore;
  tenantId: string;
  secret: string;
  publicBaseUrl: string;
  signedUrlTtlSec: number;
  maxSourceBytes: number;
  maxPngBytes: number;
  log?: (message: string) => void;
}

export class DiagramService {
  constructor(private readonly options: DiagramServiceOptions) {}

  async render(input: RenderInput): Promise<RenderOutput> {
    this.assertKindAllowed(input.kind);

    // Brand-asset substitution: when the spec contains the `brand://logo`
    // placeholder AND a validated storage-key was supplied, we inline the
    // logo bytes as a base64 data URL. This happens BEFORE the source-size
    // cap is checked, so the inlined spec is what's measured — Kroki
    // receives a self-contained payload and never needs public egress.
    const processedSource = await this.applyBrandSubstitutions(input);

    const sourceBytes = Buffer.byteLength(processedSource, 'utf8');
    if (sourceBytes > this.options.maxSourceBytes) {
      throw new DiagramSourceTooLargeError(sourceBytes, this.options.maxSourceBytes);
    }

    const key = buildCacheKey({
      kind: input.kind,
      source: processedSource,
      tenantId: this.options.tenantId,
    });

    const cacheHit = await this.options.store.exists(key);
    if (!cacheHit) {
      const png = await this.options.kroki.renderPng(input.kind, processedSource);
      if (png.byteLength > this.options.maxPngBytes) {
        throw new DiagramRenderTooLargeError(png.byteLength, this.options.maxPngBytes);
      }
      await this.options.store.put(key, png, 'image/png');
      this.options.log?.(
        `[diagrams] rendered kind=${input.kind} bytes=${String(png.byteLength)} key=${summarise(key)}`,
      );
    } else {
      this.options.log?.(`[diagrams] cache-hit kind=${input.kind} key=${summarise(key)}`);
    }

    const url = signUrl({
      key,
      secret: this.options.secret,
      ttlSec: this.options.signedUrlTtlSec,
      publicBaseUrl: this.options.publicBaseUrl,
    });

    return {
      kind: input.kind,
      url,
      key,
      cacheHit,
      ...(input.title ? { title: input.title } : {}),
    };
  }

  private assertKindAllowed(kind: string): asserts kind is DiagramKind {
    if (!(ALLOWED_DIAGRAM_KINDS as readonly string[]).includes(kind)) {
      throw new UnsupportedDiagramKindError(kind);
    }
  }

  /**
   * Replace `brand://logo` placeholders with a base64 data URL constructed
   * from the supplied `brandLogoStorageKey`. Returns the original source
   * unchanged when either (a) no placeholder is present or (b) no key is
   * provided. Unknown / disallowed keys are rejected with a thrown error —
   * the tool handler converts that into a user-visible "Error:" reply.
   */
  private async applyBrandSubstitutions(input: RenderInput): Promise<string> {
    if (!input.source.includes(BRAND_LOGO_PLACEHOLDER)) return input.source;
    const storageKey = input.brandLogoStorageKey;
    if (!storageKey || storageKey.trim().length === 0) {
      // Placeholder present but no key supplied — leave the spec as-is and
      // let Kroki render the image layer as a broken reference. A hard
      // error here would regress the "partial rendering" UX the user
      // expects when they forget to pass the key.
      this.options.log?.(
        `[diagrams] brand-logo placeholder present but no storage key supplied — leaving spec unchanged`,
      );
      return input.source;
    }
    if (!BRAND_ASSET_PREFIXES.some((p) => storageKey.startsWith(p))) {
      throw new Error(
        `Brand-asset key rejected (disallowed prefix): ${storageKey.slice(0, 60)}`,
      );
    }

    const { stream, contentType } = await this.options.store.getStream(storageKey);
    const rawBytes = await collectStream(stream);
    const rawMime = contentType ?? 'application/octet-stream';
    const normalized = await this.normalizeBrandAsset(rawBytes, rawMime);
    const dataUrl = `data:${normalized.mime};base64,${normalized.bytes.toString('base64')}`;
    const substituted = input.source.split(BRAND_LOGO_PLACEHOLDER).join(dataUrl);
    this.options.log?.(
      `[diagrams] brand-logo inlined rawBytes=${String(rawBytes.byteLength)} rawMime=${rawMime} ` +
        `normalizedBytes=${String(normalized.bytes.byteLength)} normalizedMime=${normalized.mime} ` +
        `key=${summariseStorageKey(storageKey)}`,
    );
    return substituted;
  }

  /**
   * Shrink raster brand assets (PNG/JPEG/WEBP) to a sane in-chart size before
   * base64-inlining. Chart logos never need more than ~240px on the longest
   * edge — passing a 2000px marketing PNG through the spec inflates the
   * payload past Kroki's Vega-Lite handler limits and bloats cached PNGs.
   * SVG and unknown types are returned untouched (SVG is already text-tiny;
   * unknown MIMEs are routed through unmodified to preserve existing behavior).
   *
   * Failure mode: if sharp cannot decode the asset, we log and fall back to
   * the raw bytes. A broken image layer in the rendered chart is a softer
   * failure than refusing to render the whole diagram.
   */
  private async normalizeBrandAsset(
    bytes: Buffer,
    mime: string,
  ): Promise<{ bytes: Buffer; mime: string }> {
    const raster = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!raster.includes(mime.toLowerCase())) {
      return { bytes, mime };
    }
    try {
      const normalized = await sharp(bytes)
        .resize({ width: 240, height: 240, fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9, palette: true })
        .toBuffer();
      return { bytes: normalized, mime: 'image/png' };
    } catch (err) {
      this.options.log?.(
        `[diagrams] brand-logo normalize FAILED, falling back to raw bytes: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { bytes, mime };
    }
  }
}

/** Drain a Node `Readable` into a Buffer. Narrow helper for the brand-asset
 *  substitution — Tigris returns a Readable from `getStream()`. */
async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function summariseStorageKey(key: string): string {
  const lastSlash = key.lastIndexOf('/');
  if (lastSlash < 0) return key.slice(0, 40);
  return `…${key.slice(lastSlash)}`;
}

/** Keep logs brief but useful — show tenant + first 8 hash chars, no raw source. */
function summarise(key: string): string {
  const slash = key.indexOf('/');
  if (slash < 0) return key;
  return `${key.slice(0, slash)}/${key.slice(slash + 1, slash + 9)}…`;
}
