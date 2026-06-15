import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildPairingDescriptor,
  resolveCanvasWsUrl,
  resolveScheme,
  CANVAS_WS_PATH,
  PAIRING_PROTOCOL_VERSION,
  type PairingRequestInfo,
  type ProviderSummaryLike,
} from '../src/pairing/discovery.js';

function req(
  headers: Record<string, string | string[] | undefined>,
  encrypted = false,
): PairingRequestInfo {
  return { headers, encrypted };
}

test('resolveScheme: plain HTTP request → ws + host', () => {
  const s = resolveScheme(req({ host: 'localhost:8080' }));
  assert.deepEqual(s, {
    secure: false,
    httpProto: 'http',
    wsProto: 'ws',
    host: 'localhost:8080',
  });
});

test('resolveScheme: direct TLS socket → wss', () => {
  const s = resolveScheme(req({ host: 'omadia.local' }, true));
  assert.equal(s.secure, true);
  assert.equal(s.wsProto, 'wss');
});

test('resolveScheme: honours x-forwarded-proto/host (behind Fly edge)', () => {
  const s = resolveScheme(
    req({
      host: 'internal:8080',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'omadia.example.com',
    }),
  );
  assert.equal(s.httpProto, 'https');
  assert.equal(s.wsProto, 'wss');
  assert.equal(s.host, 'omadia.example.com');
});

test('resolveScheme: takes first value of comma-joined forwarded headers', () => {
  const s = resolveScheme(
    req({
      host: 'h',
      'x-forwarded-proto': 'https, http',
      'x-forwarded-host': 'public.example.com, internal',
    }),
  );
  assert.equal(s.host, 'public.example.com');
  assert.equal(s.wsProto, 'wss');
});

test('resolveCanvasWsUrl: derives absolute URL from request origin', () => {
  const url = resolveCanvasWsUrl(
    req({ host: 'omadia.example.com', 'x-forwarded-proto': 'https' }),
  );
  assert.equal(url, `wss://omadia.example.com${CANVAS_WS_PATH}`);
});

test('resolveCanvasWsUrl: explicit override wins (split deployment)', () => {
  const url = resolveCanvasWsUrl(req({ host: 'operator.example.com' }), {
    publicWsUrl: 'wss://middleware.example.com/omadia-ui/canvas',
  });
  assert.equal(url, 'wss://middleware.example.com/omadia-ui/canvas');
});

test('resolveCanvasWsUrl: blank override is ignored, falls back to derived', () => {
  const url = resolveCanvasWsUrl(req({ host: 'h:8080' }), { publicWsUrl: '  ' });
  assert.equal(url, `ws://h:8080${CANVAS_WS_PATH}`);
});

test('buildPairingDescriptor: no providers → auth mode none, host as name', () => {
  const d = buildPairingDescriptor(req({ host: 'box.local:8080' }));
  assert.equal(d.name, 'box.local:8080');
  assert.equal(d.protocolVersion, PAIRING_PROTOCOL_VERSION);
  assert.deepEqual(d.protocolVersions, [PAIRING_PROTOCOL_VERSION]);
  assert.equal(d.wsUrl, `ws://box.local:8080${CANVAS_WS_PATH}`);
  assert.deepEqual(d.auth, { mode: 'none' });
});

test('buildPairingDescriptor: password provider → mode password + absolute loginStartUrl', () => {
  const providers: ProviderSummaryLike[] = [
    { id: 'local', displayName: 'Password', kind: 'password' },
  ];
  const d = buildPairingDescriptor(
    req({ host: 'omadia.example.com', 'x-forwarded-proto': 'https' }),
    { providers },
  );
  assert.equal(d.auth.mode, 'password');
  assert.deepEqual(d.auth.providers, providers);
  assert.equal(
    d.auth.loginStartUrl,
    'https://omadia.example.com/api/v1/auth',
  );
});

test('buildPairingDescriptor: any oidc provider → mode oidc', () => {
  const providers: ProviderSummaryLike[] = [
    { id: 'local', displayName: 'Password', kind: 'password' },
    { id: 'entra', displayName: 'Microsoft', kind: 'oidc' },
  ];
  const d = buildPairingDescriptor(req({ host: 'h' }), { providers });
  assert.equal(d.auth.mode, 'oidc');
});

test('buildPairingDescriptor: instanceName overrides host label', () => {
  const d = buildPairingDescriptor(req({ host: 'h' }), {
    instanceName: 'Acme Omadia',
  });
  assert.equal(d.name, 'Acme Omadia');
});

test('buildPairingDescriptor: publicWsUrl override flows through', () => {
  const d = buildPairingDescriptor(req({ host: 'operator.example.com' }), {
    publicWsUrl: 'wss://mw.example.com/omadia-ui/canvas',
  });
  assert.equal(d.wsUrl, 'wss://mw.example.com/omadia-ui/canvas');
});
