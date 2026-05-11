import { Router } from 'express';
import type { Request, Response } from 'express';
import { isNotFound, type TigrisStore } from './tigrisStore.js';
import { verifySig } from './signing.js';

interface DiagramsRouterDeps {
  store: TigrisStore;
  secret: string;
}

/**
 * HMAC-signed proxy that serves diagram PNGs from Tigris/MinIO to Teams.
 *
 * The URL format is `/diagrams/<url-encoded-key>?exp=<unix-seconds>&sig=<hex>`
 * where the signature covers `<decoded-key>.<exp>`. Expired or tampered
 * URLs return 403; unknown keys return 404; everything else returns 200 with
 * the raw PNG body streamed from object-storage.
 *
 * Teams explicitly does NOT follow redirects on card images, so we stream
 * the bytes ourselves rather than handing the client a presigned S3 URL.
 * That also keeps the tenant audit trail inside the middleware's logs.
 */
export function createDiagramsRouter(deps: DiagramsRouterDeps): Router {
  const router = Router();

  // The `*key` wildcard lets the path contain unescaped slashes (tenant/sha.png),
  // matching the same pattern used by /api/admin/memory/*path.
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
    const ok = verifySig({ key, exp, sig, secret: deps.secret });
    if (!ok) {
      res.status(403).type('text/plain').send('invalid or expired signature');
      return;
    }

    try {
      const { stream, contentType, contentLength } = await deps.store.getStream(key);
      // PNG from Kroki; enforce even if upstream metadata says otherwise.
      res.setHeader('content-type', contentType ?? 'image/png');
      if (contentLength !== undefined) {
        res.setHeader('content-length', String(contentLength));
      }
      // Signed URL already encodes expiry — cache aggressively so Teams can
      // re-fetch without round-tripping to Tigris on card re-renders.
      res.setHeader('cache-control', 'private, max-age=900, immutable');
      // Teams does not follow redirects. Guarantee we never emit one.
      stream.on('error', (err) => {
        console.error('[diagrams] stream error:', err);
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
      console.error('[diagrams] proxy failed:', err);
      res.status(500).type('text/plain').send('internal error');
    }
  });

  return router;
}
