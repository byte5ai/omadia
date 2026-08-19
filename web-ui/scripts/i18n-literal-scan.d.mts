/**
 * Type contract for the plain-JS scanner, so `i18n-structural.test.ts` can
 * ratchet against it under `tsc --noEmit`. The scanner itself stays JS: it is
 * tooling that must run with a bare `node scripts/…` and no build step.
 */
export type LiteralReason =
  | 'translate'
  | 'review'
  | 'spec-keyword'
  | 'api-enum'
  | 'code'
  | 'placeholder'
  | 'brand'
  | 'symbol';

export interface LiteralHit {
  file: string;
  line: number;
  /** `jsx-text`, `jsx-child-string`, or `prop:<name>`. */
  kind: string;
  text: string;
  reason: LiteralReason;
}

export interface ScanResult {
  hits: LiteralHit[];
  /** Whether the file already imports a next-intl hook. */
  wired: boolean;
}

/** @param rel path relative to `web-ui/app`. */
export function scanFile(rel: string): ScanResult;
