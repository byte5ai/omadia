/**
 * Concrete {@link AttachmentReader} factory (#268 sub-problem 2).
 *
 * Builds the byte source the orchestrator uses for attachment auto-ingest +
 * the `read_attachment` tool, over the shared S3/Tigris bucket. The store is
 * duck-typed to just the `getStream` shape so this package never has to
 * import `@aws-sdk` or depend on `@omadia/diagrams` at type level — the
 * kernel passes whatever `tigrisStore` service it has.
 *
 * `readByStorageKey` drains the store's Readable into a Buffer.
 * `readByUrl` uses global `fetch`. Both return `undefined` (never throw) on
 * a missing store or any I/O failure, so the feature is inert when the
 * bucket env is unconfigured.
 */

import type { Readable } from 'node:stream';

import type { AttachmentReader } from './tools/readAttachmentTool.js';
import { guardAttachmentRead } from './audienceFloorGuard.js';
import {
  bindingForRawScope,
  bindingsEqual,
  type AttachmentBindingStore,
} from './attachmentBinding.js';
import { turnContext } from './turnContext.js';

/** Minimal structural view of the kernel's `tigrisStore` service. */
export interface AttachmentByteStore {
  getStream(key: string): Promise<{
    stream: Readable;
    contentType: string | undefined;
    contentLength: number | undefined;
  }>;
}

async function drainToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Last path segment of a storage key, used as a best-effort fileName. */
function fileNameFromKey(key: string): string | undefined {
  const seg = key.split('/').pop();
  return seg && seg.length > 0 ? seg : undefined;
}

/**
 * #575 — wrap a reader so every handle redemption passes the audience floor.
 *
 * The check rides with the handle rather than sitting at each call site, which
 * is the point spec §5.2 makes: a storage key outlives the turn that minted it,
 * and a resolution site added later would otherwise silently escape the guard.
 * Wrapping the reader covers `read_attachment`, the orchestrator's own
 * `ingestAttachments`, and anything added next, by construction.
 *
 * A refusal returns `undefined` — the reader's existing "unavailable" contract —
 * rather than throwing, so no caller needs new error handling. That does mean a
 * denial is indistinguishable from "unknown key" *to the model*, and that is
 * deliberate rather than sloppy: a message confirming that the key exists but
 * is off-limits would leak the document's existence to a room that may not know
 * it. The real reason goes to the operator log, where it is actionable and not
 * a side channel.
 *
 * Inert when no audience source is installed, like every other guard here.
 *
 * ## The second check: the room that MINTED the handle
 *
 * The floor check above answers "may this room redeem a storage handle at all".
 * With a `bindings` store it is joined by "and was this handle minted here" —
 * closing the gap `audienceFloorGuard`'s own header names, where a key issued
 * in a private chat stays redeemable in any room holding `attachment:read`.
 *
 * The binding rides with the handle for the same reason the floor check does:
 * a storage key outlives its turn, so a check placed at a call site holds only
 * until somebody adds the next one.
 *
 * Order matters. The floor is evaluated FIRST, so a room that may not read
 * attachments at all is refused without this ever touching the database — and
 * without a row being written that would bind the handle to a room that was
 * never allowed to see it.
 *
 * `readByUrl` is deliberately untouched: a URL is not a storage key, carries no
 * binding, and its own reachability is the channel's business.
 */
export function audienceGuardedAttachmentReader(
  inner: AttachmentReader,
  bindings?: AttachmentBindingStore,
): AttachmentReader {
  return {
    async readByStorageKey(storageKey) {
      const refusal = await guardAttachmentRead();
      if (refusal !== undefined) {
        console.warn(`[harness-orchestrator] attachment read refused by audience floor: ${refusal}`);
        return undefined;
      }
      const bindingRefusal = await enforceScopeBinding(bindings, storageKey);
      if (bindingRefusal !== undefined) {
        console.warn(
          `[harness-orchestrator] attachment read refused by handle binding: ${bindingRefusal}`,
        );
        return undefined;
      }
      return inner.readByStorageKey(storageKey);
    },
    async readByUrl(url) {
      const refusal = await guardAttachmentRead();
      if (refusal !== undefined) {
        console.warn(`[harness-orchestrator] attachment fetch refused by audience floor: ${refusal}`);
        return undefined;
      }
      return inner.readByUrl(url);
    },
  };
}

/**
 * Compare this turn's room against the one the handle was minted in, recording
 * the binding on first sighting.
 *
 * @returns an operator-readable reason to refuse, or `undefined` to allow.
 */
async function enforceScopeBinding(
  bindings: AttachmentBindingStore | undefined,
  storageKey: string,
): Promise<string | undefined> {
  // No store ⇒ not enforced, exactly like an absent audience provider. A
  // deployment that has not opted in must behave as it did before.
  if (!bindings) return undefined;

  // A non-addressable scope identifies no room — `'http-default'` is shared by
  // every unscoped HTTP caller (#445), `teams-unknown` by every Teams activity
  // missing a conversation id. Binding to one would declare all of them the
  // same room, so the check stands down rather than approximating.
  const current = bindingForRawScope(turnContext.current()?.sessionScope);
  if (!current) return undefined;

  try {
    const minted = await bindings.get(storageKey);
    if (!minted) {
      // First sighting is the minting. Recorded only now that the floor has
      // already permitted this room to read attachments.
      await bindings.bindIfAbsent(storageKey, current);
      return undefined;
    }
    if (bindingsEqual(minted, current)) return undefined;
    // The reason names both rooms for the operator log. The caller turns this
    // into the reader's ordinary "unavailable", so the model learns nothing
    // about the handle's existence — see the wrapper's header.
    return `handle was minted for ${minted.scopeKind}:${minted.scopeRef}, redeemed from ${current.scopeKind}:${current.scopeRef}`;
  } catch (err) {
    // A store that cannot answer must not read as "unbound". Same asymmetry as
    // the grant store: degrading to "allowed" would execute a read nobody
    // authorised, while degrading to "refused" only withholds one.
    return `binding store unavailable (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Construct an {@link AttachmentReader}. When `store` is `undefined`
 * (bucket env not set), `readByStorageKey` always resolves to `undefined`
 * and the feature is inert; `readByUrl` still works via `fetch`.
 *
 * Unguarded on its own — `plugin.ts` wraps it in
 * {@link audienceGuardedAttachmentReader} at the single construction site.
 */
export function createAttachmentReader(
  store: AttachmentByteStore | undefined,
): AttachmentReader {
  return {
    async readByStorageKey(storageKey) {
      if (!store) return undefined;
      try {
        const { stream, contentType } = await store.getStream(storageKey);
        const bytes = await drainToBuffer(stream);
        const fileName = fileNameFromKey(storageKey);
        return {
          bytes,
          ...(contentType ? { contentType } : {}),
          ...(fileName ? { fileName } : {}),
        };
      } catch {
        return undefined;
      }
    },
    async readByUrl(url) {
      try {
        const res = await fetch(url);
        if (!res.ok) return undefined;
        const buf = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') ?? undefined;
        return { bytes: buf, ...(contentType ? { contentType } : {}) };
      } catch {
        return undefined;
      }
    },
  };
}
