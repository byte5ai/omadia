import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Issue #439 — guards the reuse seam itself, which is the part of this change
 * that regressions are cheapest to introduce into and most expensive to
 * notice: someone re-adds a "small local helper" that hashes a key, and the
 * codebase quietly has two credential implementations again.
 *
 * Structural assertions on source text (same technique as the constant-time
 * assertion in `apiKeyToken.test.ts`), because the property being protected
 * is "where does this code live", which no runtime behaviour can express.
 */
const CHANNEL_API_SRC = fileURLToPath(
  new URL('../../packages/harness-channel-api/src/', import.meta.url),
);
const KERNEL_SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function readChannelApiSources(): { name: string; text: string }[] {
  return readdirSync(CHANNEL_API_SRC)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(CHANNEL_API_SRC + name, 'utf8') }));
}

describe('channelApi — API-key auth reuse seam (@omadia/api-key-auth)', () => {
  it('the plugin no longer carries its own copy of the credential primitives', () => {
    const files = readdirSync(CHANNEL_API_SRC);
    for (const moved of ['apiKeyToken.ts', 'apiKeyStore.ts', 'rateLimiter.ts', 'auditLog.ts']) {
      assert.equal(
        files.includes(moved),
        false,
        `${moved} must live in @omadia/api-key-auth only — one implementation, not two`,
      );
    }
  });

  it('no file in the plugin re-implements minting, hashing, or constant-time compare', () => {
    for (const { name, text } of readChannelApiSources()) {
      assert.doesNotMatch(text, /node:crypto[\s\S]{0,200}(createHash|timingSafeEqual)/, name);
      assert.doesNotMatch(text, /\bsha256Hex\s*\(/, `${name} must not hash key material itself`);
    }
  });

  it('the plugin consumes the shared package for auth, storage, and rate limiting', () => {
    const byName = new Map(readChannelApiSources().map((f) => [f.name, f.text]));
    assert.match(byName.get('plugin.ts') ?? '', /from '@omadia\/api-key-auth'/);
    assert.match(byName.get('chatRouter.ts') ?? '', /requireApiKey/);
    assert.match(byName.get('adminKeysRouter.ts') ?? '', /from '@omadia\/api-key-auth'/);

    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../packages/harness-channel-api/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { peerDependencies?: Record<string, string> };
    assert.ok(
      pkg.peerDependencies?.['@omadia/api-key-auth'],
      'the dependency must be declared, not merely resolvable via the workspace root',
    );
  });

  it('the kernel never imports a channel plugin — that direction is the layering inversion', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}${entry.name}${entry.isDirectory() ? '/' : ''}`;
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          if (/from '@omadia\/channel-api/.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    walk(KERNEL_SRC);
    assert.deepEqual(offenders, [], 'middleware/src must not import @omadia/channel-api');
  });
});
