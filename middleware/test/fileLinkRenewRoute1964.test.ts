import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import express from 'express';
import { createDiagramLinkRenewer, DIAGRAM_LINK_ROUTE_PREFIX, signUrl } from '@omadia/diagrams';
import { createDocumentLinkRenewer, DOCUMENT_LINK_ROUTE_PREFIX, signDocumentUrl } from '@omadia/plugin-office';

import { createFileLinkRenewRouter, FILE_LINK_RENEW_MAX_AGE_SEC, keyLogId } from '../src/routes/fileLinkRenew.js';
import { createFileLinkRenewalRegistry } from '../src/services/fileLinkRenewal.js';
import { invoke } from './_helpers/httpInvoke.js';

/**
 * #1964 (ADR-0266) — `POST /api/v1/files/renew` re-signs an expired Office or
 * Diagram link for a signed-in caller: valid signature with the expiry
 * ignored, original expiry at most 30 days back.
 */

const NOW = 2_000_000_000;
const SECRET = 's'.repeat(32);
const BASE = 'https://omadia.example';
const TTL = 900;
const DIAGRAM_KEY = `byte5/${'a'.repeat(64)}.png`;
const DOCUMENT_KEY = `documents/byte5/${'b'.repeat(64)}/Umsätze Q3.xlsx`;
const SESSION = { sub: 'anna@example.com', email: 'anna@example.com', omadia_user_id: 'u-anna' };

function harness(opts: { session?: boolean } = {}) {
  const registry = createFileLinkRenewalRegistry();
  registry.registerRenewer(
    DIAGRAM_LINK_ROUTE_PREFIX,
    createDiagramLinkRenewer({ secret: SECRET, ttlSec: TTL, publicBaseUrl: BASE, nowSec: () => NOW }),
  );
  registry.registerRenewer(
    DOCUMENT_LINK_ROUTE_PREFIX,
    createDocumentLinkRenewer({ secret: SECRET, ttlSec: TTL, publicBaseUrl: BASE, nowSec: () => NOW }),
  );
  const logs: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.session !== false) (req as unknown as { session: unknown }).session = SESSION;
    next();
  });
  app.use(
    '/api/v1/files',
    createFileLinkRenewRouter({ registry, nowSec: () => NOW, log: (l) => logs.push(l) }),
  );
  return { app, logs };
}

/** A link that expired `agoSec` seconds before NOW. */
function diagramLink(agoSec: number): string {
  return signUrl({ key: DIAGRAM_KEY, secret: SECRET, ttlSec: 60, publicBaseUrl: BASE, nowSec: NOW - agoSec - 60 });
}

function documentLink(agoSec: number): string {
  return signDocumentUrl({ key: DOCUMENT_KEY, secret: SECRET, ttlSec: 60, publicBaseUrl: BASE, nowSec: NOW - agoSec - 60 });
}

async function renew(app: express.Express, url: unknown) {
  const res = await invoke(app, 'POST', '/api/v1/files/renew', { json: { url } });
  return { status: res.status, body: JSON.parse(res.text) as Record<string, unknown> };
}

