import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { PluginUiFrame } from '../PluginUiFrame';

/**
 * Epic #470 C8b — the sandbox that made every authenticated call fail.
 *
 * The frame shipped as `allow-scripts allow-forms allow-popups`, deliberately
 * WITHOUT `allow-same-origin`. A sandbox without `allow-same-origin` gives the
 * document an OPAQUE origin, and an opaque origin is not our origin:
 *
 *   - every `fetch('/bot-api/…')` leaves with `Origin: null`, cross-site;
 *   - `SameSite=Lax` on the session cookie — the posture core actually ships —
 *     therefore refuses to attach it;
 *   - `EventSource(url, { withCredentials: true })` has the same problem;
 *   - `localStorage` throws outright.
 *
 * A data-driven plugin UI opens every screen with a GET, so the result was a
 * correctly-styled, correctly-themed, correctly-translated shell showing an
 * error state on every screen. The trust-model decision and its reasoning are
 * in `plan.md` §4.3a addendum in the epic #470 spec directory; this test pins
 * the attribute the decision produced.
 *
 * These assertions are exact-value, not `toContain`. `allow-popups` creeping
 * back, or `allow-same-origin` being dropped again by someone applying a
 * generic "never combine these two" rule, must both fail here.
 */

const SANDBOX = 'allow-same-origin allow-scripts allow-forms';

function frame(): HTMLIFrameElement {
  const { container } = renderWithIntl(<PluginUiFrame pluginId="@omadia/example-ui" />);
  const el = container.querySelector('iframe');
  if (!el) throw new Error('no iframe rendered');
  return el;
}

describe('<PluginUiFrame /> — sandbox', () => {
  it('is sandboxed AND same-origin, in exactly that shape', () => {
    expect(frame().getAttribute('sandbox')).toBe(SANDBOX);
  });

  it('grants same-origin, which is what lets the session cookie travel', () => {
    const tokens = frame().getAttribute('sandbox')?.split(' ') ?? [];
    expect(tokens).toContain('allow-same-origin');
  });

  it('does not grant allow-popups', () => {
    // Nothing in a plugin UI needs to open a window, and a granted capability
    // that nothing uses is only a surface.
    const tokens = frame().getAttribute('sandbox')?.split(' ') ?? [];
    expect(tokens).not.toContain('allow-popups');
  });

  it('does not grant top-level navigation, downloads or modals', () => {
    const tokens = frame().getAttribute('sandbox')?.split(' ') ?? [];
    for (const capability of [
      'allow-top-navigation',
      'allow-top-navigation-by-user-activation',
      'allow-downloads',
      'allow-modals',
      'allow-pointer-lock',
      'allow-presentation',
      'allow-orientation-lock',
    ]) {
      expect(tokens).not.toContain(capability);
    }
  });

  it('sources the bundle from core’s own origin under the plugin prefix', () => {
    // Same-origin is a property of the URL as much as of the sandbox: a
    // scheme-relative or absolute src would re-open the cross-origin hole from
    // the other side, and the sandbox attribute alone would not show it.
    const src = frame().getAttribute('src') ?? '';
    expect(src.startsWith('/p/')).toBe(true);
    expect(src).toContain(`/p/${encodeURIComponent('@omadia/example-ui')}/ui/index.html`);
  });

  it('states the trust model where the attribute is written', () => {
    // The previous comment asserted an isolation the attribute did not deliver
    // and pointed at a workaround that could not work. A wrong rationale next
    // to a security attribute is worse than none, so the file must carry the
    // decision it now implements.
    const source = readFileSync(
      path.resolve(__dirname, '../PluginUiFrame.tsx'),
      'utf-8',
    );
    expect(source).toContain('allow-same-origin');
    expect(source).toMatch(/§4\.3a/);
  });
});
