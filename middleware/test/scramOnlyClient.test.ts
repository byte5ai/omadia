/**
 * The kernel's pools authenticate with SCRAM-SHA-256 or not at all when the
 * process requires it (`OMADIA_DB_REQUIRE_SCRAM=1`, set by the desktop shell
 * for the kernel it spawns): `scramOnlyClient.ts` in the graph package, used by
 * `createNeonPool` and by core's migration pool.
 *
 * What this pins: on Windows the desktop's embedded Postgres listens on
 * loopback TCP. If it stops while the kernel runs, another local user's
 * process can take the port, and a stock pg client answers whatever that
 * listener asks: the kernel password in cleartext or as an MD5 hash, or a
 * session with no authentication at all, into which the kernel would send its
 * queries. Each case below is played by a listener on 127.0.0.1 TCP
 * (`_helpers/fakePgWire.ts`), so the Windows transport runs on every OS. The
 * pool must fail with a clear error before any password or query leaves it,
 * and still connect to a server that completes SCRAM.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import pg from 'pg';

import {
  DB_REQUIRE_SCRAM_ENV,
  ScramOnlyClient,
  createNeonPool,
  isScramRefusal,
  isScramRequired,
  scramOnlyPoolOptions,
} from '@omadia/knowledge-graph-neon';

import { runCoreMigrations } from '../src/platform/coreMigrations.js';
import { startFakePgWire, type FakeAuthScript, type FakePgWire } from './_helpers/fakePgWire.js';

/** Obviously synthetic; never a real credential. */
const PASSWORD = 'f'.repeat(64);
const REQUIRED = { [DB_REQUIRE_SCRAM_ENV]: '1' };

const open: FakePgWire[] = [];
const pools: pg.Pool[] = [];
afterEach(async () => {
  while (pools.length > 0) await pools.pop()?.end().catch(() => {});
  while (open.length > 0) await open.pop()?.close();
});

async function listener(script: FakeAuthScript): Promise<FakePgWire> {
  const fake = await startFakePgWire(script);
  open.push(fake);
  return fake;
}

function dsn(fake: FakePgWire, password = PASSWORD): string {
  return `postgresql://omadia_kernel:${password}@127.0.0.1:${String(fake.port)}/omadia`;
}

/** A pool the way the kernel builds one, with the desktop's requirement switched on. */
function kernelPool(fake: FakePgWire, password = PASSWORD): pg.Pool {
  const pool = new pg.Pool({
    connectionString: dsn(fake, password),
    max: 1,
    connectionTimeoutMillis: 5_000,
    ...scramOnlyPoolOptions(REQUIRED),
  });
  pools.push(pool);
  return pool;
}

function assertNoPasswordSent(fake: FakePgWire): void {
  assert.equal(fake.received().includes(Buffer.from(PASSWORD)), false, 'the password never reached the listener');
}

function assertNoPasswordMessage(fake: FakePgWire): void {
  assert.deepEqual(fake.messageTypes().filter((type) => type === 'p'), [], 'no password message at all');
}

function assertNoQuery(fake: FakePgWire): void {
  assert.deepEqual(fake.messageTypes().filter((type) => type === 'Q' || type === 'P'), [], 'no query reached the listener');
}

const refusal = (pattern: RegExp) => (err: unknown): boolean =>
  isScramRefusal(err) && pattern.test((err as Error).message);

/** Run `fn` with the process requiring SCRAM, the way the desktop starts the kernel. */
async function withScramRequired<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env[DB_REQUIRE_SCRAM_ENV];
  process.env[DB_REQUIRE_SCRAM_ENV] = '1';
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[DB_REQUIRE_SCRAM_ENV];
    else process.env[DB_REQUIRE_SCRAM_ENV] = before;
  }
}

describe('the requirement is off unless the process asks for it', () => {
  it('leaves pg its own client without the variable, so server deployments are unchanged', () => {
    assert.equal(isScramRequired({}), false);
    assert.deepEqual(scramOnlyPoolOptions({}), {});
    assert.equal(isScramRequired({ [DB_REQUIRE_SCRAM_ENV]: '0' }), false);
    assert.equal(isScramRequired({ [DB_REQUIRE_SCRAM_ENV]: 'true' }), true);
    assert.deepEqual(scramOnlyPoolOptions(REQUIRED), { Client: ScramOnlyClient });
  });

  it('a stock pool against a listener that asks for cleartext hands it the password (what the requirement prevents)', async () => {
    const fake = await listener({ kind: 'cleartext' });
    const pool = new pg.Pool({ connectionString: dsn(fake), max: 1, ...scramOnlyPoolOptions({}) });
    pools.push(pool);
    await assert.rejects(pool.query('SELECT 1'), (err: { code?: string }) => err.code === '28P01');
    assert.ok(fake.received().includes(Buffer.from(PASSWORD)), 'the fake listener collected the password');
  });
});

