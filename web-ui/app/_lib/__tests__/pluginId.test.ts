import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isValidPluginId,
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_PATTERN,
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

  it('imports isValidPluginId', () => {
    expect(readFileSync(PAGE, 'utf-8')).toContain(
      "import { isValidPluginId } from '@/app/_lib/pluginId'",
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

  it('accepts the id the host route receives after Next has decoded the segment', () => {
    // `plugin.ts` percent-encodes the id so `@omadia/example-ui` survives as
    // ONE path segment; Next hands the route the decoded value. Both forms are
    // asserted so a future change to either side of that round-trip is visible.
    const encoded = encodeURIComponent('@omadia/example-ui');
    expect(encoded).toBe('%40omadia%2Fexample-ui');
    expect(isValidPluginId(decodeURIComponent(encoded))).toBe(true);
    // The still-encoded form must NOT pass: it would mean the decode never
    // happened, and the id would not resolve to a package.
    expect(isValidPluginId(encoded)).toBe(false);
  });
});
