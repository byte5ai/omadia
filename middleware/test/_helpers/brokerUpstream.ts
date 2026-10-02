/**
 * #778 S3a — shared plumbing for the `CredentialBroker` suites that run
 * against a REAL local HTTP upstream (`credentialBrokerEgress*.test.ts`).
 *
 * Servers bind `127.0.0.1` explicitly (the listen(0) v4/v6 flake). The
 * broker always addresses `https://api.example.com`; `routeTo` rewrites that
 * to the local server and otherwise uses the real global fetch, so redirect,
 * abort, streaming and header-validation behaviour are undici's own.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { EncryptedSecretMaterial } from '@omadia/channel-sdk';

import type { BrokerFetch } from '../../src/credentials/broker.js';

export const DECLARED_ORIGIN = 'https://api.example.com';

/** A trivial, reversible "cipher": only the broker's own logic is under test. */
export function seal(plaintext: string): EncryptedSecretMaterial {
  return { iv: 'iv', tag: 'tag', ciphertext: Buffer.from(plaintext, 'utf8').toString('base64') };
}

export function unseal(material: EncryptedSecretMaterial): string {
  return Buffer.from(material.ciphertext, 'base64').toString('utf8');
}

export interface Upstream {
  readonly base: string;
  readonly port: number;
  readonly requests: IncomingMessage[];
  close(): Promise<void>;
}

const openServers: Server[] = [];

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

export async function startUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Upstream> {
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${String(port)}`, port, requests, close: () => closeServer(server) };
}

/** Close every server `startUpstream` opened. Call from `afterEach`. */
export async function closeAllUpstreams(): Promise<void> {
  await Promise.all(openServers.splice(0).map(closeServer));
}

export function routeTo(base: string): BrokerFetch {
  return (url, init) =>
    globalThis.fetch(url.replace(DECLARED_ORIGIN, base), init) as unknown as ReturnType<BrokerFetch>;
}

/** Every value the upstream received for `name`, straight from `rawHeaders`
 *  so a duplicate that `req.headers` would join stays visible. */
export function rawHeaderValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1] ?? '');
  }
  return values;
}
