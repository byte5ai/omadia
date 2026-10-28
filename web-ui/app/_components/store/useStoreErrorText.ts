'use client';

import { useTranslations } from 'next-intl';

import { ApiError } from '../../_lib/api';
import { storeErrorText, type StoreErrorBody } from '../../_lib/packageErrorText';

/**
 * #1477 — the operator-facing text for a failed store call (install, Hub
 * fetch, update, uninstall, package removal), in the UI locale. Wraps
 * {@link storeErrorText} with the three translators it needs; the server's
 * own `message` is only the last resort.
 */
export function useStoreErrorText(): (err: unknown) => string {
  const tUpload = useTranslations('store.upload.errors');
  const tRoot = useTranslations();
  const tInstall = useTranslations('store.install');
  return (err: unknown): string => {
    if (err instanceof ApiError) {
      return storeErrorText(parseStoreErrorBody(err.body), err.message, tUpload, tRoot);
    }
    if (err instanceof Error) return err.message;
    return tInstall('unknownError');
  };
}

/** The envelope fields `storeErrorText` reads, from an untrusted body. */
export function parseStoreErrorBody(body: string): StoreErrorBody | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  const out: { code?: string; message?: string; params?: Record<string, string> } = {};
  if (typeof rec['code'] === 'string') out.code = rec['code'];
  if (typeof rec['message'] === 'string') out.message = rec['message'];
  const params = rec['params'];
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    out.params = Object.fromEntries(
      Object.entries(params as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    );
  }
  return out;
}
