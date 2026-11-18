import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decodePluginIdSegment,
  isValidPluginId,
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_PATTERN,
  pluginUiEntryPath,
} from '../pluginId';

/**
 * Epic #470 C8b — the plugin-id gate on the plugin-UI host page.
 *
 * The gate shipped with a comment claiming it mirrored `manifestLoader`, and a
 * pattern that did not: no optional `@scope/`, no `@` or `/` in the character
 * class. Every omadia plugin id is scoped, so `/plugin-ui/@omadia/example-ui`
 * called `notFound()` on the only id that package can have — a 404 on the one
 * route the nav entry points at. The comment was the whole enforcement, and a
 * comment cannot fail.
 */

const MANIFEST_LOADER = path.resolve(
  __dirname,
  '../../../../middleware/src/plugins/manifestLoader.ts',
);

describe('plugin-id gate — pinned to the middleware authority', () => {
  it('is character-identical to manifestLoader PLUGIN_ID_PATTERN', () => {
    const source = readFileSync(MANIFEST_LOADER, 'utf-8');
    const match = source.match(/^const PLUGIN_ID_PATTERN = (\/.*\/);$/m);
    // A failure here means the anchor moved, not that the patterns agree.
    expect(
      match,
      'could not find `const PLUGIN_ID_PATTERN = /…/;` in manifestLoader.ts — ' +
        'if it was renamed or reformatted, update this anchor rather than deleting the check',
    ).not.toBeNull();
    expect(match?.[1]).toBe(PLUGIN_ID_PATTERN.toString());
  });

  it('is character-identical to manifestLoader PLUGIN_ID_MAX_LENGTH', () => {
    const source = readFileSync(MANIFEST_LOADER, 'utf-8');
    const match = source.match(/^const PLUGIN_ID_MAX_LENGTH = (\d+);$/m);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(PLUGIN_ID_MAX_LENGTH);
  });
});

describe('the host route uses the shared gate rather than its own', () => {
  const PAGE = path.resolve(__dirname, '../../plugin-ui/[pluginId]/page.tsx');

  it('imports decodePluginIdSegment (which runs isValidPluginId)', () => {
    expect(readFileSync(PAGE, 'utf-8')).toContain(
      "import { decodePluginIdSegment } from '@/app/_lib/pluginId'",
    );
  });

  it('declares no plugin-id regex of its own', () => {
    // The defect was a second definition that drifted from the first. A
    // re-introduced local regex must fail here rather than at a 404.
    const source = readFileSync(PAGE, 'utf-8');
    expect(source).not.toMatch(/^const PLUGIN_ID\b/m);
    expect(source).not.toMatch(/\[a-z0-9\._-\]/);
  });
});

