import path from 'node:path';

/**
 * Recognising cloud-synced directories, so the wizard can warn before a live
 * PostgreSQL cluster is put somewhere a sync client will evict, lock or
 * duplicate its files (#934).
 *
 * Detection is by path shape rather than by asking the sync client, because
 * every provider has a different (and version-dependent) way of being asked,
 * and a wrong "no" here is worse than a wrong "maybe": the whole point is to
 * say something before the user commits a database to iCloud Drive.
 */

interface SyncedMarker {
  readonly provider: string;
  /** Path segments, relative to the home directory, that identify the root. */
  readonly relativeSegments: readonly string[];
}

const HOME_RELATIVE_MARKERS: readonly SyncedMarker[] = [
  { provider: 'iCloud Drive', relativeSegments: ['Library', 'Mobile Documents'] },
  { provider: 'Dropbox', relativeSegments: ['Dropbox'] },
  { provider: 'OneDrive', relativeSegments: ['OneDrive'] },
  { provider: 'Google Drive', relativeSegments: ['Google Drive'] },
];

/**
 * macOS mounts third-party file providers under `~/Library/CloudStorage` as
 * `<Provider>-<Account>` (e.g. `OneDrive-Contoso`). The provider is worth
 * naming precisely, because "your folder is synced" is much easier to act on
 * when it says which service is doing the syncing.
 */
const CLOUD_STORAGE_SEGMENTS: readonly string[] = ['Library', 'CloudStorage'];

const CLOUD_STORAGE_PROVIDERS: readonly { readonly prefix: string; readonly provider: string }[] = [
  { prefix: 'OneDrive', provider: 'OneDrive' },
  { prefix: 'GoogleDrive', provider: 'Google Drive' },
  { prefix: 'Dropbox', provider: 'Dropbox' },
  { prefix: 'Box', provider: 'Box' },
  { prefix: 'iCloudDrive', provider: 'iCloud Drive' },
];

const GENERIC_CLOUD_PROVIDER = 'a cloud storage service';

/** Segments that identify a provider anywhere in the path, not just under home. */
const ANYWHERE_MARKERS: readonly SyncedMarker[] = [
  { provider: 'iCloud Drive', relativeSegments: ['com~apple~CloudDocs'] },
  { provider: 'OneDrive', relativeSegments: ['OneDrive'] },
  { provider: 'Dropbox', relativeSegments: ['Dropbox'] },
  { provider: 'Google Drive', relativeSegments: ['GoogleDrive'] },
];

function segmentsOf(dir: string): string[] {
  return path.resolve(dir).split(path.sep).filter((segment) => segment.length > 0);
}

function startsWithSegments(
  segments: readonly string[],
  prefix: readonly string[],
): boolean {
  if (prefix.length > segments.length) return false;
  return prefix.every((wanted, index) => segments[index] === wanted);
}

function containsSegments(
  segments: readonly string[],
  wanted: readonly string[],
): boolean {
  for (let start = 0; start + wanted.length <= segments.length; start += 1) {
    if (wanted.every((value, offset) => segments[start + offset] === value)) return true;
  }
  return false;
}

function cloudStorageProvider(mountSegment: string | undefined): string {
  if (mountSegment === undefined) return GENERIC_CLOUD_PROVIDER;
  const match = CLOUD_STORAGE_PROVIDERS.find((candidate) =>
    mountSegment.startsWith(candidate.prefix),
  );
  return match?.provider ?? GENERIC_CLOUD_PROVIDER;
}

/**
 * The sync provider that appears to own `dir`, or null.
 *
 * `homeDir` is a parameter rather than an `os.homedir()` read so this stays a
 * pure function the tests can drive across platforms.
 */
export function detectSyncedLocation(dir: string, homeDir: string): string | null {
  const segments = segmentsOf(dir);
  const homeSegments = segmentsOf(homeDir);

  if (startsWithSegments(segments, homeSegments)) {
    const relative = segments.slice(homeSegments.length);
    if (startsWithSegments(relative, CLOUD_STORAGE_SEGMENTS)) {
      return cloudStorageProvider(relative[CLOUD_STORAGE_SEGMENTS.length]);
    }
    for (const marker of HOME_RELATIVE_MARKERS) {
      if (startsWithSegments(relative, marker.relativeSegments)) return marker.provider;
    }
  }

  for (const marker of ANYWHERE_MARKERS) {
    if (containsSegments(segments, marker.relativeSegments)) return marker.provider;
  }

  return null;
}