describe('#1964 · POST /api/v1/files/renew', () => {
  it('renews an expired diagram link for the same key with the normal TTL', async () => {
    const { app } = harness();
    const res = await renew(app, diagramLink(3600));
    assert.equal(res.status, 200);
    assert.equal(res.body['expiresAt'], NOW + TTL);
    const fresh = new URL(String(res.body['url']));
    assert.equal(fresh.origin, BASE);
    assert.equal(decodeURIComponent(fresh.pathname), `/diagrams/dl/${DIAGRAM_KEY}`);
    assert.equal(fresh.searchParams.get('exp'), String(NOW + TTL));
  });

  it('renews an expired document link, also when given as a relative path', async () => {
    const { app } = harness();
    const absolute = new URL(documentLink(86_400));
    const res = await renew(app, `${absolute.pathname}${absolute.search}`);
    assert.equal(res.status, 200);
    const fresh = new URL(String(res.body['url']));
    assert.equal(decodeURIComponent(fresh.pathname), `/documents/dl/${DOCUMENT_KEY}`);
  });

  it('renews a link that has not expired yet', async () => {
    const { app } = harness();
    const live = signUrl({ key: DIAGRAM_KEY, secret: SECRET, ttlSec: 60, publicBaseUrl: BASE, nowSec: NOW });
    assert.equal((await renew(app, live)).status, 200);
  });

  it('refuses a forged signature with 403 and logs only the key id', async () => {
    const { app, logs } = harness();
    const forged = new URL(diagramLink(10));
    forged.searchParams.set('sig', 'f'.repeat(64));
    const res = await renew(app, forged.toString());
    assert.equal(res.status, 403);
    assert.equal(res.body['code'], 'file_link.invalid_signature');
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /reason=invalid_signature route=\/diagrams\/dl/);
    assert.ok(logs[0]!.includes(`key=${keyLogId(DIAGRAM_KEY)}`));
    assert.ok(!logs[0]!.includes('f'.repeat(64)), 'no signature in the log');
    assert.ok(!logs[0]!.includes(DIAGRAM_KEY), 'no raw key in the log');
  });

  it('refuses a link whose exp was changed (signature covers exp)', async () => {
    const { app } = harness();
    const tampered = new URL(diagramLink(3600));
    tampered.searchParams.set('exp', String(NOW + 10));
    assert.equal((await renew(app, tampered.toString())).status, 403);
  });

  it('refuses a link moved to the other route (ADR-0176)', async () => {
    const { app } = harness();
    const moved = new URL(diagramLink(10));
    moved.pathname = moved.pathname.replace('/diagrams/dl/', '/documents/dl/');
    assert.equal((await renew(app, moved.toString())).status, 403);
  });

  it('refuses a link older than the maximum age with 410', async () => {
    const { app, logs } = harness();
    const res = await renew(app, documentLink(FILE_LINK_RENEW_MAX_AGE_SEC + 1));
    assert.equal(res.status, 410);
    assert.equal(res.body['code'], 'file_link.too_old');
    assert.match(logs[0]!, /reason=too_old route=\/documents\/dl key=[0-9a-f]{12} user=u-anna/);
  });

  it('still renews a link exactly at the maximum age', async () => {
    const { app } = harness();
    assert.equal((await renew(app, documentLink(FILE_LINK_RENEW_MAX_AGE_SEC))).status, 200);
  });

  it('refuses without a session with 401', async () => {
    const { app, logs } = harness({ session: false });
    const res = await renew(app, diagramLink(10));
    assert.equal(res.status, 401);
    assert.equal(res.body['code'], 'file_link.session_required');
    assert.match(logs[0]!, /reason=session_required/);
  });

  it('refuses an unknown route prefix with 404', async () => {
    const { app } = harness();
    const res = await renew(app, `${BASE}/exports/dl/x.csv?exp=1&sig=ab`);
    assert.equal(res.status, 404);
    assert.equal(res.body['code'], 'file_link.unknown_route');
  });

  it('refuses malformed bodies with 400', async () => {
    const { app } = harness();
    for (const url of [undefined, 42, '', `${BASE}/diagrams/dl/k.png`, `${BASE}/diagrams/dl/k.png?exp=abc&sig=00`, 'x'.repeat(5000)]) {
      const res = await renew(app, url);
      assert.equal(res.status, 400, String(url).slice(0, 40));
      assert.equal(res.body['code'], 'file_link.bad_request');
    }
  });
});

describe('#1964 · file link renewal registry', () => {
  const renewer = { verifyIgnoringExpiry: () => true, sign: () => ({ url: 'u', expiresAt: 1 }) };

  it('resolves the key under a registered prefix and unregisters', () => {
    const registry = createFileLinkRenewalRegistry();
    const dispose = registry.registerRenewer('/diagrams/dl', renewer);
    assert.equal(registry.resolve('/diagrams/dl/a%2Fb.png')?.encodedKey, 'a%2Fb.png');
    assert.equal(registry.resolve('/diagrams/dl/'), undefined);
    assert.equal(registry.resolve('/diagrams/dlx/a.png'), undefined);
    // a public_base_url with a path prefix (review finding)
    assert.equal(registry.resolve('/omadia/diagrams/dl/a.png')?.encodedKey, 'a.png');
    dispose();
    assert.equal(registry.resolve('/diagrams/dl/a.png'), undefined);
  });

  it('refuses a second renewer and an invalid prefix', () => {
    const registry = createFileLinkRenewalRegistry();
    registry.registerRenewer('/diagrams/dl', renewer);
    assert.throws(() => registry.registerRenewer('/diagrams/dl', renewer), /already registered/);
    assert.throws(() => registry.registerRenewer('diagrams/dl/', renewer), /invalid route prefix/);
  });
});
