/**
 * The kernel the desktop spawns must not advertise over mDNS (OM-70 / #1004).
 *
 * `desktopKernelEnvDefaults` is tested on its own; this pins the WIRING, i.e.
 * that `Supervisor.kernelEnv()` actually spreads those defaults into the env
 * handed to `spawn`. Dropping the spread leaves the pure helper green and this
 * red. Reaching into the private method follows `supervisorRestartRace.test`:
 * a boot to the real `spawn` needs port 8769 free and a health endpoint, which
 * a unit test cannot promise.
 */
import { describe, it, afterEach, before, type TestContext } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Supervisor } from '../src/supervisor.ts';
import type { EmbeddedDb } from '../src/embeddedDb.ts';
import { kernelDatabaseUrl } from '../src/embeddedDbAuth.ts';
import { embeddedDbCredentials } from '../src/secrets.ts';
import type { DesktopCapabilities } from '../src/capabilities.ts';
import { onLog, type LogLevel } from '../src/log.ts';
import { attachmentsDir, dataRoot, setupFile } from '../src/paths.ts';
import { readSetup, writeSetup } from '../src/setupState.ts';

before(() => {
  // `paths.ts` is compiled to CommonJS for the app and reads `__dirname` to
  // find the repo root in dev mode. Under the ESM test loader that global does
  // not exist, so give it the same answer the compiled `dist/` would have.
  (globalThis as { __dirname?: string }).__dirname = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
  );
});

type WithKernelEnv = {
  kernelEnv(port: number, uiPort: number): NodeJS.ProcessEnv;
};

/** The web-ui port is allocated per launch; any value proves the wiring. */
const UI_PORT = 51_234;

function kernelEnv(uiPort = UI_PORT): NodeJS.ProcessEnv {
  return (new Supervisor() as unknown as WithKernelEnv).kernelEnv(8769, uiPort);
}

const saved = process.env['OMADIA_UI_MDNS_ENABLED'];
afterEach(() => {
  if (saved === undefined) delete process.env['OMADIA_UI_MDNS_ENABLED'];
  else process.env['OMADIA_UI_MDNS_ENABLED'] = saved;
});

describe('Supervisor.kernelEnv mDNS wiring (OM-70)', () => {
  it('hands the kernel OMADIA_UI_MDNS_ENABLED=false by default', () => {
    delete process.env['OMADIA_UI_MDNS_ENABLED'];
    const env = kernelEnv();
    assert.equal(env['OMADIA_UI_MDNS_ENABLED'], 'false');
    // Sanity: this is the real kernel env, not a partial object.
    assert.equal(env['PORT'], '8769');
    assert.equal(env['HOST'], '127.0.0.1');
  });

  it("keeps the user's explicit opt-in", () => {
    process.env['OMADIA_UI_MDNS_ENABLED'] = 'true';
    assert.equal(kernelEnv()['OMADIA_UI_MDNS_ENABLED'], 'true');
  });
});

/**
 * The first-user setup wizard needs an operator setup token on every kernel
 * except the desktop app's own: the kernel skips the token only when it sees
 * the supervisor's explicit flag AND a loopback bind. Losing either half here
 * would put a token prompt in front of every fresh desktop install — or, for
 * the bind, expose the wizard on the LAN.
 */
describe('Supervisor.kernelEnv first-user setup exemption', () => {
  it('marks the kernel as the desktop kernel, bound to loopback', () => {
    const env = kernelEnv();
    assert.equal(env['OMADIA_DESKTOP_EMBEDDED'], 'true');
    assert.equal(env['HOST'], '127.0.0.1');
  });

  it('is not overridden by an inherited value', () => {
    const saved = process.env['OMADIA_DESKTOP_EMBEDDED'];
    process.env['OMADIA_DESKTOP_EMBEDDED'] = 'false';
    try {
      assert.equal(kernelEnv()['OMADIA_DESKTOP_EMBEDDED'], 'true');
    } finally {
      if (saved === undefined) delete process.env['OMADIA_DESKTOP_EMBEDDED'];
      else process.env['OMADIA_DESKTOP_EMBEDDED'] = saved;
    }
  });
});

