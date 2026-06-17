/**
 * omadia-canvas-protocol/1.1 — Lumen sharing (lumens-spec.md §9).
 *
 * A Lumen serialises cleanly (validated data + capability manifest). The hard
 * rule: assets travel by content `id`, NOT by token. A shared/preset Lumen
 * carries content-addressed DataRef ids only — NEVER the author's signedTokens
 * (HMAC-scoped to the author's tenant‖user‖canvasSession, §6.1), which would
 * either fail for the recipient or break isolation. On import the recipient's
 * Tier-2 re-authorises and re-mints each token scoped to the recipient; an asset
 * the recipient may not access renders INERT, never via a borrowed token.
 *
 * Pure: the real HMAC mint + authorisation are injected (the host owns the
 * secret), so this policy is deterministic and unit-testable.
 */
import { consentForManifest, manifestIsImportable, type CapabilityRequest, type ConsentReport } from './consent.js';

interface DataRefLike {
  id: string;
  signedToken?: string;
  expiresAt?: string;
  [k: string]: unknown;
}

// A DataRef is content-addressed `<kind>-<16hex>` (data-ref.schema.json). We
// detect by that id shape — NOT by the presence of `signedToken`, because a
// shared ref has had its token stripped. `preset-` ids are provenance, not
// assets, so they are excluded.
const DATA_REF_ID = /^(?!preset-)[a-z]+-[0-9a-f]{16}$/;
const isDataRefLike = (v: unknown): v is DataRefLike =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  typeof (v as { id?: unknown }).id === 'string' &&
  DATA_REF_ID.test((v as { id: string }).id);

/** Deep-map a tree, applying `fn` to every DataRef-like object (one with an
 *  `id` and a `signedToken` slot). Returns a fresh structure (no mutation). */
function mapDataRefs<T>(node: T, fn: (ref: DataRefLike) => DataRefLike): T {
  if (Array.isArray(node)) return node.map((n) => mapDataRefs(n, fn)) as unknown as T;
  if (node && typeof node === 'object') {
    if (isDataRefLike(node)) return fn({ ...(node as DataRefLike) }) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = mapDataRefs(v, fn);
    return out as unknown as T;
  }
  return node;
}

/** Prepare a Lumen for sharing: strip every author signedToken/expiresAt,
 *  keeping only the content-addressed id. Returns the shareable spec + the set
 *  of asset ids it references. */
export function stripTokensForShare<T extends object>(lumen: T): { shared: T; assetIds: string[] } {
  const ids = new Set<string>();
  const shared = mapDataRefs(lumen, (ref) => {
    ids.add(ref.id);
    const { signedToken: _t, expiresAt: _e, ...rest } = ref;
    void _t;
    void _e;
    return rest as DataRefLike;
  });
  return { shared, assetIds: [...ids] };
}

export type AuthorizeAsset = (id: string, recipient: string) => boolean;
export type MintToken = (id: string, recipient: string) => { signedToken: string; expiresAt: string };

export interface ImportResult<T> {
  /** the Lumen with recipient-scoped tokens; un-authorised assets marked inert. */
  lumen: T;
  /** the capability consent report the recipient must satisfy before first run. */
  consent: ConsentReport;
  /** importable iff no unknown capability (whitelist) — else do not run. */
  importable: boolean;
  /** asset ids re-minted for the recipient. */
  reminted: string[];
  /** asset ids the recipient may not access → rendered inert. */
  inert: string[];
}

/** Import a shared Lumen for a recipient: re-validate capabilities, then
 *  re-mint a recipient-scoped token for each authorised asset and mark the rest
 *  inert (an inert ref carries no token and an `inert:true` flag the renderer
 *  honours). */
export function importShared<T extends object>(
  shared: T,
  recipient: string,
  opts: { manifest?: CapabilityRequest[]; authorize: AuthorizeAsset; mint: MintToken },
): ImportResult<T> {
  const manifest = opts.manifest ?? [];
  const consent = consentForManifest(manifest);
  const reminted: string[] = [];
  const inert: string[] = [];

  const lumen = mapDataRefs(shared, (ref) => {
    // never trust an inbound token — always re-derive from scratch.
    const { signedToken: _t, expiresAt: _e, inert: _i, ...base } = ref as DataRefLike & { inert?: boolean };
    void _t;
    void _e;
    void _i;
    if (opts.authorize(ref.id, recipient)) {
      const minted = opts.mint(ref.id, recipient);
      reminted.push(ref.id);
      return { ...base, signedToken: minted.signedToken, expiresAt: minted.expiresAt };
    }
    inert.push(ref.id);
    return { ...base, inert: true };
  });

  return { lumen, consent, importable: manifestIsImportable(manifest), reminted, inert };
}

/** §9: canvasOwnership extends to a group of members for shared canvases. */
export function canvasOwnershipGroup(members: string[]): { kind: 'group'; members: string[] } {
  return { kind: 'group', members: [...new Set(members)] };
}
