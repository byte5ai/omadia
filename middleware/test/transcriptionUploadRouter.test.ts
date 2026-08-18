/**
 * #584 — contract tests for the plugin-contributed audio upload
 * endpoint (`@omadia/plugin-transcription`), mounted in a test express app
 * exactly the way the kernel mounts contributed routers
 * (`app.use(prefix, router)`, no injected auth).
 *
 * Covers the ticket's acceptance list: happy path returns the four
 * manifest-line fields; oversize / format / multi-file rejections with the
 * `{code, message}` envelope; missing operator-auth accessor ⇒ fail closed.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { OperatorAuthAccessor } from '@omadia/plugin-api';
import {
  createTranscriptionUploadRouter,
  type TranscriptionUploadStore,
} from '@omadia/plugin-transcription';

import { listenLoopback } from './_helpers/listenLoopback.js';

const OPERATOR_COOKIE = 'omadia_session=valid-operator';

/** Accepts exactly the OPERATOR_COOKIE header, rejects everything else. */
const operatorAuth: OperatorAuthAccessor = {
  hasValidSession: async (cookieHeader) => cookieHeader === OPERATOR_COOKIE,
};

class InMemoryUploadStore implements TranscriptionUploadStore {
  readonly objects = new Map<string, { body: Buffer; contentType?: string }>();
  put(key: string, body: Buffer, contentType?: string): Promise<void> {
    this.objects.set(key, {
      body,
      ...(contentType === undefined ? {} : { contentType }),
    });
    return Promise.resolve();
  }
}

function uploadForm(
  parts: Array<{ field: string; name: string; type: string; bytes: Buffer }>,
): FormData {
  const form = new FormData();
  for (const p of parts) {
    form.append(p.field, new Blob([new Uint8Array(p.bytes)], { type: p.type }), p.name);
  }
  return form;
}