/**
 * OM-90 — `/api/v1/auth/login` redirected to `http://localhost:3979/login`,
 * the kernel config's default `PUBLIC_BASE_URL`. Nothing in the desktop app
 * listens on 3979: the kernel binds 8769 and the web-ui gets a fresh port on
 * every launch, so the login redirect landed on a dead port.
 */
describe('Supervisor.kernelEnv login-redirect base (OM-90)', () => {
  it('points PUBLIC_BASE_URL at the web-ui port, not the kernel port', () => {
    const env = kernelEnv();
    assert.equal(env['PUBLIC_BASE_URL'], `http://127.0.0.1:${UI_PORT}`);
    // The distinction is the whole point: a redirect to the kernel's own port
    // reaches a live server that serves no login page.
    assert.notEqual(env['PUBLIC_BASE_URL'], env['DIAGRAM_PUBLIC_BASE_URL']);
    assert.equal(env['DIAGRAM_PUBLIC_BASE_URL'], 'http://127.0.0.1:8769');
  });

  it('never leaves the kernel on its 3979 default', () => {
    assert.ok(!kernelEnv()['PUBLIC_BASE_URL']?.includes('3979'));
  });

  it('keeps the Entra OAuth callback on the kernel', () => {
    // `PUBLIC_BASE_URL` has a second reader: the kernel derives the callback
    // from it. `/api/v1/*` is NOT proxied by the web-ui, so without this
    // override the fix above would trade a dead login redirect for a dead
    // OAuth callback.
    assert.equal(
      kernelEnv()['AUTH_REDIRECT_URI'],
      'http://127.0.0.1:8769/api/v1/auth/login/entra/cb',
    );
  });

  it('keeps the MCP OAuth callback on a route that exists', () => {
    // The third reader of `PUBLIC_BASE_URL`. Its default derives
    // `{base}/api/v1/operator/mcp-oauth/callback`, which now points at the UI
    // port — and the web-ui proxies `/bot-api/*`, never `/api/v1/*`, so the
    // undecorated default 404s and MCP OAuth dies on its last hop. Unlike the
    // Entra callback this one belongs on the UI origin; it just needs the
    // prefix the rewrite actually forwards.
    assert.equal(
      kernelEnv()['MCP_OAUTH_REDIRECT_URI'],
      `http://127.0.0.1:${UI_PORT}/bot-api/v1/operator/mcp-oauth/callback`,
    );
  });

  it('sends the MCP callback to the UI, and Entra to the kernel', () => {
    // The two callbacks resolve to DIFFERENT origins on purpose; collapsing
    // them onto one host breaks whichever one loses.
    const env = kernelEnv();
    assert.ok(env['MCP_OAUTH_REDIRECT_URI']?.includes(`:${UI_PORT}`));
    assert.ok(env['AUTH_REDIRECT_URI']?.includes(':8769'));
  });

  it('follows the port it is given, launch to launch', () => {
    assert.equal(kernelEnv(40_001)['PUBLIC_BASE_URL'], 'http://127.0.0.1:40001');
    assert.equal(kernelEnv(40_002)['PUBLIC_BASE_URL'], 'http://127.0.0.1:40002');
    // The MCP callback is per-launch too — a stale port here is the same bug.
    assert.equal(
      kernelEnv(40_001)['MCP_OAUTH_REDIRECT_URI'],
      'http://127.0.0.1:40001/bot-api/v1/operator/mcp-oauth/callback',
    );
  });

  it('wins over a stale inherited PUBLIC_BASE_URL', () => {
    // `...process.env` is spread first; a value left over from a previous run
    // or a user shell must not survive into this launch.
    const saved = process.env['PUBLIC_BASE_URL'];
    process.env['PUBLIC_BASE_URL'] = 'http://localhost:3979';
    try {
      assert.equal(kernelEnv()['PUBLIC_BASE_URL'], `http://127.0.0.1:${UI_PORT}`);
    } finally {
      if (saved === undefined) delete process.env['PUBLIC_BASE_URL'];
      else process.env['PUBLIC_BASE_URL'] = saved;
    }
  });
});

