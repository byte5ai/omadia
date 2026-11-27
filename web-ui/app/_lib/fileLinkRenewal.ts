'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, renewFileLink } from './api';

/**
 * #1964 (ADR-0266) — keep Office/Diagram links of older chat messages alive.
 *
 * The links carry their expiry (`exp`, unix seconds). When a message renders
 * with an expired link, or its image fails to load, the hook asks the kernel
 * (`POST /api/v1/files/renew`) for a freshly signed link to the same file and
 * swaps it in. A refusal ends in a readable state; it is never retried.
 */

/** Renew a little before the real expiry so a click does not race it. */
const EXPIRY_SKEW_SEC = 30;

/** The link's `exp`, or `undefined` when the URL carries none. */
export function signedLinkExpiry(url: string): number | undefined {
  try {
    const raw = new URL(url, 'http://link.invalid').searchParams.get('exp');
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    return Number(raw);
  } catch {
    return undefined;
  }
}

/** True when the link has an `exp` that lies (almost) in the past. */
export function isSignedLinkExpired(url: string, nowMs: number = Date.now()): boolean {
  const exp = signedLinkExpiry(url);
  return exp !== undefined && exp - EXPIRY_SKEW_SEC <= Math.floor(nowMs / 1000);
}

export type FileLinkFailure = 'tooOld' | 'unavailable' | 'failed';

/** Map a renew error to the message the chat shows. */
export function fileLinkFailure(err: unknown): FileLinkFailure {
  if (err instanceof ApiError) {
    if (err.code === 'file_link.too_old') return 'tooOld';
    if (err.code === 'file_link.unknown_route') return 'unavailable';
  }
  return 'failed';
}

export interface RenewableFileLink {
  /** The link to render: the original one or its renewal. */
  url: string;
  renewing: boolean;
  failure: FileLinkFailure | null;
  /**
   * Renew now (once). Resolves to the fresh URL, or `null` when the link
   * could not be renewed. Repeated calls share the first attempt.
   */
  renew: () => Promise<string | null>;
}

export function useRenewableFileLink(originalUrl: string): RenewableFileLink {
  const [url, setUrl] = useState(originalUrl);
  const [renewing, setRenewing] = useState(false);
  const [failure, setFailure] = useState<FileLinkFailure | null>(null);
  const attempt = useRef<Promise<string | null> | null>(null);

  const renew = useCallback((): Promise<string | null> => {
    if (attempt.current) return attempt.current;
    setRenewing(true);
    attempt.current = renewFileLink(originalUrl)
      .then((renewed) => {
        setUrl(renewed.url);
        return renewed.url;
      })
      .catch((err: unknown) => {
        setFailure(fileLinkFailure(err));
        return null;
      })
      .finally(() => setRenewing(false));
    return attempt.current;
  }, [originalUrl]);

  useEffect(() => {
    if (isSignedLinkExpired(originalUrl)) void renew();
  }, [originalUrl, renew]);

  return { url, renewing, failure, renew };
}