async function startApp(opts: {
  operatorAuth: OperatorAuthAccessor | undefined;
  store: TranscriptionUploadStore | undefined;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(
    '/transcriptions',
    createTranscriptionUploadRouter({
      operatorAuth: opts.operatorAuth,
      getStore: () => opts.store,
    }),
  );
  const server = await listenLoopback(app);
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(addr.port)}/transcriptions`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe('#584 — /transcriptions upload endpoint', () => {
  const store = new InMemoryUploadStore();
  let baseUrl = '';
  let close: () => Promise<void>;

  before(async () => {
    const started = await startApp({ operatorAuth, store });
    baseUrl = started.baseUrl;
    close = started.close;
  });
  after(async () => {
    await close();
  });

  it('happy path: one wav upload returns 201 with the four manifest-line fields and persists the bytes', async () => {
    const bytes = Buffer.from('RIFFxxxxWAVEfmt fake-audio');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { cookie: OPERATOR_COOKIE },
      body: uploadForm([{ field: 'file', name: 'standup.wav', type: 'audio/wav', bytes }]),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      storage_key: string;
      file_name: string;
      content_type: string;
      size_bytes: number;
    };
    assert.ok(body.storage_key.startsWith('transcription-uploads/'));
    assert.ok(body.storage_key.endsWith('.wav'));
    assert.equal(body.file_name, 'standup.wav');
    assert.equal(body.content_type, 'audio/wav');
    assert.equal(body.size_bytes, bytes.length);

    const stored = store.objects.get(body.storage_key);
    assert.ok(stored, 'bytes persisted under the returned storage_key');
    assert.deepEqual(stored.body, bytes);
    assert.equal(stored.contentType, 'audio/wav');
  });

  it('a generic content-type falls back to the extension and stores the canonical MIME', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { cookie: OPERATOR_COOKIE },
      body: uploadForm([
        {
          field: 'file',
          name: 'voicenote.m4a',
          type: 'application/octet-stream',
          bytes: Buffer.from('fake-m4a'),
        },
      ]),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { content_type: string; storage_key: string };
    assert.equal(body.content_type, 'audio/mp4');
    assert.ok(body.storage_key.endsWith('.m4a'));
  });

  it('oversize upload (> 25 MB) is rejected 413 with the error envelope', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { cookie: OPERATOR_COOKIE },
      body: uploadForm([
        {
          field: 'file',
          name: 'long.mp3',
          type: 'audio/mpeg',
          bytes: Buffer.alloc(25 * 1024 * 1024 + 1),
        },
      ]),
    });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, 'transcription.too_large');
    assert.equal(typeof body.message, 'string');
  });

  it('a non-audio format is rejected 422 with the error envelope', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { cookie: OPERATOR_COOKIE },
      body: uploadForm([
        { field: 'file', name: 'notes.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF') },
      ]),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'transcription.unsupported_type');
  });

  it('a second file in the same request is rejected with the envelope (single-file contract)', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { cookie: OPERATOR_COOKIE },
      body: uploadForm([
        { field: 'file', name: 'a.wav', type: 'audio/wav', bytes: Buffer.from('RIFFa') },
        { field: 'file', name: 'b.wav', type: 'audio/wav', bytes: Buffer.from('RIFFb') },
      ]),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'transcription.too_many_files');
  });

  it('a missing multipart file field is rejected 400', async () => {
    const form = new FormData();
    form.append('name', 'no file here');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { cookie: OPERATOR_COOKIE },
      body: form,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'transcription.no_file');
  });

  it('no session cookie ⇒ 401 auth_required; a wrong cookie ⇒ 401 auth_invalid; nothing is stored', async () => {
    const sizeBefore = store.objects.size;
    const bytes = Buffer.from('RIFFxxxxWAVE');

    const anonymous = await fetch(baseUrl, {
      method: 'POST',
      body: uploadForm([{ field: 'file', name: 'x.wav', type: 'audio/wav', bytes }]),
    });
    assert.equal(anonymous.status, 401);
    assert.equal(((await anonymous.json()) as { code: string }).code, 'transcription.auth_required');

    const invalid = await fetch(baseUrl, {
      method: 'POST',
      headers: { cookie: 'omadia_session=stolen' },
      body: uploadForm([{ field: 'file', name: 'x.wav', type: 'audio/wav', bytes }]),
    });
    assert.equal(invalid.status, 401);
    assert.equal(((await invalid.json()) as { code: string }).code, 'transcription.auth_invalid');

    assert.equal(store.objects.size, sizeBefore, 'unauthenticated uploads must never reach the store');
  });
});

describe('#584 — fail-closed edges', () => {
  it('missing operator-auth accessor ⇒ 503 on every request, even with a cookie', async () => {
    const { baseUrl, close } = await startApp({
      operatorAuth: undefined,
      store: new InMemoryUploadStore(),
    });
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { cookie: OPERATOR_COOKIE },
        body: uploadForm([
          { field: 'file', name: 'x.wav', type: 'audio/wav', bytes: Buffer.from('RIFF') },
        ]),
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'transcription.operator_auth_unavailable');
    } finally {
      await close();
    }
  });

  it('missing blob store ⇒ 503 storage_unavailable for an authenticated upload', async () => {
    const { baseUrl, close } = await startApp({ operatorAuth, store: undefined });
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { cookie: OPERATOR_COOKIE },
        body: uploadForm([
          { field: 'file', name: 'x.wav', type: 'audio/wav', bytes: Buffer.from('RIFF') },
        ]),
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'transcription.storage_unavailable');
    } finally {
      await close();
    }
  });

  it('a throwing store put ⇒ 500 internal_error envelope', async () => {
    const throwingStore: TranscriptionUploadStore = {
      put: () => Promise.reject(new Error('tigris exploded')),
    };
    const { baseUrl, close } = await startApp({ operatorAuth, store: throwingStore });
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { cookie: OPERATOR_COOKIE },
        body: uploadForm([
          { field: 'file', name: 'x.wav', type: 'audio/wav', bytes: Buffer.from('RIFF') },
        ]),
      });
      assert.equal(res.status, 500);
      const body = (await res.json()) as { code: string; message: string };
      assert.equal(body.code, 'transcription.internal_error');
      assert.match(body.message, /tigris exploded/);
    } finally {
      await close();
    }
  });
});
