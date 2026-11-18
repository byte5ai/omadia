'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { pluginUiEntryPath } from '@/app/_lib/pluginId';

/**
 * The iframe that hosts a plugin's compiled SPA (epic #470 C8).
 *
 * WHY THE PARAMS EXIST AT ALL. An iframe is a separate document, so two
 * things the shell takes for granted silently do not cross the boundary
 * (`implementation.md` §2.3 in the epic #470 spec directory):
 *
 *   - `next/font` injects its faces into web-ui's own document only. The
 *     generated plugin stylesheet re-binds the font variables for exactly
 *     this reason.
 *   - `data-theme` / `data-palette` sit on the shell's `<html>`. Without them
 *     the plugin renders in light mode inside a shell the operator forced
 *     dark — a bug that looks like the plugin's fault.
 *
 * So the host passes `?theme=&palette=&locale=` and the plugin's `index.html`
 * mirrors them onto its own `<html>` element. Everything else — the actual
 * colours — then resolves through the one stylesheet core serves.
 *
 * The theme is read from the live DOM rather than from the cookie, and a
 * MutationObserver re-reads it.
 *
 * LIVE UPDATES (#1480). The query string is read once, at load. Changing it
 * later navigates the frame, and so did the `key` this element used to carry:
 * every theme, palette or language switch threw away the plugin's hash route,
 * its form input and its scroll position. A bundle that can apply a change in
 * place says so by posting `{ type: 'omadia:plugin-ui:ready' }` to its parent.
 * From then on the `src` stays put and every change — plus the current value,
 * in reply to each `ready` — arrives as
 * `{ type: 'omadia:plugin-ui:appearance', theme, palette, locale }`.
 * Both directions are pinned to this origin (`event.origin`, `targetOrigin`)
 * and the listener only accepts messages from this frame's window.
 *
 * A bundle that never announces itself keeps the old contract: the `src`
 * follows the appearance and the frame reloads. That costs the state it
 * always cost, but a plugin built before the channel existed still follows
 * the shell instead of freezing in the appearance it loaded with.
 *
 * SANDBOX — `allow-same-origin allow-scripts allow-forms`. This is a trust-
 * model decision, not a default; the reasoning is recorded in
 * `plan.md` §4.3a addendum in the epic #470 spec directory. In short:
 *
 *   - WITHOUT `allow-same-origin` the document gets an OPAQUE origin. Every
 *     `fetch('/bot-api/...')` then leaves with `Origin: null` and is a
 *     cross-site request, so the `SameSite=Lax` session cookie is not
 *     attached, `EventSource(..., { withCredentials: true })` fails the same
 *     way, and `localStorage` throws. A data-driven plugin UI opens every
 *     screen with a GET, so the sandbox did not isolate the plugin — it broke
 *     it, silently, into a correctly-themed error state.
 *   - The plugin grant model is REAL and deny-by-default: `ctx.services`,
 *     `ctx.http`, `ctx.secrets`, `ctx.llm`, `ctx.mcp`, `ctx.memory`, public
 *     paths and the rest are all manifest-declared and operator-consented.
 *     The UI frame walks around that model once it rides the operator's
 *     `Path=/` admin session. What makes this acceptable today is not that the
 *     frame already had that grant, but that the plugin's SERVER half is
 *     loaded by a bare in-process dynamic import with the host's `globalThis`
 *     and `process.env`. Against a malicious plugin author the grant model is
 *     a consent-and-contract seam, not a Node isolation boundary. The honest
 *     residual exposure is different: a compromised browser-only dependency or
 *     XSS in the plugin UI now inherits the operator's admin surface.
 *   - What still constrains the bundle is the RESPONSE, not the attribute:
 *     core serves it under a tight runtime CSP (`default-src 'none'`,
 *     `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'self'`,
 *     `base-uri 'none'`, `form-action 'none'`). Ingest scanning of the UI
 *     bundle is narrower: it reads `.js` / `.mjs` only for arbitrary Tailwind
 *     values; inline script, `javascript:` URLs and `<base>` are blocked at
 *     runtime by that CSP, and the extension allowlist has no `.css`.
 *
 * The sandbox attribute itself is not an enforceable boundary once
 * `allow-same-origin` is granted: a same-origin bundle can reach
 * `window.frameElement`, strip `sandbox`, and reload. It remains as an intent
 * marker for a non-adversarial bundle, not as a claim of isolation.
 *
 * `allow-popups` is deliberately GONE: nothing in a plugin UI opens a window,
 * and a capability nothing uses is only a surface.
 */

