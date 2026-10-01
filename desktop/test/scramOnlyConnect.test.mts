/**
 * The shell's connections to the embedded Postgres authenticate with
 * SCRAM-SHA-256 or not at all (`scramOnlyConnect.ts`, used by
 * `embeddedDb.ts`'s `connectShellClient`).
 *
 * What this pins: the shell used to connect with a stock pg client, which
 * answers whatever the server asks. A process holding the endpoint in place of
 * the shell's server (on Windows, another local user binding the loopback port
 * while the server is stopped) could ask for the password in cleartext and get
 * it, or let the client in without any exchange and pose as the cluster. Each
 * case below is played by a listener on 127.0.0.1 (`helpers/fakePgWire.mts`);
 * the guard must refuse before any password leaves the client, and accept only
 * a server that completes SCRAM, i.e. proves it holds the role's verifier.
 */
import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import pg from 'pg';

import { connectScramOnly, isScramRefusal } from '../src/scramOnlyConnect.ts';
import { connectShellClient } from '../src/embeddedDb.ts';
import { startFakePgWire, type FakeAuthScript, type FakePgWire } from './helpers/fakePgWire.mts';

/** Obviously synthetic; never a real credential. */
const PASSWORD = 'f'.repeat(64);

const open: FakePgWire[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

async function listener(script: FakeAuthScript): Promise<FakePgWire> {
  const fake = await startFakePgWire(script);
  open.push(fake);
  return fake;
}

function connect(fake: FakePgWire, password = PASSWORD): Promise<pg.Client> {
  return connectScramOnly({
    host: '127.0.0.1',
    port: fake.port,
    user: 'omadia',
    password,
    database: 'postgres',
    connectionTimeoutMillis: 5_000,
  });
}

function assertNoPasswordSent(fake: FakePgWire): void {
  assert.equal(fake.received().includes(Buffer.from(PASSWORD)), false, 'the password never reached the listener');
}

const refusal = (pattern: RegExp) => (err: unknown): boolean =>
  isScramRefusal(err) && pattern.test((err as Error).message);

describe('a stock pg client against a listener that asks for cleartext', () => {
  it('hands it the password (what the guard exists to prevent)', async () => {
    const fake = await listener({ kind: 'cleartext' });
    const client = new pg.Client({ host: '127.0.0.1', port: fake.port, user: 'omadia', password: PASSWORD, database: 'postgres' });
    await assert.rejects(client.connect(), (err: { code?: string }) => err.code === '28P01');
    await client.end().catch(() => {});
    assert.ok(fake.received().includes(Buffer.from(PASSWORD)), 'the fake listener collected the password');
  });
});

describe('connectScramOnly refuses before any password is sent', () => {
  it('when the server asks for the password in cleartext', async () => {
    const fake = await listener({ kind: 'cleartext' });
    await assert.rejects(connect(fake), refusal(/cleartext/));
    assert.deepEqual(fake.messageTypes().filter((type) => type === 'p'), [], 'no password message at all');
    assertNoPasswordSent(fake);
  });

  it('when the server asks for an MD5 hash', async () => {
    const fake = await listener({ kind: 'md5' });
    await assert.rejects(connect(fake), refusal(/MD5/));
    assert.deepEqual(fake.messageTypes().filter((type) => type === 'p'), []);
  });

  it('when the server offers SASL without SCRAM-SHA-256', async () => {
    const fake = await listener({ kind: 'sasl', mechanisms: ['SYNTHETIC-MECHANISM'] });
    await assert.rejects(connect(fake), refusal(/did not offer SCRAM-SHA-256/));
    assert.deepEqual(fake.messageTypes().filter((type) => type === 'p'), []);
  });

  it('when the server lets the client in without any exchange', async () => {
    // AuthenticationOk and ReadyForQuery in one packet: a stock client would
    // now run the shell's queries against whatever this is.
    const fake = await listener({ kind: 'no-auth' });
    await assert.rejects(connect(fake), refusal(/without a SCRAM exchange/));
  });

  it('when the server switches to cleartext after SCRAM began', async () => {
    const fake = await listener({ kind: 'scram', password: PASSWORD, final: 'cleartext-instead' });
    await assert.rejects(connect(fake), refusal(/cleartext/));
    // The SASL initial response and the client proof, and nothing after them.
    assert.deepEqual(fake.messageTypes(), ['p', 'p']);
    assertNoPasswordSent(fake);
  });
});

describe('connectScramOnly and a SCRAM server', () => {
  it('connects when the server completes SCRAM, i.e. proves it holds the verifier', async () => {
    const fake = await listener({ kind: 'scram', password: PASSWORD, final: 'valid-signature' });
    const client = await connect(fake);
    await client.end();
    assertNoPasswordSent(fake);
  });

  it('refuses a server whose final signature is forged', async () => {
    const fake = await listener({ kind: 'scram', password: PASSWORD, final: 'forged-signature' });
    await assert.rejects(connect(fake), /server signature does not match/);
    assertNoPasswordSent(fake);
  });

  it('refuses a server that holds a different password', async () => {
    const fake = await listener({ kind: 'scram', password: 'e'.repeat(64), final: 'valid-signature' });
    await assert.rejects(connect(fake), /server signature does not match/);
    assertNoPasswordSent(fake);
  });
});

describe("the shell's connections use the guard", () => {
  // `connectShellClient` is what every DbAuthIo connection goes through: the
  // readiness login, provisioning, verification. Built on a stock client, it
  // would hand this listener the bootstrap password.
  it('a cleartext request gets no password from connectShellClient', async () => {
    const fake = await listener({ kind: 'cleartext' });
    await assert.rejects(
      connectShellClient({ transport: 'tcp', host: '127.0.0.1', port: fake.port }, {
        user: 'omadia',
        password: PASSWORD,
        database: 'postgres',
      }),
      refusal(/cleartext/),
    );
    assertNoPasswordSent(fake);
  });

  it('a server that skips authentication is not taken for the cluster', async () => {
    const fake = await listener({ kind: 'no-auth' });
    await assert.rejects(
      connectShellClient({ transport: 'tcp', host: '127.0.0.1', port: fake.port }, {
        user: 'omadia_kernel',
        password: PASSWORD,
        database: 'omadia',
      }),
      refusal(/without a SCRAM exchange/),
    );
  });
});