/**
 * The embedded Postgres has two roles: the bootstrap superuser, whose password
 * never leaves the shell, and the restricted `omadia_kernel` the kernel runs
 * as. The kernel's environment carries the second and never the first.
 */
describe('Supervisor.kernelEnv database credentials', () => {
  it('hands the kernel the restricted role and never the bootstrap password', () => {
    const creds = embeddedDbCredentials();
    const supervisor = new Supervisor();
    const db: EmbeddedDb = {
      // On macOS/Linux the host is the server's private socket directory.
      databaseUrl: kernelDatabaseUrl({ host: '/synthetic/omadia/pg-socket', port: 54_321 }, creds.kernelPassword),
      port: 54_321,
      stop: async () => true,
    };
    (supervisor as unknown as { db: EmbeddedDb | null }).db = db;
    const env = (supervisor as unknown as WithKernelEnv).kernelEnv(8769, UI_PORT);

    assert.equal(env['DATABASE_URL'], db.databaseUrl);
    assert.equal(new URL(env['DATABASE_URL'] ?? '').username, 'omadia_kernel');
    for (const [name, value] of Object.entries(env)) {
      assert.ok(!value?.includes(creds.superuserPassword), `${name} must not carry the bootstrap password`);
    }
  });
});

/**
 * The setup wizard's "Attachments" switch used to be stored in setup.json and
 * never read: `kernelEnv()` handed the kernel the same env whatever the user
 * picked. The switch now decides `ATTACHMENT_STORE_DIR`, which the kernel turns
 * into a local attachment store (`middleware/src/platform/attachmentStore.ts`).
 * These pin that the choice changes what the kernel is actually started with.
 */
function kernelEnvWith(capabilities: DesktopCapabilities): NodeJS.ProcessEnv {
  const sup = new Supervisor({ capabilities: () => capabilities });
  return (sup as unknown as WithKernelEnv).kernelEnv(8769, UI_PORT);
}

describe('Supervisor.kernelEnv — the attachments switch reaches the kernel', () => {
  const savedDir = process.env['ATTACHMENT_STORE_DIR'];
  afterEach(() => {
    if (savedDir === undefined) delete process.env['ATTACHMENT_STORE_DIR'];
    else process.env['ATTACHMENT_STORE_DIR'] = savedDir;
    fs.rmSync(setupFile(), { force: true });
  });

  it('points ATTACHMENT_STORE_DIR into the data folder when the switch is on', () => {
    const dir = kernelEnvWith({ attachments: true })['ATTACHMENT_STORE_DIR'];
    assert.equal(dir, attachmentsDir());
    assert.equal(dir, path.join(dataRoot(), 'attachments'));
  });

  it('leaves it unset when the switch is off', () => {
    assert.equal('ATTACHMENT_STORE_DIR' in kernelEnvWith({ attachments: false }), false);
  });

  it('lets the switch decide, not a value inherited from the launch environment', () => {
    process.env['ATTACHMENT_STORE_DIR'] = '/somewhere/inherited';
    assert.equal('ATTACHMENT_STORE_DIR' in kernelEnvWith({ attachments: false }), false);
    assert.equal(kernelEnvWith({ attachments: true })['ATTACHMENT_STORE_DIR'], attachmentsDir());
  });

  it('reads the switch the wizard saved in setup.json when none is injected', () => {
    writeSetup({ ...readSetup(), capabilities: { attachments: false } });
    assert.equal('ATTACHMENT_STORE_DIR' in kernelEnv(), false);
    writeSetup({ ...readSetup(), capabilities: { attachments: true } });
    assert.equal(kernelEnv()['ATTACHMENT_STORE_DIR'], attachmentsDir());
  });
});

