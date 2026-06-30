import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { MemoryStore } from '@omadia/plugin-api';

/**
 * Per-user UI preferences — the server-side home for the Lume palette +
 * appearance choice (issue #287, visual-spec §2.5.4).
 *
 * §2.5.4 binds the accent palette per
 * `memory://ui-prefs/<tenantId>/<userId>/<contextKey>/accent`. The first Lume
 * integration (#284) parked the palette + appearance choice in localStorage —
 * per browser, no multi-device sync. This router moves it into the MemoryStore
 * so the choice follows the user across devices. The operator UI is a single
 * context today, so `tenantId` and `contextKey` collapse to the constants
 * `default` / `operator` (per the ticket: "contextKey can collapse to a single
 * operator context for now").
 *
 * The web-ui mirrors the value into a non-secret cookie so the pre-paint
 * bootstrap can set `data-palette`/`data-theme` on <html> with no FOUC; this
 * store stays the source of truth that seeds that cookie on a fresh device.
 *
 * Mounted under `/api/v1/ui-prefs`, gated by `requireAuth`.
 *   GET /  → current prefs ({} when none stored yet)
 *   PUT /  → upsert { palette?, appearance? }
 */

const PALETTES = ['lagoon', 'petrol', 'atelier'] as const;
const APPEARANCES = ['system', 'light', 'dark'] as const;

const UiPrefsSchema = z
  .object({
    palette: z.enum(PALETTES).optional(),
    appearance: z.enum(APPEARANCES).optional(),
  })
  .strict();

export type UiPrefs = z.infer<typeof UiPrefsSchema>;

export interface UiPrefsRouterDeps {
  store: MemoryStore;
  log?: (msg: string) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a session user id onto a path-safe MemoryStore segment. `omadia_user_id`
 *  is a KG cluster id, but escaping keeps the path valid regardless of the id
 *  shape the provider mints. The escaping is INJECTIVE — every char outside
 *  `[A-Za-z0-9-]`, including `.` and `_` themselves, becomes `_<4-hex code
 *  unit>` — so (a) two distinct ids can never collapse onto the same path
 *  (which would leak one user's prefs to another), and (b) no segment can ever
 *  be `.` or `..`, so a `..` id can't traverse out of the per-user directory. */
function safeSegment(id: string): string {
  return id.replace(
    /[^A-Za-z0-9-]/g,
    (c) => `_${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function prefsPath(userId: string): string {
  return `/memories/ui-prefs/default/${safeSegment(userId)}/operator.json`;
}

/** Read + validate the stored prefs, or `{}` when absent. A stored value that
 *  is corrupt (non-JSON), pre-dates a schema change, or got hand-edited is
 *  treated as unset rather than surfaced as an error — the client falls back
 *  to its defaults, and crucially a corrupt file does not brick the read-merge
 *  PUT path (which would otherwise 500 on every write, leaving no way to
 *  overwrite the bad value). Real IO errors still propagate to the caller. */
async function readPrefs(store: MemoryStore, path: string): Promise<UiPrefs> {
  if (!(await store.fileExists(path))) return {};
  const raw = await store.readFile(path);
  try {
    const parsed = UiPrefsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function requireSessionUserId(req: Request, res: Response): string | null {
  const id = req.session?.omadia_user_id;
  if (!id) {
    res.status(401).json({ code: 'auth.required', message: 'login required' });
    return null;
  }
  return id;
}

export function createUiPrefsRouter(deps: UiPrefsRouterDeps): Router {
  const router = Router();
  const log = deps.log ?? ((m) => console.log(m));

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const userId = requireSessionUserId(req, res);
    if (!userId) return;
    try {
      res.json(await readPrefs(deps.store, prefsPath(userId)));
    } catch (err) {
      // Log the detail; return a generic message so an internal store error
      // (paths, driver internals) is not echoed back to the client.
      log(`[ui-prefs/route] GET / failed: ${errMsg(err)}`);
      res
        .status(500)
        .json({ code: 'ui_prefs.read_failed', message: 'failed to read ui prefs' });
    }
  });

  router.put('/', async (req: Request, res: Response): Promise<void> => {
    const userId = requireSessionUserId(req, res);
    if (!userId) return;
    const parsed = UiPrefsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'ui_prefs.invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      // MERGE, not replace: the fields are individually optional, so a PUT of
      // `{ palette }` must leave a previously stored `appearance` intact (and
      // vice versa) rather than silently dropping the other key.
      const path = prefsPath(userId);
      const next = { ...(await readPrefs(deps.store, path)), ...parsed.data };
      await deps.store.writeFile(path, JSON.stringify(next));
      res.status(204).end();
    } catch (err) {
      log(`[ui-prefs/route] PUT / failed: ${errMsg(err)}`);
      res
        .status(500)
        .json({ code: 'ui_prefs.write_failed', message: 'failed to write ui prefs' });
    }
  });

  return router;
}
