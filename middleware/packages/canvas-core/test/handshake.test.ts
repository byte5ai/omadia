import { describe, expect, it } from 'vitest';
import { createHandshake } from '../src/handshake.js';
import type { HandshakeAck, HandshakeErrorMsg, HandshakeOffer } from '../src/protocol.js';

const OFFER: HandshakeOffer = {
  type: 'handshake_offer',
  handshakeId: 'h1',
  protocolVersions: ['1.0'],
  opsCatalogVersions: ['1.0'],
};
const CONFIG = { protocolVersions: ['1.0'], opsCatalogVersions: ['1.0'], localOperations: ['noop'] };

describe('createHandshake', () => {
  it('selects a mutual version and becomes ready on ack', () => {
    const hs = createHandshake({ ...CONFIG, canvasSessionId: 'stored-1' });
    const a1 = hs.onMessage(OFFER);
    expect(a1).toMatchObject({
      kind: 'send',
      message: {
        type: 'handshake_select',
        handshakeId: 'h1',
        protocolVersion: '1.0',
        opsCatalogVersion: '1.0',
        localOperations: ['noop'],
        canvasSessionId: 'stored-1',
      },
    });
    const ack: HandshakeAck = { type: 'handshake_ack', handshakeId: 'h1', canvasSessionId: 'c-9' };
    expect(hs.onMessage(ack)).toEqual({ kind: 'ready', canvasSessionId: 'c-9' });
  });

  it('fails when there is no mutual protocol version', () => {
    const hs = createHandshake(CONFIG);
    const a = hs.onMessage({ ...OFFER, protocolVersions: ['2.0'] });
    expect(a).toMatchObject({ kind: 'fail' });
  });

  it('retries once on handshake_error, then fails on a second error', () => {
    const hs = createHandshake({ ...CONFIG, protocolVersions: ['1.1', '1.0'] });
    hs.onMessage({ ...OFFER, protocolVersions: ['1.1', '1.0'] }); // selects 1.1
    const err: HandshakeErrorMsg = {
      type: 'handshake_error',
      handshakeId: 'h1',
      reason: 'protocol-version-unsupported',
      supported: { protocolVersions: ['1.0'], opsCatalogVersions: ['1.0'] },
    };
    const retry = hs.onMessage(err);
    expect(retry).toMatchObject({ kind: 'send', message: { protocolVersion: '1.0' } });
    expect(hs.onMessage(err)).toMatchObject({ kind: 'fail' });
  });

  it('ignores frames after settling', () => {
    const hs = createHandshake(CONFIG);
    hs.onMessage(OFFER);
    hs.onMessage({ type: 'handshake_ack', handshakeId: 'h1', canvasSessionId: 'c' });
    expect(hs.onMessage(OFFER)).toBeNull();
  });
});
