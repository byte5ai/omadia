import { createHash } from 'node:crypto';

import { z } from 'zod';

/**
 * Profile-Bundle v1 manifest schema (Zod source-of-truth).
 *
 * Spec: docs/harness-platform/specs/profile-bundle-v1.md
 *
 * Used by:
 *   - profileBundleZipper (Erzeuger)
 *   - profileBundleImporter (Verbraucher)
 *   - upcoming snapshot/export endpoints (Phase 2.2 / 2.4)
 */

const HEX_64 = /^[a-f0-9]{64}$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const STRICT_SEMVER = /^\d+\.\d+\.\d+$/;

export const ProfileBundleSpecVersion = z.literal(1);

export const ProfileBundlePluginPinSchema = z.object({
  id: z.string().min(1),
  version: z.string().regex(STRICT_SEMVER, 'plugin version must be strict semver (a.b.c)'),
  sha256: z.string().regex(HEX_64, 'sha256 must be 64 hex chars'),
  vendored: z.boolean(),
});
export type ProfileBundlePluginPin = z.infer<typeof ProfileBundlePluginPinSchema>;

export const ProfileBundleKnowledgeEntrySchema = z.object({
  file: z.string().regex(/^knowledge\//, 'knowledge entries must live under knowledge/'),
  sha256: z.string().regex(HEX_64),
});
export type ProfileBundleKnowledgeEntry = z.infer<typeof ProfileBundleKnowledgeEntrySchema>;

export const ProfileBundleManifestSchema = z.object({
  harness: z.object({
    bundleSpec: ProfileBundleSpecVersion,
  }),
  profile: z.object({
    id: z.string().regex(PROFILE_ID, 'profile id must be lowercase kebab-case (1-63 chars)'),
    name: z.string().min(1).max(100),
    version: z.string().regex(STRICT_SEMVER),
    created_at: z.string().datetime(),
    created_by: z.string().email(),
  }),
  agent: z.object({
    file: z.literal('agent.md'),
    sha256: z.string().regex(HEX_64),
  }),
  plugins: z.array(ProfileBundlePluginPinSchema),
  knowledge: z.array(ProfileBundleKnowledgeEntrySchema).default([]),
  bundle_hash: z.string().regex(HEX_64),
});
export type ProfileBundleManifest = z.infer<typeof ProfileBundleManifestSchema>;

/**
 * Inputs for {@link computeBundleHash}. Pass the same data the manifest
 * serializes — the function does the canonicalization (sort by id+file).
 */
export interface BundleHashInput {
  agentSha256: string;
  plugins: ReadonlyArray<{ id: string; version: string; sha256: string }>;
  knowledge: ReadonlyArray<{ file: string; sha256: string }>;
}

/**
 * Deterministic self-hash of a Profile-Bundle. The same logic must run on
 * both Zipper (writes) and Importer (verifies). Plugin/Knowledge order is
 * normalized by sorting before serialization.
 *
 * Format (linewise, `\n` terminator):
 *   spec=1
 *   profile=<id>@<version>
 *   agent=<sha256>
 *   plugins=<id>@<ver>:<sha>,<id>@<ver>:<sha>... (sorted)
 *   knowledge=<file>:<sha>,<file>:<sha>... (sorted)
 */
export function computeBundleHash(
  profileId: string,
  profileVersion: string,
  input: BundleHashInput,
): string {
  const sortedPlugins = [...input.plugins]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `${p.id}@${p.version}:${p.sha256}`)
    .join(',');
  const sortedKnowledge = [...input.knowledge]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((k) => `${k.file}:${k.sha256}`)
    .join(',');

  const lines = [
    'spec=1',
    `profile=${profileId}@${profileVersion}`,
    `agent=${input.agentSha256}`,
    `plugins=${sortedPlugins}`,
    `knowledge=${sortedKnowledge}`,
  ];
  const payload = lines.join('\n') + '\n';
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Convenience: compute sha256 of arbitrary bytes (Buffer or string).
 */
export function sha256Hex(data: Buffer | string): string {
  const hash = createHash('sha256');
  if (typeof data === 'string') hash.update(data, 'utf8');
  else hash.update(data);
  return hash.digest('hex');
}
