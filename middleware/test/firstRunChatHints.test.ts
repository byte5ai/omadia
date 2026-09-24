/**
 * Issue #1090 / defect 2 — the "chat is off" hints must name a path that
 * still exists.
 *
 * Both the boot warning and the 503 body told the operator to set
 * ANTHROPIC_API_KEY "via the Setup Wizard". The wizard stopped collecting a
 * key in S4 (provider v2) — it creates the first admin account and nothing
 * else — so the one instruction shown on the only two surfaces an operator
 * sees when chat is dead pointed at a field that is not there. The supported
 * path is the LLM access page (/admin/providers). middleware/.env is not one:
 * the env key is seeded only on the boot that first registers the
 * orchestrator, which every boot showing these hints is already past.
 *
 * The 503 is checked through the real router. The boot line cannot be run
 * without booting the whole composition root (`src/index.ts` calls `main()` at
 * import), so — as in `778RouteMounts.wiring.test.ts` — it is read from source:
 * exactly one `chat DISABLED` warning, composing `LLM_SETUP_HINT`, which is
 * itself checked directly. All are pinned on the CLAIM (no wizard, names a
 * real path), not on the exact wording.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { LLM_SETUP_HINT } from '../src/llmSetupHint.js';
import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/** The wizard no longer collects a key — no operator-facing hint may say it does. */
const STALE_WIZARD = /Setup[- ]?Wizard/i;
/**
 * A hint is only useful if it names somewhere the operator can actually go.
 * English only: middleware copy has no i18n layer and is English by
 * construction, so a German alternative here would accept a string this
 * process cannot produce.
 */
const REAL_PATH = /\/admin\/providers|LLM access/;

const indexSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'),
  'utf8',
);

describe('#1090 — chat-disabled hints point at a path that exists', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    // `getStore` returning undefined is the "no LLM configured" state.
    app.use('/api/chat', createChatSessionsRouter({ getStore: () => undefined }));
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/chat`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('the chat_unavailable 503 body does not send the operator to the wizard', async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'chat_unavailable');
    assert.ok(
      !STALE_WIZARD.test(body.message),
      `503 message still names the Setup Wizard: ${body.message}`,
    );
    assert.match(body.message, REAL_PATH);
  });

  it('the shared hint the boot warning composes names no wizard', () => {
    assert.ok(
      !STALE_WIZARD.test(LLM_SETUP_HINT),
      `LLM_SETUP_HINT still names the Setup Wizard: ${LLM_SETUP_HINT}`,
    );
    assert.match(LLM_SETUP_HINT, REAL_PATH);
    // Every boot that prints this hint has already registered the
    // orchestrator, so an env key set now is never read (llmSetupHint.ts).
    assert.doesNotMatch(
      LLM_SETUP_HINT,
      /\.env\b/,
      `LLM_SETUP_HINT offers middleware/.env, which this boot no longer reads: ${LLM_SETUP_HINT}`,
    );
  });

  it('the boot warning composes that hint and names no wizard', () => {
    const warnings = indexSource
      .split('\n')
      .filter((line) => line.includes('chat DISABLED'))
      .filter((line) => !/^\s*(?:\/\/|\*)/.test(line));
    assert.equal(
      warnings.length,
      1,
      `expected exactly one live 'chat DISABLED' warning in src/index.ts, found ${String(warnings.length)} — if it was reworded, move this anchor with it`,
    );
    const [warning = ''] = warnings;
    assert.match(
      warning,
      /\$\{LLM_SETUP_HINT\}/,
      `boot warning no longer composes LLM_SETUP_HINT: ${warning.trim()}`,
    );
    assert.ok(
      !STALE_WIZARD.test(warning),
      `boot warning still names the Setup Wizard: ${warning.trim()}`,
    );
  });

  it('the 503 body composes that hint rather than restating it', async () => {
    // The two surfaces drifting apart is how #1090 happened: one sentence
    // lived in two literals, so a fix could land in one and miss the other.
    const res = await fetch(`${baseUrl}/sessions`);
    const body = (await res.json()) as { message: string };
    assert.ok(
      body.message.includes(LLM_SETUP_HINT),
      `503 message no longer composes LLM_SETUP_HINT: ${body.message}`,
    );
  });
});
