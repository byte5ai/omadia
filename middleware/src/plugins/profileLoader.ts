import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Bootstrap-Profile loader (S+12-1).
 *
 * Profiles are curated plugin-stacks an operator can apply on a fresh
 * deployment. Default-3 (`production`, `minimal-dev`, `blank`) ship as
 * built-ins under `<repo>/middleware/profiles/*.yaml`; operators can also
 * upload custom profiles via the existing `/store/upload` mechanic
 * (handled in S+12-2a alongside the apply-endpoint).
 *
 * Schema v1 carries plugin IDs (reverse-domain agent-IDs) plus optional
 * non-secret initial config per plugin. Secrets stay operator-input — the
 * profile is shareable, the vault is not.
 */

const ProfilePluginEntryRawSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const ProfileFileSchema = z.object({
  schema_version: z.literal(1),
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      'profile id must be lowercase kebab-case (e.g. "production")',
    ),
  name: z.string().min(1),
  description: z.string().min(1),
  plugins: z.array(ProfilePluginEntryRawSchema),
});

export interface ProfilePluginEntry {
  id: string;
  config: Record<string, unknown>;
}

export interface Profile {
  schema_version: 1;
  id: string;
  name: string;
  description: string;
  plugins: ProfilePluginEntry[];
}

export class ProfileLoadError extends Error {
  constructor(
    message: string,
    public readonly file: string,
    cause?: unknown,
  ) {
    super(
      `profile-load: ${file}: ${message}`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'ProfileLoadError';
  }
}

function normalizePlugins(
  raw: z.infer<typeof ProfileFileSchema>['plugins'],
): ProfilePluginEntry[] {
  return raw.map((entry) =>
    typeof entry === 'string'
      ? { id: entry, config: {} }
      : { id: entry.id, config: entry.config ?? {} },
  );
}

export async function loadProfile(filePath: string): Promise<Profile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new ProfileLoadError(
      err instanceof Error ? err.message : String(err),
      filePath,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ProfileLoadError(
      `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
      filePath,
      err,
    );
  }

  const result = ProfileFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ProfileLoadError(`schema validation: ${issues}`, filePath);
  }

  const expectedId = path.basename(filePath, path.extname(filePath));
  if (result.data.id !== expectedId) {
    throw new ProfileLoadError(
      `id mismatch: file is named '${expectedId}.yaml' but profile id is '${result.data.id}' — they must match so /api/v1/profiles/:id resolves correctly`,
      filePath,
    );
  }

  const plugins = normalizePlugins(result.data.plugins);
  const seen = new Set<string>();
  for (const entry of plugins) {
    if (seen.has(entry.id)) {
      throw new ProfileLoadError(
        `duplicate plugin id '${entry.id}' in plugins list`,
        filePath,
      );
    }
    seen.add(entry.id);
  }

  return {
    schema_version: 1,
    id: result.data.id,
    name: result.data.name,
    description: result.data.description,
    plugins,
  };
}

export async function listProfiles(dir: string): Promise<Profile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const yamlFiles = entries
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const profiles: Profile[] = [];
  for (const file of yamlFiles) {
    profiles.push(await loadProfile(path.join(dir, file)));
  }
  return profiles;
}

/**
 * Resolve the built-in profiles directory shipped inside the middleware
 * repo. Lives at `<middleware>/profiles/` regardless of dev vs. compiled
 * runtime — `dist/` is co-located with `src/` so the relative jump is the
 * same in both modes.
 */
export function builtInProfilesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/plugins/profileLoader.ts → ../../profiles
  // dist/plugins/profileLoader.js → ../../profiles
  return path.resolve(here, '..', '..', 'profiles');
}