describe('the kernel reads what the switch sets', () => {
  // The two halves are pinned in their own packages; these keep the names they
  // share from drifting apart without either side noticing.
  const middleware = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'middleware', 'src');

  it('parses ATTACHMENT_STORE_DIR in its config schema', () => {
    const config = fs.readFileSync(path.join(middleware, 'config.ts'), 'utf8');
    assert.match(config, /^\s*ATTACHMENT_STORE_DIR: /m);
  });

  it('reports the store on /health under attachments', () => {
    const index = fs.readFileSync(path.join(middleware, 'index.ts'), 'utf8');
    assert.match(index, /attachments: attachmentStoreHealth\(/);
  });
});

type WithReadiness = {
  confirmCapabilities(port: number, requested: DesktopCapabilities): Promise<void>;
};

interface LogLine {
  readonly level: LogLevel;
  readonly msg: string;
}

function captureLog(t: TestContext): LogLine[] {
  const lines: LogLine[] = [];
  const off = onLog((level, msg) => lines.push({ level, msg }));
  t.after(off);
  return lines;
}

function healthAnswers(t: TestContext, body: unknown): string[] {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL): Promise<Response> => {
    urls.push(String(input));
    return Response.json(body);
  });
  return urls;
}

async function confirm(requested: DesktopCapabilities): Promise<void> {
  const sup = new Supervisor({ capabilities: () => requested });
  await (sup as unknown as WithReadiness).confirmCapabilities(8769, requested);
}

const readinessLines = (lines: LogLine[]): LogLine[] => lines.filter((l) => /attachments/i.test(l.msg));

describe('Supervisor.confirmCapabilities — the boot checks that the switch took', () => {
  it('asks the kernel it started, and logs a local store as ready', async (t) => {
    const urls = healthAnswers(t, { status: 'ok', attachments: { store: 'filesystem' } });
    const lines = captureLog(t);
    await confirm({ attachments: true });
    assert.deepEqual(urls, ['http://127.0.0.1:8769/health']);
    const found = readinessLines(lines);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.level, 'INFO');
  });

  it('warns when the switch is on and the kernel reports no attachment store', async (t) => {
    healthAnswers(t, { status: 'ok', attachments: { store: 'none' } });
    const lines = captureLog(t);
    await confirm({ attachments: true });
    const found = readinessLines(lines);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.level, 'WARN');
  });

  it('warns, and does not fail the boot, when /health cannot be read', async (t) => {
    t.mock.method(globalThis, 'fetch', async (): Promise<Response> => {
      throw new Error('connect ECONNREFUSED');
    });
    const lines = captureLog(t);
    await confirm({ attachments: true });
    assert.equal(readinessLines(lines)[0]?.level, 'WARN');
  });

  it('warns when the switch is off but the kernel stores attachments locally anyway', async (t) => {
    healthAnswers(t, { status: 'ok', attachments: { store: 'filesystem' } });
    const lines = captureLog(t);
    await confirm({ attachments: false });
    assert.equal(readinessLines(lines)[0]?.level, 'WARN');
  });
});

describe('Supervisor boot — the readiness check is on the boot path', () => {
  // bootOnce needs a free port 8769 and an embedded Postgres, which a unit test
  // cannot promise (see supervisorRestartRace.test). Its source is checked
  // instead: the switches are read once, handed to the kernel, and checked
  // after the kernel answers /health, before the web UI starts.
  const source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'supervisor.ts'),
    'utf8',
  );
  // Line comments stripped, so a call that was commented out does not count.
  const boot = (/private async bootOnce\([\s\S]*?\n {2}\}\n/.exec(source)?.[0] ?? '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  it('starts the kernel with the switches it then confirms', () => {
    assert.ok(boot, 'supervisor.ts must define bootOnce');
    assert.match(boot, /const capabilities = this\.readCapabilities\(\);/);
    assert.match(boot, /this\.kernelEnv\(kernelPort, uiPort, capabilities\)/);
  });

  it('confirms them after the kernel is healthy and before the web UI starts', () => {
    const waited = boot.indexOf('await this.waitForKernel(');
    const confirmed = boot.indexOf('await this.confirmCapabilities(kernelPort, capabilities);');
    const uiStarted = boot.indexOf("this.progress('starting-ui'");
    assert.ok(waited >= 0 && confirmed > waited && uiStarted > confirmed, 'order: kernel healthy → confirm → web UI');
  });
});