type Theme = 'light' | 'dark';

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'dark' || forced === 'light') return forced;
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function readPalette(): string {
  if (typeof document === 'undefined') return 'lagoon';
  return document.documentElement.getAttribute('data-palette') ?? 'lagoon';
}

/** Plugin → host: "I apply appearance messages in place". */
export const PLUGIN_UI_READY_MESSAGE = 'omadia:plugin-ui:ready';
/** Host → plugin: the current appearance. */
export const PLUGIN_UI_APPEARANCE_MESSAGE = 'omadia:plugin-ui:appearance';

interface Appearance {
  readonly theme: Theme;
  readonly palette: string;
  readonly locale: string;
}

function postAppearance(frame: HTMLIFrameElement | null, value: Appearance): void {
  frame?.contentWindow?.postMessage(
    { type: PLUGIN_UI_APPEARANCE_MESSAGE, ...value },
    window.location.origin,
  );
}

function isReadyMessage(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === PLUGIN_UI_READY_MESSAGE
  );
}

export function PluginUiFrame({
  pluginId,
  name,
}: {
  pluginId: string;
  /** Localized plugin name for the frame title (#1479); the id when unknown. */
  name: string;
}): React.ReactElement {
  const t = useTranslations('pluginUi');
  const locale = useLocale();
  const [theme, setTheme] = useState<Theme>('light');
  const [palette, setPalette] = useState('lagoon');
  const [mounted, setMounted] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Set once the bundle announced `ready`: the src it loaded with, frozen.
  // The ref is what the message handler reads, so it never acts on a stale
  // closure.
  const [liveSrc, setLiveSrc] = useState<string | null>(null);
  const liveRef = useRef(false);

  useEffect(() => {
    const sync = (): void => {
      setTheme(readTheme());
      setPalette(readPalette());
    };
    sync();
    setMounted(true);

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette'],
    });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', sync);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', sync);
    };
  }, []);

  const appearance = useMemo<Appearance>(
    () => ({ theme, palette, locale }),
    [theme, palette, locale],
  );
  const appearanceRef = useRef(appearance);

  const reloadSrc = useMemo(() => {
    const params = new URLSearchParams({ ...appearance });
    // Same path the host page probed before it rendered this frame (#1454).
    return `${pluginUiEntryPath(pluginId)}?${params.toString()}`;
  }, [pluginId, appearance]);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return;
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (!isReadyMessage(event.data)) return;
      if (!liveRef.current) {
        liveRef.current = true;
        // Freeze on the src attribute as it stands. If the appearance moved
        // after load, that attribute may already be a navigation in flight;
        // keeping it avoids yet another one, and the new document's own
        // `ready` gets the current value.
        setLiveSrc(frameRef.current?.getAttribute('src') ?? null);
      }
      // Every `ready` gets the current value — a document that reloaded
      // itself re-reads a query string that may be out of date.
      postAppearance(frameRef.current, appearanceRef.current);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    appearanceRef.current = appearance;
    if (liveRef.current) postAppearance(frameRef.current, appearance);
  }, [appearance]);

  // Rendering the iframe before the theme is known would load the bundle once
  // in the wrong appearance and again on correction. One paint, one load.
  if (!mounted) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        {t('loading')}
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      src={liveSrc ?? reloadSrc}
      title={t('frameTitle', { name })}
      className="h-full w-full rounded-md border border-border bg-bg"
      sandbox="allow-same-origin allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  );
}
