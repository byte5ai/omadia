/**
 * #2336 (ADR-0310) — file uploads of the web chat.
 *
 * The upload route stores the file, binds its key to the chat at upload
 * (ADR-0178) and files it under account and chat in the ADR-0187 ledger. A
 * turn names its uploads only by key; the kernel accepts a key only when it is
 * a web-chat key of this chat with a binding to this chat, and states name and
 * type itself. Deleting the chat deletes the file. A web turn with uploads is
 * offered `read_attachment` / `transcribe_recording`.
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore, turnContext, turnMayCarryUploads, today } from '@omadia/orchestrator';
import type { ChatAgent, ChatTurnInput, ChatTurnResult } from '@omadia/orchestrator';

import { InMemoryAttachmentBindingStore } from '../src/audience/postgresAttachmentBindingStore.js';
import { createChatRouter } from '../src/routes/chat.js';
import {
  attachmentsInfoBlock,
  createChatUploadsRouter,
  parseWebChatUploadKey,
  resolveTurnUploads,
  sanitizeUploadFileName,
  WEB_CHAT_UPLOAD_MAX_BYTES,
  WEB_CHAT_UPLOAD_PRODUCER,
  webChatUploadKey,
} from '../src/routes/chatUploads.js';
import {
  createGeneratedObjectsRegistry,
  InMemoryGeneratedObjectStore,
} from '../src/services/generatedObjects.js';
import { listenLoopback } from './_helpers/listenLoopback.js';
import { routeTurnFrom } from './_helpers/webRouteTurn.js';

const ANNA = { sub: 'anna@example.test', omadia_user_id: 'u-anna' };
const BEN = { sub: 'ben@example.test', omadia_user_id: 'u-ben' };
const CHAT = 'chat2336anna';
const UPLOAD_ID = '00000000-0000-4000-8000-000000002336';

class MemoryObjects {
  readonly objects = new Map<string, { body: Buffer; contentType: string | undefined }>();
  put(key: string, body: Buffer, contentType?: string): Promise<void> {
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

describe('#2336 — web-chat uploads', () => {
  let server: Server;
  let base: string;
  let objects: MemoryObjects;
  let bindings: InMemoryAttachmentBindingStore;
  let ledger: InMemoryGeneratedObjectStore;
  let registry: ReturnType<typeof createGeneratedObjectsRegistry>;
  let chats: ChatSessionStore;
  let turns: ChatTurnInput[];
  let nextId = 0;

  const agent: ChatAgent = {
    chat: (input: ChatTurnInput) => {
      turns.push(input);
      return Promise.resolve({ text: 'ok' } as unknown as ChatTurnResult);
    },
    chatStream: () => {
      throw new Error('not used');
    },
  } as unknown as ChatAgent;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const who = req.header('x-test-account');
      (req as unknown as { session: unknown }).session =
        who === 'anna' ? ANNA : who === 'ben' ? BEN : undefined;
      next();
    });
    app.use(
      '/api',
      createChatUploadsRouter({
        store: () => objects,
        bindings: { get: (k) => bindings.get(k), bindIfAbsent: (k, b) => bindings.bindIfAbsent(k, b) },
        recordUpload: (key, owner) => registry.recordFor(WEB_CHAT_UPLOAD_PRODUCER, key, owner),
        getChatSessionStore: () => chats,
        newUploadId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
      }),
    );
    app.use(
      '/api',
      createChatRouter({
        attachmentBindings: { get: (k) => bindings.get(k), bindIfAbsent: (k, b) => bindings.bindIfAbsent(k, b) },
        getChatSessionStore: () => chats,
        routeTurn: routeTurnFrom(
          () => agent,
          () => 'general',
        ),
      }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(async () => {
    objects = new MemoryObjects();
    bindings = new InMemoryAttachmentBindingStore();
    ledger = new InMemoryGeneratedObjectStore();
    registry = createGeneratedObjectsRegistry({ store: () => ledger, currentTurn: () => undefined });
    registry.registerDeleter(WEB_CHAT_UPLOAD_PRODUCER, (key) => objects.delete(key));
    chats = new ChatSessionStore(new InMemoryMemoryStore());
    await chats.save({ id: CHAT, title: 'c', createdAt: 1, updatedAt: 1, messages: [], ownerUserId: ANNA.sub });
    turns = [];
    nextId = 0;
  });

  async function upload(
    account: string | undefined,
    fileName: string,
    body: string | Buffer = 'hello',
    sessionId = CHAT,
  ): Promise<Response> {
    const form = new FormData();
    form.set('sessionId', sessionId);
    form.set('file', new Blob([typeof body === 'string' ? body : new Uint8Array(body)]), fileName);
    return fetch(`${base}/chat/uploads`, {
      method: 'POST',
      body: form,
      headers: account ? { 'x-test-account': account } : {},
    });
  }

  async function turn(account: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-account': account },
      body: JSON.stringify(body),
    });
  }

  it('stores, binds to the chat and files the upload under account and chat', async () => {
    const res = await upload('anna', 'Protokoll März.pdf');
    assert.equal(res.status, 201);
    const { upload: up } = (await res.json()) as { upload: { storageKey: string; contentType: string; fileName: string; sizeBytes: number } };
    assert.equal(up.storageKey, webChatUploadKey(CHAT, `00000000-0000-4000-8000-000000000000`, 'Protokoll März.pdf'));
    assert.equal(up.contentType, 'application/pdf');
    assert.equal(up.sizeBytes, 5);
    assert.equal(objects.objects.get(up.storageKey)?.contentType, 'application/pdf');
    assert.deepEqual(await bindings.get(up.storageKey), { scopeKind: 'conversation', scopeRef: CHAT });
    assert.deepEqual(await ledger.select({ scope: CHAT }), [
      { storageKey: up.storageKey, producer: WEB_CHAT_UPLOAD_PRODUCER, ownerOmadiaUserId: 'u-anna', scope: CHAT },
    ]);
  });

  it('refuses without an account, for another account’s chat, an unknown type and an empty file', async () => {
    assert.equal((await upload(undefined, 'a.pdf')).status, 401);
    const foreign = await upload('ben', 'a.pdf');
    assert.equal(foreign.status, 404);
    const exe = await upload('anna', 'tool.exe');
    assert.equal(exe.status, 415);
    assert.equal(((await exe.json()) as { code: string }).code, 'chat_upload.unsupported_type');
    assert.equal((await upload('anna', 'a.pdf', '')).status, 400);
    assert.equal(objects.objects.size, 0);
  });

  it('refuses a file over the limit with 413', async () => {
    const res = await upload('anna', 'big.wav', Buffer.alloc(WEB_CHAT_UPLOAD_MAX_BYTES + 1));
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { code: string }).code, 'chat_upload.too_large');
    assert.equal(objects.objects.size, 0);
  });

  it('a turn states its uploads as storedAttachments, with the model block', async () => {
    const { upload: up } = (await (await upload('anna', 'call.m4a')).json()) as { upload: { storageKey: string } };
    const res = await turn('anna', { message: '', sessionId: CHAT, attachments: [{ storageKey: up.storageKey, sizeBytes: 2048 }] });
    assert.equal(res.status, 200);
    const input = turns[0];
    assert.deepEqual(input?.storedAttachments, [
      { fileName: 'call.m4a', contentType: 'audio/mp4', storageKey: up.storageKey, sizeBytes: 2048 },
    ]);
    assert.match(input?.userMessage ?? '', /\[attachments-info\] 1 Datei\(en\)/);
    assert.match(input?.userMessage ?? '', new RegExp(`storage_key=${up.storageKey}`));
  });

  it('a key of another chat, a typed key or a key under a debug scope is refused before the turn', async () => {
    const { upload: up } = (await (await upload('anna', 'a.pdf')).json()) as { upload: { storageKey: string } };
    // Ben's chat names Anna's key.
    await chats.save({ id: 'chatben', title: 'b', createdAt: 1, updatedAt: 1, messages: [], ownerUserId: BEN.sub });
    const stolen = await turn('ben', { message: 'x', sessionId: 'chatben', attachments: [{ storageKey: up.storageKey }] });
    assert.equal(stolen.status, 400);
    // A key in this chat's layout that the route never stored (no binding).
    const typed = await turn('anna', {
      message: 'x',
      sessionId: CHAT,
      attachments: [{ storageKey: webChatUploadKey(CHAT, UPLOAD_ID, 'x.pdf') }],
    });
    assert.equal(typed.status, 400);
    // Any other key layout.
    const teams = await turn('anna', { message: 'x', sessionId: CHAT, attachments: [{ storageKey: 'teams/abc/x.pdf' }] });
    assert.equal(teams.status, 400);
    const debug = await turn('anna', { message: 'x', sessionId: CHAT, scope: 'dbg', attachments: [{ storageKey: up.storageKey }] });
    assert.equal(debug.status, 400);
    assert.equal(turns.length, 0);
  });

  it('an empty message without uploads is still refused', async () => {
    assert.equal((await turn('anna', { message: ' ', sessionId: CHAT })).status, 400);
  });

  it('deleting the chat (ledger release) deletes the uploaded file', async () => {
    const { upload: up } = (await (await upload('anna', 'a.csv', 'a,b\n1,2')).json()) as { upload: { storageKey: string } };
    const released = await registry.release({ scope: CHAT, ownerOmadiaUserId: 'u-anna' });
    assert.equal(released.deleted, 1);
    assert.equal(objects.objects.has(up.storageKey), false);
  });
});

describe('#2336 — key and name helpers', () => {
  it('sanitizes names: no path, no separators, extension kept', () => {
    assert.equal(sanitizeUploadFileName('../../etc/passwd.txt'), 'passwd.txt');
    assert.equal(sanitizeUploadFileName('a/b\\c:d?.pdf'), 'c_d_.pdf');
    assert.equal(sanitizeUploadFileName('...hidden.md'), 'hidden.md');
    const long = sanitizeUploadFileName(`${'x'.repeat(300)}.xlsx`);
    assert.equal(long.length, 120);
    assert.ok(long.endsWith('.xlsx'));
  });

  it('parses only its own layout', () => {
    const key = webChatUploadKey(CHAT, UPLOAD_ID, 'a.pdf');
    assert.deepEqual(parseWebChatUploadKey(key), { sessionId: CHAT, uploadId: UPLOAD_ID, fileName: 'a.pdf' });
    assert.equal(parseWebChatUploadKey(`web-chat/${CHAT}/${UPLOAD_ID}/../x.pdf`), undefined);
    assert.equal(parseWebChatUploadKey(`web-chat/${CHAT}/not-a-uuid/a.pdf`), undefined);
    assert.equal(parseWebChatUploadKey('teams/x/y/z.pdf'), undefined);
  });

  it('resolveTurnUploads without a binding store refuses', async () => {
    const result = await resolveTurnUploads([{ storageKey: webChatUploadKey(CHAT, UPLOAD_ID, 'a.pdf') }], CHAT, undefined);
    assert.equal(result.ok, false);
    assert.deepEqual(await resolveTurnUploads(undefined, CHAT, undefined), { ok: true, stored: [], modelBlock: '' });
  });

  it('the model block names file, type and key', () => {
    const block = attachmentsInfoBlock([{ fileName: 'a.pdf', contentType: 'application/pdf', storageKey: 'k' }]);
    assert.match(block, /- a\.pdf \(application\/pdf\) · storage_key=k/);
  });
});

describe('#2336 — attachment tools on a web turn', () => {
  it('a web turn that states uploads is offered them, one without is not', async () => {
    const base = { turnId: 't', turnDate: today() };
    const offered = (keys?: Set<string>): Promise<boolean> =>
      turnContext.run({ ...base, ...(keys ? { turnUploadKeys: keys } : {}) }, () =>
        Promise.resolve(turnMayCarryUploads()),
      );
    assert.equal(await offered(), false);
    assert.equal(await offered(new Set(['web-chat/c/u/a.pdf'])), true);
  });
});
