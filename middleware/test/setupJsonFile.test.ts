/**
 * Issue #603 (OM-17) — server-side extraction for `json_file` setup fields.
 *
 * The near-miss this closes: a tester typed their real Google account password
 * into `gw_sa_private_key`, because the form asked them to hand-transcribe two
 * values out of a service-account key file into an email field and a masked
 * field stacked beneath it — the visual pattern of a login. #599 made that
 * mistake detectable; uploading the file removes the opportunity to make it.
 *
 * The guarantees under test are the ones an upload path has to earn, because it
 * turns operator-supplied bytes into vault contents:
 *   - the size cap is applied to the RAW text, before `JSON.parse` runs;
 *   - `expect` rejects the wrong file BEFORE any value is extracted;
 *   - a missing path is a readable error, never a silently empty secret;
 *   - prototype properties are not reachable through an extract path;
 *   - the raw document never appears in a success result.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  JSON_FILE_MAX_BYTES,
  JSON_FILE_MAX_EXTRACTS,
  extractFromJsonFile,
  type JsonFileFieldSpec,
} from '../src/plugins/setupJsonFile.js';

const EMAIL = 'svc@proj.iam.gserviceaccount.com';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n';

const SPEC: JsonFileFieldSpec = {
  key: 'gw_sa_key',
  extracts: {
    gw_sa_client_email: '$.client_email',
    gw_sa_private_key: '$.private_key',
  },
  expect: { type: 'service_account' },
};

function serviceAccount(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'proj',
    client_email: EMAIL,
    private_key: KEY,
    ...over,
  });
}

describe('#603 — extracting a service-account key', () => {
  it('MUTATION CHECK: explodes the upload into exactly the declared keys', () => {
    const out = extractFromJsonFile(serviceAccount(), SPEC);
    assert.ok(out.ok, out.ok ? '' : out.failure.message);
    assert.deepEqual(out.values, {
      gw_sa_client_email: EMAIL,
      gw_sa_private_key: KEY,
    });
  });

  it('MUTATION CHECK: the raw document never rides along in the result', () => {
    // The file must not become state. A result that carried the parsed document
    // (or the raw text) would put project_id and anything else in the file one
    // careless `Object.assign` away from the vault.
    const out = extractFromJsonFile(serviceAccount(), SPEC);
    assert.ok(out.ok);
    assert.deepEqual(Object.keys(out.values).sort(), [
      'gw_sa_client_email',
      'gw_sa_private_key',
    ]);
    assert.equal(JSON.stringify(out).includes('project_id'), false);
  });

  it('supports a nested path', () => {
    const spec: JsonFileFieldSpec = { key: 'f', extracts: { token: '$.a.b.c' } };
    const out = extractFromJsonFile(JSON.stringify({ a: { b: { c: 'deep' } } }), spec);
    assert.ok(out.ok);
    assert.equal(out.values['token'], 'deep');
  });
});

describe('#603 — the wrong file is refused before anything is extracted', () => {
  it('MUTATION CHECK: expect rejects an OAuth client secret', () => {
    // The realistic confusion: an OAuth client-secret JSON and a service-account
    // key look alike at a glance. `expect` is what tells them apart.
    const out = extractFromJsonFile(
      JSON.stringify({ type: 'authorized_user', client_email: EMAIL, private_key: KEY }),
      SPEC,
    );
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure.code, 'unexpected_document');
    assert.match(
      out.ok === false ? out.failure.message : '',
      /type/,
      'the message must name the field that disagreed',
    );
  });

  it('MUTATION CHECK: a missing key is a readable error, not an empty secret', () => {
    // The one outcome this must never produce: a "successful" setup that stored
    // nothing, failing later and far from the cause.
    const out = extractFromJsonFile(serviceAccount({ private_key: undefined }), SPEC);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure.code, 'missing_value');
    assert.match(out.ok === false ? out.failure.message : '', /gw_sa_private_key/);
  });

  it('MUTATION CHECK: an empty string is a missing value, not a stored secret', () => {
    const out = extractFromJsonFile(serviceAccount({ private_key: '' }), SPEC);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure.code, 'missing_value');
  });

  it('refuses a non-string value rather than coercing it', () => {
    const out = extractFromJsonFile(serviceAccount({ private_key: 42 }), SPEC);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure.code, 'missing_value');
  });
});

describe('#603 — guard rails on the upload itself', () => {
  it('MUTATION CHECK: the size cap is applied before parsing', () => {
    // Checked on the RAW text so a hostile upload never reaches `JSON.parse`.
    // Built as valid JSON on purpose: if the cap ran after parsing, this would
    // succeed and the test would be asserting nothing.
    const huge = JSON.stringify({
      type: 'service_account',
      client_email: EMAIL,
      private_key: 'x'.repeat(JSON_FILE_MAX_BYTES),
    });
    assert.ok(huge.length > JSON_FILE_MAX_BYTES, 'fixture is not actually oversized');
    const out = extractFromJsonFile(huge, SPEC);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure.code, 'too_large');
  });

  it('MUTATION CHECK: non-JSON and non-object payloads are refused', () => {
    for (const [raw, code] of [
      ['not json at all', 'not_json'],
      ['[1,2,3]', 'not_an_object'],
      ['"a string"', 'not_an_object'],
      ['null', 'not_an_object'],
    ] as const) {
      const out = extractFromJsonFile(raw, SPEC);
      assert.equal(out.ok, false, `unexpectedly accepted: ${raw}`);
      assert.equal(out.ok === false && out.failure.code, code, `wrong code for ${raw}`);
    }
  });

  it('MUTATION CHECK: an extract path cannot reach a prototype property', () => {
    // Without an own-property check `$.constructor` resolves through the
    // prototype chain, and a manifest could extract a function into a secret.
    const spec: JsonFileFieldSpec = { key: 'f', extracts: { x: '$.constructor' } };
    const out = extractFromJsonFile(JSON.stringify({ a: 1 }), spec);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.failure.code, 'missing_value');
  });

  it('MUTATION CHECK: an unsupported path syntax fails loudly', () => {
    // Not JSONPath — see the module doc for why the grammar is a subset. A
    // manifest asking for more must fail rather than silently match nothing.
    for (const path of ['$..private_key', '$.a[0]', 'private_key', '$', '$.']) {
      const out = extractFromJsonFile(serviceAccount(), {
        key: 'f',
        extracts: { x: path },
      });
      assert.equal(out.ok, false, `unexpectedly accepted path: ${path}`);
      assert.equal(
        out.ok === false && out.failure.code,
        'bad_extract_path',
        `wrong code for ${path}`,
      );
    }
  });

  it('refuses a spec with no extracts, and one with too many', () => {
    const none = extractFromJsonFile(serviceAccount(), { key: 'f', extracts: {} });
    assert.equal(none.ok, false);
    assert.equal(none.ok === false && none.failure.code, 'invalid_spec');

    const many: Record<string, string> = {};
    for (let i = 0; i <= JSON_FILE_MAX_EXTRACTS; i += 1) many[`k${String(i)}`] = '$.a';
    const tooMany = extractFromJsonFile(serviceAccount(), { key: 'f', extracts: many });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.ok === false && tooMany.failure.code, 'invalid_spec');
  });
});