describe('a kernel pool that requires SCRAM refuses before any password or query is sent', () => {
  it('when the server asks for the password in cleartext', async () => {
    const fake = await listener({ kind: 'cleartext' });
    await assert.rejects(kernelPool(fake).query('SELECT 1'), refusal(/cleartext/));
    assertNoPasswordMessage(fake);
    assertNoPasswordSent(fake);
    assertNoQuery(fake);
  });

  it('when the server asks for an MD5 hash', async () => {
    const fake = await listener({ kind: 'md5' });
    await assert.rejects(kernelPool(fake).query('SELECT 1'), refusal(/MD5/));
    assertNoPasswordMessage(fake);
    assertNoQuery(fake);
  });

  it('when the server lets the connection in without any exchange (trust)', async () => {
    // AuthenticationOk and ReadyForQuery in one packet: a stock client would
    // now run the kernel's queries against whatever this is.
    const fake = await listener({ kind: 'no-auth' });
    await assert.rejects(kernelPool(fake).query('SELECT 1'), refusal(/without a SCRAM exchange/));
    assertNoPasswordMessage(fake);
    assertNoQuery(fake);
  });

  it('when the server offers SASL without SCRAM-SHA-256', async () => {
    const fake = await listener({ kind: 'sasl', mechanisms: ['SYNTHETIC-MECHANISM'] });
    await assert.rejects(kernelPool(fake).query('SELECT 1'), refusal(/did not offer SCRAM-SHA-256/));
    assertNoPasswordMessage(fake);
  });

  it('when the server switches to cleartext after SCRAM began', async () => {
    const fake = await listener({ kind: 'scram', password: PASSWORD, final: 'cleartext-instead' });
    await assert.rejects(kernelPool(fake).query('SELECT 1'), refusal(/cleartext/));
    // The SASL initial response and the client proof, and nothing after them.
    assert.deepEqual(fake.messageTypes(), ['p', 'p']);
    assertNoPasswordSent(fake);
  });

  it('a pool that was refused stays usable for the next connection attempt', async () => {
    const fake = await listener({ kind: 'cleartext' });
    const pool = kernelPool(fake);
    await assert.rejects(pool.query('SELECT 1'), refusal(/cleartext/));
    await assert.rejects(pool.query('SELECT 1'), refusal(/cleartext/));
    assertNoPasswordSent(fake);
  });

  it('a client connected directly is refused the same way', async () => {
    const fake = await listener({ kind: 'cleartext' });
    const client = new ScramOnlyClient({ connectionString: dsn(fake), connectionTimeoutMillis: 5_000 });
    await assert.rejects(client.connect(), refusal(/cleartext/));
    await client.end().catch(() => {});
    assertNoPasswordSent(fake);
  });
});

describe('a kernel pool that requires SCRAM and a SCRAM server', () => {
  it('connects when the server completes SCRAM, i.e. proves it holds the verifier', async () => {
    const fake = await listener({ kind: 'scram', password: PASSWORD, final: 'valid-signature' });
    const client = await kernelPool(fake).connect();
    client.release();
    assertNoPasswordSent(fake);
  });

  it('refuses a server whose final signature is forged', async () => {
    const fake = await listener({ kind: 'scram', password: PASSWORD, final: 'forged-signature' });
    await assert.rejects(kernelPool(fake).connect(), /server signature does not match/);
    assertNoPasswordSent(fake);
  });
});

describe("the kernel's pools take the requirement from the environment", () => {
  it('createNeonPool (the graph pool every plugin borrows) refuses a cleartext request', async () => {
    const fake = await listener({ kind: 'cleartext' });
    await withScramRequired(async () => {
      const pool = createNeonPool(dsn(fake), 1);
      pools.push(pool);
      await assert.rejects(pool.query('SELECT 1'), refusal(/cleartext/));
    });
    assertNoPasswordSent(fake);
  });

  it("core's migration pool refuses a server that skips authentication", async () => {
    const fake = await listener({ kind: 'no-auth' });
    await withScramRequired(async () => {
      await assert.rejects(
        runCoreMigrations({
          databaseUrl: dsn(fake),
          runMigrations: async (pool) => {
            await pool.query('SELECT 1');
          },
        }),
        refusal(/without a SCRAM exchange/),
      );
    });
    assertNoQuery(fake);
  });
});
