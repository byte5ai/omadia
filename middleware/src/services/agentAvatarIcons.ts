/**
 * Avatar → Teams icons (#914).
 *
 * One upload from the operator becomes the two icons a Teams app package
 * needs: a 192×192 colour icon and a 32×32 outline icon. Derivation happens
 * ONCE, at upload time, so provisioning stays a pure read — a resize failing
 * mid-provisioning would fail a chain that has already created an Entra app.
 *
 * THE OUTLINE IS NOT ALWAYS DERIVABLE. Teams renders the outline icon
 * monochrome in the app bar: it wants a white silhouette on transparency. An
 * uploaded photo is fully opaque, so the only silhouette it can produce is a
 * filled square — worse than the packaged default. So the outline is derived
 * from the ALPHA channel and returned as `null` when the upload has no
 * meaningful transparency; the caller keeps the default in that case. This is
 * the one place where "we could not do better than the default" is a normal
 * outcome rather than an error.
 *
 * VALIDATION IS PART OF THE JOB. The bytes arrive from an HTTP body. Anything
 * sharp cannot decode, anything larger than the cap, and anything with absurd
 * dimensions is rejected with a typed error the route turns into a 400 — a
 * malformed upload must never reach the database, let alone a Teams package.
 */

import { createHash } from 'node:crypto';

import sharp from 'sharp';

/** Teams colour icon: exactly 192×192 PNG. */
export const TEAMS_COLOR_ICON_SIZE = 192;
/** Teams outline icon: exactly 32×32 PNG, white on transparent. */
export const TEAMS_OUTLINE_ICON_SIZE = 32;
/** Upload cap. Mirrors the route's body limit; stated here too because this
 *  module is also called from tests and future callers. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
/** Guard against decompression bombs that are small on the wire. */
const MAX_SOURCE_EDGE = 8192;
/**
 * Below this alpha value a pixel counts as transparent. 250 rather than 255
 * because PNG encoders and colour-managed exports routinely leave 252-254 in
 * otherwise opaque areas; treating those as "has transparency" would produce
 * a near-square outline.
 */
const ALPHA_TRANSPARENT_BELOW = 250;

export class AgentAvatarError extends Error {
  public readonly code = 'invalid_avatar';

  constructor(problem: string) {
    super(`invalid_avatar: ${problem}`);
    this.name = 'AgentAvatarError';
  }
}

export interface DerivedAgentAvatar {
  /** The upload, unchanged — kept so a future derivation can re-run. */
  readonly original: Uint8Array;
  readonly color: Uint8Array;
  /** `null` when the source has no transparency to build a silhouette from. */
  readonly outline: Uint8Array | null;
  /** SHA-256 of the ORIGINAL upload. */
  readonly etag: string;
}

/**
 * Decode, validate and derive. Rejects rather than guesses: an undecodable
 * body, an oversized one, or one whose dimensions look like an attack all
 * raise {@link AgentAvatarError}.
 */
export async function deriveAgentAvatar(
  input: Uint8Array,
): Promise<DerivedAgentAvatar> {
  if (input.byteLength === 0) {
    throw new AgentAvatarError('the request body is empty');
  }
  if (input.byteLength > MAX_AVATAR_BYTES) {
    throw new AgentAvatarError(
      `the image is ${input.byteLength} bytes, the limit is ${MAX_AVATAR_BYTES}`,
    );
  }
  const buffer = Buffer.from(input);

  let width: number | undefined;
  let height: number | undefined;
  try {
    const meta = await sharp(buffer).metadata();
    width = meta.width;
    height = meta.height;
  } catch (err) {
    throw new AgentAvatarError(
      `the body is not a decodable image (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!width || !height) {
    throw new AgentAvatarError('the image has no readable dimensions');
  }
  if (width > MAX_SOURCE_EDGE || height > MAX_SOURCE_EDGE) {
    throw new AgentAvatarError(
      `the image is ${width}×${height}; the longest edge accepted is ${MAX_SOURCE_EDGE}px`,
    );
  }

  const color = await sharp(buffer)
    .resize(TEAMS_COLOR_ICON_SIZE, TEAMS_COLOR_ICON_SIZE, {
      fit: 'cover',
      position: 'centre',
    })
    .png()
    .toBuffer();

  const outline = await deriveOutline(buffer);

  return {
    original: input,
    color,
    outline,
    etag: createHash('sha256').update(buffer).digest('hex'),
  };
}

/**
 * White silhouette from the source's alpha channel, or `null` when there is
 * nothing to silhouette. Built by joining a solid-white RGB canvas to the
 * downscaled alpha channel — the alpha IS the shape, which is exactly what
 * the Teams app bar renders.
 */
async function deriveOutline(buffer: Buffer): Promise<Uint8Array | null> {
  const alpha = await sharp(buffer)
    .ensureAlpha()
    .resize(TEAMS_OUTLINE_ICON_SIZE, TEAMS_OUTLINE_ICON_SIZE, {
      fit: 'cover',
      position: 'centre',
      // A transparent pad rather than black, for sources whose aspect ratio
      // makes `cover` sample outside the frame.
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .extractChannel('alpha')
    .raw()
    .toBuffer();

  if (!hasTransparency(alpha)) return null;

  return sharp({
    create: {
      width: TEAMS_OUTLINE_ICON_SIZE,
      height: TEAMS_OUTLINE_ICON_SIZE,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .joinChannel(alpha, {
      raw: {
        width: TEAMS_OUTLINE_ICON_SIZE,
        height: TEAMS_OUTLINE_ICON_SIZE,
        channels: 1,
      },
    })
    .png()
    .toBuffer();
}

/** At least one pixel the app bar would render as see-through. */
function hasTransparency(alpha: Buffer): boolean {
  for (const value of alpha) {
    if (value < ALPHA_TRANSPARENT_BELOW) return true;
  }
  return false;
}
