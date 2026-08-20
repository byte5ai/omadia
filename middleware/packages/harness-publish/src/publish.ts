import type { Sandbox } from '@omadia/sandbox';
import { computeContentHash } from '@omadia/sandbox';

import {
  PublishEntrypointNotFoundError,
  PublishVersionNotFoundError,
  type PublishPointer,
  type PublishVersionRecord,
} from './publishManifest.js';
import type { PublishStore } from './publishStore.js';
import { collectTree, type CollectTreeOptions } from './treeCollector.js';

/** What a runtime backend (Docker in v1) must provide for `publish()`/
 *  `rollbackTo()` to drive it. Modelled on `SandboxBackend` from
 *  `@omadia/sandbox`: a narrow required surface, backend-agnostic. */
export interface PublishRuntime {
  /** Materializes `files` as a NEW, independently-running instance of this
   *  exact version and starts it. Called exactly once per version, right
   *  after `PublishStore.createVersion` succeeds for it — an implementation
   *  MAY treat a second `deploy()` call for a version it already deployed
   *  as a no-op (never re-materializing over it) as defense in depth, but
   *  `publish()` itself never calls it twice for the same version. */
  deploy(args: {
    readonly appId: string;
    readonly version: number;
    readonly entrypoint: string;
    readonly files: ReadonlyMap<string, string>;
  }): Promise<void>;
}

export interface PublishInput {
  /** Stable app identifier (URL/host-prefix-safe slug); the SAME `appId`
   *  across calls is what makes them versions of one app rather than
   *  separate apps. */
  readonly appId: string;
  readonly name: string;
  /** Path to the file (relative to `dir`) the runtime should run. */
  readonly entrypoint: string;
  /** Root-relative directory in `sandbox` to publish. */
  readonly dir: string;
  readonly sourceScopeKey: string;
}

/**
 * The `publish` primitive (issue #581): reads `input.dir` out of `sandbox`
 * (traversal-clamped — see `treeCollector.ts`), records it as a brand-new,
 * immutable version in `store`, deploys it via `runtime`, and only THEN
 * flips the app's pointer to it. A failed `runtime.deploy()` leaves the
 * version recorded (it did happen — the row is evidence, per the store's
 * insert-only contract) but the pointer untouched, so a broken publish
 * never takes down whatever was live before it.
 */
export async function publish(args: {
  readonly sandbox: Pick<Sandbox, 'list' | 'read'>;
  readonly store: PublishStore;
  readonly runtime: PublishRuntime;
  readonly input: PublishInput;
  readonly now?: Date;
  readonly collectOptions?: CollectTreeOptions;
}): Promise<PublishVersionRecord> {
  const now = args.now ?? new Date();
  const files = await collectTree(args.sandbox, args.input.dir, args.input.appId, args.collectOptions);
  if (!files.has(args.input.entrypoint)) {
    throw new PublishEntrypointNotFoundError(args.input.appId, args.input.entrypoint);
  }

  const dirHash = computeContentHash(Object.fromEntries(files));
  const record = await args.store.createVersion({
    appId: args.input.appId,
    name: args.input.name,
    entrypoint: args.input.entrypoint,
    dirHash,
    sourceScopeKey: args.input.sourceScopeKey,
    now,
  });

  await args.runtime.deploy({
    appId: record.appId,
    version: record.version,
    entrypoint: record.entrypoint,
    files,
  });

  await args.store.setPointer(record.appId, record.version, now);
  return record;
}

/**
 * `rollbackTo` is a pointer flip, full stop: it reads the target version
 * (to fail clearly if it does not exist) and then calls ONLY
 * `store.setPointer`. It never calls `PublishRuntime.deploy` and never
 * calls `store.createVersion` — a version that was already deployed is
 * still running from its own prior `publish()` call; there is nothing to
 * rebuild. Callers verifying this end-to-end should assert their
 * `PublishRuntime.deploy` spy's call count is unchanged after a rollback.
 */
export async function rollbackTo(args: {
  readonly store: PublishStore;
  readonly appId: string;
  readonly version: number;
  readonly now?: Date;
}): Promise<PublishPointer> {
  const target = await args.store.getVersion(args.appId, args.version);
  if (!target) {
    throw new PublishVersionNotFoundError(args.appId, args.version);
  }
  return args.store.setPointer(args.appId, args.version, args.now ?? new Date());
}
