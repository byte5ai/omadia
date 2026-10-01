import { fetch as undiciFetch } from 'undici';
import { DiagramRenderError, type DiagramKind } from './types.js';

/**
 * Thin POST wrapper around a Kroki gateway. Chosen over the GET encoding
 * path because Mermaid sources routinely exceed typical URL length limits
 * and proxies between us and the gateway may truncate.
 */
export interface KrokiClient {
  renderPng(kind: DiagramKind, source: string): Promise<Buffer>;
}

export interface KrokiClientOptions {
  baseUrl: string;
  /** Kill the request after this many milliseconds; surfaces as DiagramRenderError. */
  timeoutMs?: number;
}

export function createKrokiClient(options: KrokiClientOptions): KrokiClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async renderPng(kind: DiagramKind, source: string): Promise<Buffer> {
      const url = `${base}/${kind}/png`;
      let response;
      try {
        response = await undiciFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: source,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // A transport failure (refused, DNS, timeout). The exception's text
        // is not ours to put in a message: it rides as `cause`, for the log.
        throw new DiagramRenderError(`Kroki ${kind}/png request failed`, undefined, undefined, {
          cause: err,
        });
      }

      if (!response.ok) {
        // Body is typically a short HTML/text error from Kroki that quotes
        // the source back — a bounded prefix goes to `body` for the log,
        // never into the message.
        const bodyText = await response.text().catch(() => '');
        const preview = bodyText.slice(0, 500);
        throw new DiagramRenderError(
          `Kroki ${kind}/png responded ${String(response.status)}`,
          response.status,
          preview,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('image/png')) {
        throw new DiagramRenderError(
          `Kroki ${kind}/png answered with a non-PNG content type`,
          response.status,
          `content-type: ${contentType.slice(0, 200)}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },
  };
}
