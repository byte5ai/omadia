import { Router } from 'express';
import type { Request, Response } from 'express';
import { MemoryPathError, type MemoryStore } from '@omadia/plugin-api';

import { createRootedMemoryAccessor } from '../platform/memoryAccessor.js';

/**
 * Operator-facing, read-only browser for the chat-context memory trees
 * (epic #860, design #870 §2 — wave W2a carry-over from W5).
 *
 *   GET /list?path=/memories/contexts[/...]   directory listing
 *   GET /file?path=/memories/contexts/...     file content (text/plain)
 *
 * MOUNT + GATE
 * ------------
 * Mounted at `/api/v1/operator/memory/contexts` behind `requireAuth` (cookie
 * session JWT) — the same gate `routes/memoryPurge.ts` and
 * `routes/memoryPromote.ts` document, and the `/api/v1/operator/*` prefix
 * `routes/operatorAgents.ts` and `routes/operatorChannels.ts` already own.
 * Deliberately NOT on the machine-to-machine `ADMIN_TOKEN` surface in
 * `admin.ts`: the browser authenticates as a logged-in admin user.
 * The mount itself lives in `src/index.ts` and is owned by the wiring unit.
 *
 * The router ALSO checks for a session itself. That is not redundant with the
 * mount-time `requireAuth`: this endpoint reads memory that the whole
 * chat-context ACL exists to partition, so a future re-mount that forgets the
 * gate must not silently open the tree. `memoryPromote.ts` applies the same
 * belt-and-braces rule for the same reason.
 *
 * WHY IT EXISTS
 * -------------
 * `web-ui/app/memory/page.tsx` browses the context trees through
 * `/bot-api/dev/memory/list` — `packages/harness-memory/src/devMemoryRouter.ts`,
 * mounted by the memory plugin only when `dev_memory_endpoints_enabled` is
 * truthy, which the kernel forbids in production. That router is unauthenticated
 * and exposes the WHOLE `/memories` tree, so it can never be the production
 * answer. This is the production answer: authenticated, and structurally unable
 * to leave `/memories/contexts`.
 *
 * WIRE SHAPE — settled here, deliberately
 * ---------------------------------------
 * The response is byte-compatible with the dev router's:
 *
 *   { path: string, entries: [{ virtualPath, isDirectory, sizeBytes }] }
 *
 * so `web-ui`'s existing `ListResponse` / `Entry` types and its
 * "filter out the self entry" logic carry over unchanged and only the URL
 * moves. `/file` likewise answers `text/plain; charset=utf-8`, matching the
 * page's second call site — the browser would otherwise render a tree whose
 * files cannot be previewed in production.
 *
 * READ-ONLY
 * ---------
 * There is no write, delete or promote verb here. Promotion — the one audited
 * way knowledge crosses a context boundary — lives at
 * `POST /api/v1/admin/memory/promotions/:slug` (`routes/memoryPromote.ts`).
 *
 * THE GUARD IS THE CHOKE POINT
 * ----------------------------
 * `resolveContextPath` normalises the operator's absolute `?path=` into a
 * relative path under `CONTEXTS_ROOT` and rejects everything else BEFORE the
 * store is touched; `createRootedMemoryAccessor` then re-normalises it and
 * cannot emit a path outside the root even if this file were wrong. Two
 * independent layers, because between them stands the entire rest of
 * `/memories` — the agent tier, the shared kernel, every other tenant's
 * context tree.
 */

/** The one subtree this router can ever read. */
export const CONTEXTS_ROOT = '/memories/contexts';

/** Mirrors `memoryPromote`'s path budget so the two agree on what is absurd. */
const MAX_PATH_LENGTH = 1024;

export interface OperatorMemoryContextsDeps {
  /** ROOT (undecorated) MemoryStore — the accessor does the scoping. */
  store: MemoryStore;
  /** Injectable log sink. Defaults to `console.error`. */
  log?: (message: string) => void;
}

/** A `?path=` that survived the guard. */
interface ResolvedPath {
  /** Normalised absolute virtual path, echoed back to the client. */
  readonly abs: string;
  /** Same path relative to `CONTEXTS_ROOT`; `''` means the root itself. */
  readonly rel: string;
}

const ROOT_SEGMENTS = CONTEXTS_ROOT.split('/').filter((s) => s.length > 0);

/**
 * Normalise and scope-check the requested path.
 *
 * Accepts an ABSOLUTE virtual path because that is how the operator UI and
 * every other memory surface in this repo speak (`memoryPurge` selectors, the
 * promote source paths, the dev router). Rejects, in order:
 *
 *   - a non-string / oversized `?path=`
 *   - any `.` or `..` segment, so no request can even ASK to traverse
 *   - anything whose first two segments are not `memories/contexts`, which is
 *     a segment-wise test — `/memories/contextsX` and `/memories/context` both
 *     fail, where a naive `startsWith` would let the first through
 *
 * An empty / missing `path` means the root, matching the dev router.
 */
