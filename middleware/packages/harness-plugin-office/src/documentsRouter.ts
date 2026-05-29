import { Router } from 'express';
import type { Request, Response } from 'express';
import { isNotFound, type TigrisStore } from '@omadia/diagrams';
import { verifyDocumentSig } from './signing.js';

interface DocumentsRouterDeps {
  store: TigrisStore;
  secret: string;
}

/**
 * HMAC-signed proxy that streams office documents (.xlsx/.docx) from
 * Tigris/MinIO to channels.
 *
 * The URL format is `/documents/<url-encoded-key>?exp=<unix-seconds>&sig=<hex>`
 * where the signature covers `<decoded-key>.<exp>`. Expired or tampered URLs
 * return 403; unknown keys return 404; everything else returns 200 with the
 * raw bytes streamed from object-storage.
 *
 * Mirrors `@omadia/diagrams`' `createDiagramsRouter`, with two differences:
 *   1. `Content-Disposition: attachment` so browsers download rather than
 *      try to render the binary inline.
 *   2. The Content-Type is taken from the stored object (set at `put` time)
 *      rather than defaulting to an image type.
 *
 * NOTE (deferred hardening): like the diagrams route, access is gated by the
 * signed URL alone — there is no per-tenant/session authorization yet. That
 * is acceptable for the MVP but must be tightened before durable documents
 * with real business data are served in production.
 */
export function createDocumentsRouter(deps: DocumentsRouterDeps): Router {
  const router = Router();

  // The `*key` wildcard lets the path contain unescaped slashes
  // (tenant/sha.xlsx), matching the diagrams route convention.
  router.get('/*key', async (req: Request, res: Response) => {
    const rawSegments = req.params['key'];
    const segments = Array.isArray(rawSegments)
      ? rawSegments
      : typeof rawSegments === 'string'
        ? [rawSegments]
        : [];
    if (segments.length === 0) {
      res.status(400).type('text/plain').send('missing key');
      return;
    }
    // Express already URL-decodes each path segment before it lands here.
    const key = segments.join('/');

    const exp = Number(req.query['exp']);
    const sig = typeof req.query['sig'] === 'string' ? req.query['sig'] : '';
    const ok = verifyDocumentSig({ key, exp, sig, secret: deps.secret });
    if (!ok) {
      res.status(403).type('text/plain').send('invalid or expired signature');
      return;
    }

    try {
      const { stream, contentType, contentLength } = await deps.store.getStream(key);
      res.setHeader(
        'content-type',
        contentType ?? 'application/octet-stream',
      );
      if (contentLength !== undefined) {
        res.setHeader('content-length', String(contentLength));
      }
      // Friendly download name = last segment of the key (the sanitized
      // filename written at store time). Safe for the header — the renderer
      // already stripped quotes / control chars / separators.
      const downloadName = key.split('/').pop() ?? 'document';
      res.setHeader(
        'content-disposition',
        `attachment; filename="${downloadName}"`,
      );
      // Signed URL already encodes expiry — cache aggressively so a channel
      // re-fetch doesn't round-trip to Tigris on every card re-render.
      res.setHeader('cache-control', 'private, max-age=900, immutable');
      stream.on('error', (err) => {
        console.error('[documents] stream error:', err);
        if (!res.headersSent) {
          res.status(500).type('text/plain').send('internal error');
        } else {
          res.destroy(err);
        }
      });
      stream.pipe(res);
    } catch (err) {
      if (isNotFound(err)) {
        res.status(404).type('text/plain').send('not found');
        return;
      }
      console.error('[documents] proxy failed:', err);
      res.status(500).type('text/plain').send('internal error');
    }
  });

  return router;
}
