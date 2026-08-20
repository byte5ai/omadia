/**
 * Issue #581 — the `publish` primitive's core types.
 *
 * A "version" here is the immutable unit: once `PublishStore.createVersion`
 * returns one, nothing in this package ever updates or deletes that row
 * again — the interface simply has no such method (see `publishStore.ts`).
 * A "pointer" is the ONLY mutable thing an app has: which version number is
 * currently live. `rollbackTo` (in `publish.ts`) only ever moves the
 * pointer; it never touches `publish_versions`.
 */

/** An immutable, already-created version record. */
export interface PublishVersionRecord {
  readonly appId: string;
  readonly version: number;
  readonly name: string;
  readonly entrypoint: string;
  /** sha256 over the published file tree — see `computeContentHash` in
   *  `@omadia/sandbox`. Two publishes of byte-identical content still get
   *  distinct version numbers (this is a log, not a content-addressed
   *  store); `dirHash` is for audit/diffing, not deduplication. */
  readonly dirHash: string;
  /** The scope key of the sandbox this version's files were read from —
   *  audit trail, never re-resolved to fetch anything later. */
  readonly sourceScopeKey: string;
  readonly createdAt: Date;
}

/** The mutable "which version is live" pointer for one app. */
export interface PublishPointer {
  readonly appId: string;
  readonly currentVersion: number;
  readonly updatedAt: Date;
}

export class PublishVersionNotFoundError extends Error {
  constructor(appId: string, version: number) {
    super(`publish: no version ${String(version)} recorded for app '${appId}'`);
    this.name = 'PublishVersionNotFoundError';
  }
}

export class PublishEntrypointNotFoundError extends Error {
  constructor(appId: string, entrypoint: string) {
    super(`publish: entrypoint '${entrypoint}' was not found under the published directory for app '${appId}'`);
    this.name = 'PublishEntrypointNotFoundError';
  }
}

export class PublishTreeTooLargeError extends Error {
  constructor(appId: string, limit: number) {
    super(`publish: directory for app '${appId}' exceeds the ${String(limit)}-file publish limit`);
    this.name = 'PublishTreeTooLargeError';
  }
}