describe('isValidPluginId', () => {
  it('accepts the scoped ids every omadia plugin actually uses', () => {
    // The regression this whole change exists for.
    expect(isValidPluginId('@omadia/example-ui')).toBe(true);
    expect(isValidPluginId('@omadia/channel-teams')).toBe(true);
    expect(isValidPluginId('@omadia/integration-odoo')).toBe(true);
  });

  it('still accepts the unscoped and reverse-FQDN forms', () => {
    expect(isValidPluginId('proof-plugin')).toBe(true);
    expect(isValidPluginId('de.byte5.agent.foo')).toBe(true);
    expect(isValidPluginId('a')).toBe(true);
  });

  it('rejects the shapes that would make an id unsafe as a path segment', () => {
    // Traversal is structurally unreachable rather than filtered: a segment
    // may not begin with `.`, so neither `.` nor `..` can be one.
    expect(isValidPluginId('..')).toBe(false);
    expect(isValidPluginId('.')).toBe(false);
    expect(isValidPluginId('@omadia/..')).toBe(false);
    expect(isValidPluginId('@../example-ui')).toBe(false);
    expect(isValidPluginId('../../etc/passwd')).toBe(false);
    expect(isValidPluginId('@omadia/example/ui')).toBe(false);
    expect(isValidPluginId('/etc/passwd')).toBe(false);
    expect(isValidPluginId('plugin\0')).toBe(false);
  });

  it('rejects the charset the middleware rejects', () => {
    expect(isValidPluginId('@Omadia/example-ui')).toBe(false);
    expect(isValidPluginId('@omadia/Dev-Platform')).toBe(false);
    expect(isValidPluginId('omadia/example-ui')).toBe(false);
    expect(isValidPluginId('@omadia')).toBe(false);
    expect(isValidPluginId('')).toBe(false);
    expect(isValidPluginId('-leading-dash')).toBe(false);
  });

  it('enforces npm’s 214-character cap, scope included', () => {
    const scope = '@omadia/';
    expect(isValidPluginId(scope + 'a'.repeat(PLUGIN_ID_MAX_LENGTH - scope.length))).toBe(
      true,
    );
    expect(
      isValidPluginId(scope + 'a'.repeat(PLUGIN_ID_MAX_LENGTH - scope.length + 1)),
    ).toBe(false);
  });

  it('rejects the still-encoded segment — it is not an id', () => {
    // Next 16 hands the route the ENCODED segment (#1399); the raw value must
    // go through `decodePluginIdSegment`, never straight into the gate.
    expect(isValidPluginId('%40omadia%2Fexample-ui')).toBe(false);
  });
});

describe('decodePluginIdSegment — the host route param (#1399)', () => {
  it('decodes the percent-encoded segment Next 16 passes to the page', () => {
    expect(decodePluginIdSegment('%40omadia%2Fexample-ui')).toBe('@omadia/example-ui');
    expect(decodePluginIdSegment('%40omadia%2Fdev-platform')).toBe('@omadia/dev-platform');
  });

  it('accepts a segment that already arrived decoded', () => {
    expect(decodePluginIdSegment('@omadia/example-ui')).toBe('@omadia/example-ui');
    expect(decodePluginIdSegment('some-plugin')).toBe('some-plugin');
  });

  it('returns null for broken percent-encoding instead of throwing', () => {
    expect(decodePluginIdSegment('%E0%A4%A')).toBeNull();
    expect(decodePluginIdSegment('%40omadia%2')).toBeNull();
  });

  it('gates the DECODED value, so encoded traversal is rejected', () => {
    expect(decodePluginIdSegment('%2e%2e')).toBeNull();
    expect(decodePluginIdSegment('%40omadia%2F..')).toBeNull();
    expect(decodePluginIdSegment('%40omadia%2F%2e%2e')).toBeNull();
    expect(decodePluginIdSegment('%2Fetc%2Fpasswd')).toBeNull();
    expect(decodePluginIdSegment('plugin%00')).toBeNull();
  });

  it('rejects a doubly-encoded id rather than decoding twice', () => {
    // `%2540omadia…` decodes once to `%40omadia…`, which is not an id.
    expect(decodePluginIdSegment('%2540omadia%252Fexample-ui')).toBeNull();
  });
});

describe('pluginUiEntryPath (#1454)', () => {
  /**
   * The one path the iframe `src` and the host page's bundle probe both build
   * from. Literal expectations on purpose: recomputing them with
   * `encodeURIComponent` here would agree with any encoding the helper chose,
   * including the broken one that 404'd every scoped plugin (#1399).
   */
  it('keeps a scoped id in one path segment', () => {
    expect(pluginUiEntryPath('@omadia/example-ui')).toBe(
      '/p/%40omadia%2Fexample-ui/ui/index.html',
    );
  });

  it('leaves an unscoped id alone', () => {
    expect(pluginUiEntryPath('some-plugin')).toBe('/p/some-plugin/ui/index.html');
  });

  it('is same-origin relative, never scheme-relative', () => {
    // `//evil.example/...` as an iframe src would leave the origin; the leading
    // single slash is load-bearing (see PluginUiFrame.test.tsx).
    expect(pluginUiEntryPath('some-plugin').startsWith('/p/')).toBe(true);
  });
});
