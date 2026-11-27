import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDiagramLinkRenewer, signUrl, verifySig } from '@omadia/diagrams';
import { createDocumentLinkRenewer, signDocumentUrl, verifyDocumentSig } from '@omadia/plugin-office';

/**
 * #1964 (ADR-0266) — each plugin's link renewer: accepts its own signature
 * with the expiry ignored, only for its own key layout, and signs the same key
 * again with the plugin's TTL.
 */

const NOW = 1_900_000_000;
const SECRET = 'r'.repeat(32);
const OTHER_SECRET = 'o'.repeat(32);
const BASE = 'https://omadia.example';
const TTL = 3600;

function parts(url: string): { key: string; exp: number; sig: string } {
  const u = new URL(url);
  const encoded = u.pathname.split('/').slice(3).join('/');
  return { key: decodeURIComponent(encoded), exp: Number(u.searchParams.get('exp')), sig: u.searchParams.get('sig') ?? '' };
}

const cases = [
  {
    name: 'diagrams',
    key: `byte5/${'c'.repeat(64)}.png`,
    foreignLayoutKey: `documents/byte5/${'c'.repeat(64)}/a.xlsx`,
    sign: (key: string, secret: string, nowSec: number) =>
      signUrl({ key, secret, ttlSec: 60, publicBaseUrl: BASE, nowSec }),
    verify: (p: { key: string; exp: number; sig: string }) => verifySig({ ...p, secret: SECRET, nowSec: NOW }),
    renewer: createDiagramLinkRenewer({ secret: SECRET, ttlSec: TTL, publicBaseUrl: BASE, nowSec: () => NOW }),
  },
  {
    name: 'office',
    key: `documents/byte5/${'d'.repeat(64)}/Bericht.docx`,
    foreignLayoutKey: `byte5/${'d'.repeat(64)}.png`,
    sign: (key: string, secret: string, nowSec: number) =>
      signDocumentUrl({ key, secret, ttlSec: 60, publicBaseUrl: BASE, nowSec }),
    verify: (p: { key: string; exp: number; sig: string }) => verifyDocumentSig({ ...p, secret: SECRET, nowSec: NOW }),
    renewer: createDocumentLinkRenewer({ secret: SECRET, ttlSec: TTL, publicBaseUrl: BASE, nowSec: () => NOW }),
  },
];

for (const c of cases) {
  describe(`#1964 · ${c.name} link renewer`, () => {
    it('accepts its own expired link and the fresh link verifies', () => {
      const expired = parts(c.sign(c.key, SECRET, NOW - 10_000));
      assert.equal(c.verify(expired), false, 'normal verify rejects the expired link');
      assert.equal(c.renewer.verifyIgnoringExpiry(expired), true);
      const renewed = c.renewer.sign(c.key);
      assert.equal(renewed.expiresAt, NOW + TTL);
      const fresh = parts(renewed.url);
      assert.equal(fresh.key, c.key);
      assert.equal(c.verify(fresh), true);
    });

    it('refuses a link signed with another secret', () => {
      assert.equal(c.renewer.verifyIgnoringExpiry(parts(c.sign(c.key, OTHER_SECRET, NOW - 10))), false);
    });

    it('refuses a tampered exp or sig', () => {
      const link = parts(c.sign(c.key, SECRET, NOW - 10));
      assert.equal(c.renewer.verifyIgnoringExpiry({ ...link, exp: link.exp + 1 }), false);
      assert.equal(c.renewer.verifyIgnoringExpiry({ ...link, sig: '0'.repeat(64) }), false);
      assert.equal(c.renewer.verifyIgnoringExpiry({ ...link, exp: Number.NaN }), false);
    });

    it('refuses a key outside its layout even with a valid signature', () => {
      assert.equal(
        c.renewer.verifyIgnoringExpiry(parts(c.sign(c.foreignLayoutKey, SECRET, NOW - 10))),
        false,
      );
    });
  });
}
