import { Router } from 'express';
import { html, htmlDoc, renderRoute, safe } from '@omadia/plugin-ui-helpers';

import type { NotesStore } from '../notesStore.js';

export interface UiRouterOptions {
  readonly notes: NotesStore;
}

/**
 * PoC plugin-served UI route. Renders an HTML page directly from middleware
 * Express; web-ui rewrites `/p/agent-reference-maximum/*` to land here.
 *
 * No React, no client JS — sketch phase. Tailwind via CDN. iframe-safe
 * headers come from renderRoute() automatically.
 */
export function createUiRouter(opts: UiRouterOptions): Router {
  const router = Router();

  router.get(
    '/dashboard',
    renderRoute(async () => {
      const notes = await opts.notes.list();
      const noteItems = notes.slice(0, 10).map(
        (n) => html`
          <li class="border border-slate-200 rounded-md p-3 bg-white">
            <div class="text-xs text-slate-500 mb-1">${n.id}</div>
            <div class="text-sm">${n.body}</div>
          </li>
        `,
      );
      return htmlDoc({
        title: 'Reference Agent — Dashboard',
        // Self-filling: re-fetch every 30s so a Teams Tab pinned to
        // this URL surfaces new notes (added via the bot in chat)
        // without the user having to refresh manually.
        refreshSeconds: 30,
        body: html`
          <main class="max-w-3xl mx-auto p-6 space-y-6">
            <header>
              <h1 class="text-2xl font-semibold tracking-tight">
                Reference Agent
              </h1>
              <p class="text-sm text-slate-500">
                Plugin-served UI Surface — PoC 2026-05-15
              </p>
            </header>

            <section class="grid grid-cols-2 gap-4">
              <div class="bg-white border border-slate-200 rounded-lg p-4">
                <div class="text-xs uppercase text-slate-500">Notes</div>
                <div class="text-3xl font-semibold mt-1">${notes.length}</div>
              </div>
              <div class="bg-white border border-slate-200 rounded-lg p-4">
                <div class="text-xs uppercase text-slate-500">Source</div>
                <div class="text-sm mt-2 font-mono">
                  agent-reference-maximum
                </div>
              </div>
            </section>

            <section>
              <h2 class="text-lg font-medium mb-3">Recent notes</h2>
              ${notes.length === 0
                ? safe('<p class="text-sm text-slate-500">No notes yet.</p>')
                : html`<ul class="space-y-2">${noteItems}</ul>`}
            </section>
          </main>
        `,
      });
    }),
  );

  return router;
}
