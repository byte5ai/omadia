// OM-15 (#602) — the store card's installation-effort block, parsed from the
// manifest's `listing.setup_profile`. Structured (audience · minutes ·
// requirement) so the platform composes a LOCALIZED line rather than the plugin
// baking German into the manifest. Lenient: malformed parts are dropped, never
// thrown, so a bad listing degrades to "no prerequisites row".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adaptManifestV1, parseSetupProfile } from '../src/plugins/manifestLoader.js';

function manifestWithListing(listing: unknown): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: 'de.byte5.integration.test',
      kind: 'integration',
      domain: 'test',
      name: 'Test Plugin',
      version: '1.0.0',
    },
    listing,
  };
}

test('a full setup_profile lands on Plugin.setup_profile', () => {
  const plugin = adaptManifestV1(
    manifestWithListing({
      setup_profile: {
        audience: 'it_admin',
        estimated_minutes: 15,
        requirement: {
          en: 'Google Workspace super-admin required',
          de: 'Google-Workspace-Super-Admin erforderlich',
        },
      },
    }),
  )!;
  assert.deepEqual(plugin.setup_profile, {
    audience: 'it_admin',
    estimated_minutes: 15,
    requirement: {
      en: 'Google Workspace super-admin required',
      de: 'Google-Workspace-Super-Admin erforderlich',
    },
  });
});

test('an unknown audience is dropped, not rendered raw', () => {
  const p = parseSetupProfile({ audience: 'wizard', estimated_minutes: 5 });
  assert.equal(p?.audience, undefined);
  assert.equal(p?.estimated_minutes, 5);
});

test('a non-positive / non-integer estimated_minutes is dropped', () => {
  assert.equal(parseSetupProfile({ estimated_minutes: 0 }), undefined);
  assert.equal(parseSetupProfile({ estimated_minutes: -3 }), undefined);
  assert.equal(parseSetupProfile({ estimated_minutes: 2.5 }), undefined);
  assert.equal(parseSetupProfile({ estimated_minutes: '15' }), undefined);
});

test('a bare-string requirement is read as English', () => {
  assert.deepEqual(parseSetupProfile({ requirement: 'super-admin' })?.requirement, {
    en: 'super-admin',
  });
});

test('an empty / malformed profile yields undefined (no card row)', () => {
  assert.equal(parseSetupProfile({}), undefined);
  assert.equal(parseSetupProfile({ audience: 'nope', estimated_minutes: 0 }), undefined);
  assert.equal(parseSetupProfile(null), undefined);
  assert.equal(parseSetupProfile('nonsense'), undefined);
  // A manifest without a `listing` block simply has no profile.
  assert.equal(adaptManifestV1(manifestWithListing(undefined))!.setup_profile, undefined);
});