export function resolveContextPath(raw: unknown): ResolvedPath | null {
  if (raw === undefined || raw === '') {
    return { abs: CONTEXTS_ROOT, rel: '' };
  }
  if (typeof raw !== 'string' || raw.length > MAX_PATH_LENGTH) return null;
  if (raw.includes('\u0000')) return null;
  if (!raw.startsWith('/')) return null;

  const segments = raw.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  if (segments.length < ROOT_SEGMENTS.length) return null;
  for (const [i, expected] of ROOT_SEGMENTS.entries()) {
    if (segments[i] !== expected) return null;
  }

  const rel = segments.slice(ROOT_SEGMENTS.length).join('/');
  return { abs: rel.length === 0 ? CONTEXTS_ROOT : `${CONTEXTS_ROOT}/${rel}`, rel };
}

/** Turn a scope-relative entry path back into the absolute path the UI shows. */
function absoluteOf(relPath: string): string {
  return relPath.length === 0 ? CONTEXTS_ROOT : `${CONTEXTS_ROOT}/${relPath}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True once a session is present; sends the 401 and returns false otherwise. */
function hasSession(req: Request, res: Response): boolean {
  if (req.session?.omadia_user_id ?? req.session?.sub) return true;
  res.status(401).json({ error: 'auth.required', message: 'login required' });
  return false;
}

export function createOperatorMemoryContextsRouter(
  deps: OperatorMemoryContextsDeps,
): Router {
  const router = Router();
  const log =
    deps.log ??
    ((message: string): void => {
      console.error(message);
    });
  const memory = createRootedMemoryAccessor({
    store: deps.store,
    root: CONTEXTS_ROOT,
  });

  router.get('/list', async (req: Request, res: Response) => {
    if (!hasSession(req, res)) return;

    const resolved = resolveContextPath(req.query['path']);
    if (resolved === null) {
      res.status(400).json({
        error: 'invalid_path',
        message: `path must be an absolute path under ${CONTEXTS_ROOT}`,
      });
      return;
    }

    try {
      // The root itself is allowed to be absent: a store that has never
      // written a context tree has no `/memories/contexts` directory, and that
      // is an empty browser, not a 404. Deeper paths must exist — an operator
      // typing a wrong ctxKey deserves to be told so, not shown an empty list.
      if (resolved.rel.length > 0 && !(await memory.exists(resolved.rel))) {
        res.status(404).json({ error: 'not_found', path: resolved.abs });
        return;
      }
      const entries = await memory.list(resolved.rel);
      res.json({
        path: resolved.abs,
        entries: entries.map((e) => ({
          virtualPath: absoluteOf(e.relPath),
          isDirectory: e.isDirectory,
          sizeBytes: e.sizeBytes,
        })),
      });
    } catch (err) {
      // A MemoryPathError here means the accessor's own guard fired on a path
      // the route's guard had already accepted — a bug in one of the two, and
      // worth a log line even though the client only sees a 400.
      if (err instanceof MemoryPathError) {
        log(`[operator-memory-contexts] scope guard fired on ${resolved.abs}: ${messageOf(err)}`);
      }
      res
        .status(400)
        .json({ error: 'memory_list_failed', message: messageOf(err) });
    }
  });

  router.get('/file', async (req: Request, res: Response) => {
    if (!hasSession(req, res)) return;

    const resolved = resolveContextPath(req.query['path']);
    if (resolved === null || resolved.rel.length === 0) {
      res.status(400).json({
        error: 'invalid_path',
        message: `path must name a file under ${CONTEXTS_ROOT}`,
      });
      return;
    }

    try {
      const content = await memory.readFile(resolved.rel);
      res.type('text/plain; charset=utf-8').send(content);
    } catch (err) {
      if (err instanceof MemoryPathError) {
        log(`[operator-memory-contexts] scope guard fired on ${resolved.abs}: ${messageOf(err)}`);
        res
          .status(400)
          .json({ error: 'memory_read_failed', message: messageOf(err) });
        return;
      }
      // The store distinguishes "missing" from "is a directory" with its own
      // error classes, but those live in the provider package — this router
      // only depends on the `MemoryStore` contract. Ask the accessor instead,
      // which keeps the 404/400 split honest without a package dependency.
      if (!(await memory.exists(resolved.rel))) {
        res.status(404).json({ error: 'not_found', path: resolved.abs });
        return;
      }
      res
        .status(400)
        .json({ error: 'memory_read_failed', message: messageOf(err) });
    }
  });

  return router;
}
