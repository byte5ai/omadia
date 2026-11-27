/**
 * ADR-0266 (#1964) — renew an expired signed download link without
 * re-generating the file.
 *
 * Office and Diagrams hand out HMAC-signed links
 * (`<route prefix>/<key>?exp=<unix-seconds>&sig=<hex>`, ADR-0137/ADR-0176)
 * that expire after the plugin's TTL. The web chat asks the kernel route
 * `POST /api/v1/files/renew` for a fresh link when an older message shows an
 * expired one. The kernel owns the caller rule (signed-in session, maximum age
 * of the original link); the producer that signed the link owns its secret and
 * registers a renewer for its route prefix here.
 *
 * Kernel-provided. Plugins declare `optional_requires: ["fileLinkRenewal@1"]`.
 */

export const FILE_LINK_RENEWAL_SERVICE_NAME = 'fileLinkRenewal';
export const FILE_LINK_RENEWAL_CAPABILITY = 'fileLinkRenewal@1';

/** The parts of a signed link, as the kernel parsed them from its URL. */
export interface SignedFileLink {
  /** The storage key, URL-decoded (the path after the route prefix). */
  readonly key: string;
  /** The link's expiry in unix seconds (the `exp` query value). */
  readonly exp: number;
  /** The link's signature (the `sig` query value). */
  readonly sig: string;
}

/** A freshly signed link. */
export interface RenewedFileLink {
  /** Absolute URL, signed with the producer's normal TTL. */
  readonly url: string;
  /** Expiry of `url` in unix seconds. */
  readonly expiresAt: number;
}

export interface FileLinkRenewer {
  /**
   * `true` only when `sig` is this producer's signature over `key` and `exp`
   * and `key` has this producer's key layout. The expiry is NOT checked:
   * the kernel applies its own maximum age.
   */
  verifyIgnoringExpiry(link: SignedFileLink): boolean;
  /** Sign `key` again with the producer's normal TTL. */
  sign(key: string): RenewedFileLink;
}

export interface FileLinkRenewalService {
  /**
   * Register the renewer for links under `routePrefix` (e.g. `/diagrams/dl`,
   * no trailing slash). One renewer per prefix; a second registration for the
   * same prefix throws. The returned function unregisters it (call it from
   * `close()`).
   */
  registerRenewer(routePrefix: string, renewer: FileLinkRenewer): () => void;
}
