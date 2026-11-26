import type { AttachmentReadResult } from '@omadia/channel-sdk';

/**
 * #1993 / ADR-0222 — `CoreApi.readAttachment`: a channel reads the bytes of an
 * outgoing attachment in-process instead of handing the platform a URL it may
 * not reach (the default `PUBLIC_BASE_URL` is `localhost`, so Telegram's
 * servers never fetched generated files and diagrams).
 *
 * The read is a loopback GET to this kernel for the URL's path and query —
 * and only for a path under an operator-granted public prefix
 * (`PublicPathGrantRegistry.resolve`, e.g. `/diagrams/dl`, `/documents/dl`).
 * Those are exactly the paths an anonymous client on the internet could fetch
 * through the public URL; the owning plugin's router still checks the signed,
 * expiring URL. The request carries no cookie or credential, follows no
 * redirect, has a deadline and a size cap. The URL's origin is ignored on
 * purpose: plugins build attachment URLs from their own base-URL setting,
 * which may differ from the kernel's, and only the path addresses anything.
 */

/** Telegram bots may upload up to 50 MB; nothing we render comes close. */
export const ATTACHMENT_READ_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_READ_TIMEOUT_MS = 15_000;

export interface AttachmentByteReaderOptions {
  /** Granted public prefixes; `null` = the path is not session-less public. */
  resolveGrantedPath: (path: string) => unknown;
  /** Loopback origin of this kernel, e.g. `http://127.0.0.1:3979`. */
  loopbackOrigin: string;
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export function createAttachmentByteReader(
  opts: AttachmentByteReaderOptions,
): (url: string) => Promise<AttachmentReadResult> {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? ATTACHMENT_READ_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? ATTACHMENT_READ_TIMEOUT_MS;
  const log = opts.log ?? ((m: string) => console.warn(m));

  return async (url: string): Promise<AttachmentReadResult> => {
    let target: URL;
    try {
      target = new URL(url, opts.loopbackOrigin);
    } catch {
      return { ok: false, reason: 'not_kernel_attachment' };
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return { ok: false, reason: 'not_kernel_attachment' };
    }
    if (!opts.resolveGrantedPath(target.pathname)) {
      return { ok: false, reason: 'not_kernel_attachment' };
    }
    const loopback = new URL(`${target.pathname}${target.search}`, opts.loopbackOrigin);
    let res: Response;
    try {
      res = await doFetch(loopback, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      log(`[attachments] in-process read failed path=${target.pathname}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, reason: 'failed' };
    }
    if (res.status === 404 || res.status === 410 || res.status === 403) {
      return { ok: false, reason: 'not_found' };
    }
    if (res.status !== 200 || !res.body) {
      log(`[attachments] in-process read path=${target.pathname} status=${String(res.status)}`);
      return { ok: false, reason: 'failed' };
    }
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large' };
    }
    const bytes = await readCapped(res.body, maxBytes);
    if (bytes === undefined) return { ok: false, reason: 'too_large' };
    const mediaType = res.headers.get('content-type')?.split(';')[0]?.trim();
    const fileName = fileNameOf(res.headers.get('content-disposition'));
    return {
      ok: true,
      bytes,
      ...(mediaType ? { mediaType } : {}),
      ...(fileName ? { fileName } : {}),
    };
  };
}

async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** `filename*=UTF-8''…` wins over `filename="…"`; a path part is dropped. */
function fileNameOf(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  let name: string | undefined;
  if (star?.[1]) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = undefined;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(disposition);
    name = (plain?.[1] ?? plain?.[2])?.trim();
  }
  if (!name) return undefined;
  const base = name.split(/[\\/]/).pop()?.trim();
  return base && base.length > 0 ? base : undefined;
}

/** The loopback origin for a kernel bound to `host:port`. */
export function loopbackOriginFor(host: string, port: number): string {
  const wildcard = host === '::' || host === '0.0.0.0' || host === '' || host === '::0';
  if (wildcard || host === 'localhost') return `http://127.0.0.1:${String(port)}`;
  return host.includes(':') ? `http://[${host}]:${String(port)}` : `http://${host}:${String(port)}`;
}
