import { describe, expect, it } from 'vitest';

import {
  CHAT_UPLOAD_ACCEPT,
  CHAT_UPLOAD_MAX_BYTES,
  deleteChatUpload,
  precheckUpload,
  readyUploads,
  uploadChatFile,
  uploadErrorFromResponse,
  type ComposerUpload,
} from './chatUploads';

describe('#2336 — web-chat uploads (client)', () => {
  it('refuses early what the middleware would refuse', () => {
    expect(precheckUpload({ name: 'call.m4a', size: 10 })).toBeUndefined();
    expect(precheckUpload({ name: 'Report.PDF', size: 10 })).toBeUndefined();
    expect(precheckUpload({ name: 'tool.exe', size: 10 })).toBe('unsupportedType');
    expect(precheckUpload({ name: 'noext', size: 10 })).toBe('unsupportedType');
    expect(precheckUpload({ name: 'a.csv', size: 0 })).toBe('empty');
    expect(precheckUpload({ name: 'a.wav', size: CHAT_UPLOAD_MAX_BYTES + 1 })).toBe('tooLarge');
    expect(CHAT_UPLOAD_ACCEPT).toContain('.xlsx');
  });

  it('maps refusal codes to localized reasons', () => {
    expect(uploadErrorFromResponse(413, 'chat_upload.too_large')).toBe('tooLarge');
    expect(uploadErrorFromResponse(415, 'chat_upload.unsupported_type')).toBe('unsupportedType');
    expect(uploadErrorFromResponse(503, 'chat_upload.store_unavailable')).toBe('storeUnavailable');
    expect(uploadErrorFromResponse(401, 'chat_upload.no_account')).toBe('noAccount');
    expect(uploadErrorFromResponse(429, 'chat_upload.chat_limit')).toBe('chatLimit');
    expect(uploadErrorFromResponse(429, 'chat_upload.account_limit')).toBe('accountLimit');
    expect(uploadErrorFromResponse(415, 'chat_upload.content_mismatch')).toBe('contentMismatch');
    expect(uploadErrorFromResponse(413, undefined)).toBe('tooLarge');
    expect(uploadErrorFromResponse(500, 'chat_upload.failed')).toBe('failed');
  });

  it('uploads into the chat and returns the stored file', async () => {
    let sent: FormData | undefined;
    const fakeFetch = ((url: string, init: RequestInit) => {
      expect(url).toBe('/bot-api/chat/uploads');
      sent = init.body as FormData;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            upload: { storageKey: 'web-chat/c/u/a.pdf', fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 3 },
          }),
          { status: 201 },
        ),
      );
    }) as unknown as typeof fetch;
    const outcome = await uploadChatFile('c', new File(['abc'], 'a.pdf'), fakeFetch);
    expect(outcome).toEqual({
      ok: true,
      file: { storageKey: 'web-chat/c/u/a.pdf', fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 3 },
    });
    expect(sent?.get('sessionId')).toBe('c');
  });

  it('a refused or failed upload never throws', async () => {
    const refused = (() =>
      Promise.resolve(new Response(JSON.stringify({ code: 'chat_upload.unsupported_type' }), { status: 415 }))) as unknown as typeof fetch;
    expect(await uploadChatFile('c', new File(['x'], 'a.pdf'), refused)).toEqual({ ok: false, error: 'unsupportedType' });
    const broken = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await uploadChatFile('c', new File(['x'], 'a.pdf'), broken)).toEqual({ ok: false, error: 'failed' });
  });

  it('only ready files go with the message', () => {
    const file = { storageKey: 'k', fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 };
    const list: ComposerUpload[] = [
      { localId: '1', fileName: 'a.pdf', sizeBytes: 1, status: 'ready', uploaded: file },
      { localId: '2', fileName: 'b.pdf', sizeBytes: 1, status: 'uploading' },
      { localId: '3', fileName: 'c.exe', sizeBytes: 1, status: 'error', error: 'unsupportedType' },
    ];
    expect(readyUploads(list)).toEqual([file]);
  });

  it('deletes a removed upload by chat and key, never throws', async () => {
    let called = '';
    const ok = ((url: string, init: RequestInit) => {
      called = `${String(init.method)} ${url}`;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    expect(await deleteChatUpload('c1', 'web-chat/c1/u/a b.pdf', ok)).toBe(true);
    expect(called).toBe('DELETE /bot-api/chat/uploads?sessionId=c1&storageKey=web-chat%2Fc1%2Fu%2Fa+b.pdf');
    const broken = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await deleteChatUpload('c1', 'k', broken)).toBe(false);
  });
});
