import { describe, expect, it } from 'vitest';

import {
  parseScanFailureCode,
  redactProviderInternals,
  supportDetail,
} from '../scanFailure';

/**
 * OM-26 — provider-internal identifiers must never reach the screen.
 *
 * The original bug leaked an Anthropic `request_id`. `request_id` was the only
 * correlation handle the first fix knew about, which left every sibling shape
 * (`x-request-id`, `requestId`, `trace_id`, `correlation_id`, Cloudflare's
 * `cf-ray`) sailing straight through. These assert on the ABSENCE of the value,
 * not on the presence of the marker — a scrubber that mangles the field name
 * but keeps the id is still a leak.
 */

/** The exact payload from the bug report. */
const RAW_401_BODY =
  '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CdcPnpMTB8iyAmMBnbem8"}';

describe('redactProviderInternals', () => {
  it('scrubs the request id from the original OM-26 payload', () => {
    const out = redactProviderInternals(RAW_401_BODY);
    expect(out).not.toContain('req_011CdcPnpMTB8iyAmMBnbem8');
    expect(out).not.toContain('request_id');
    expect(out).toContain('[redacted]');
  });

  const jsonShapes: ReadonlyArray<readonly [label: string, raw: string, secret: string]> = [
    ['x-request-id', '{"x-request-id":"abc123def456"}', 'abc123def456'],
    ['requestId', '{"requestId":"7f3e9a1b2c4d"}', '7f3e9a1b2c4d'],
    ['trace_id', '{"trace_id":"0af7651916cd43dd"}', '0af7651916cd43dd'],
    ['traceId', '{"traceId":"0af7651916cd43dd"}', '0af7651916cd43dd'],
    ['correlation_id', '{"correlation_id":"c0rr3l4t10n"}', 'c0rr3l4t10n'],
    ['correlationId', '{"correlationId":"c0rr3l4t10n"}', 'c0rr3l4t10n'],
    ['cf-ray', '{"cf-ray":"8f3a1b2c3d4e5f60-FRA"}', '8f3a1b2c3d4e5f60-FRA'],
  ];

  it.each(jsonShapes)('scrubs %s in its JSON-field shape', (_label, raw, secret) => {
    const out = redactProviderInternals(raw);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  const headerShapes: ReadonlyArray<readonly [label: string, raw: string, secret: string]> = [
    ['x-request-id', 'x-request-id: abc123def456', 'abc123def456'],
    ['requestId', 'requestId = 7f3e9a1b2c4d', '7f3e9a1b2c4d'],
    ['trace_id', 'trace_id: 0af7651916cd43dd', '0af7651916cd43dd'],
    ['correlation_id', 'correlation_id: c0rr3l4t10n', 'c0rr3l4t10n'],
    ['cf-ray', 'cf-ray: 8f3a1b2c3d4e5f60-FRA', '8f3a1b2c3d4e5f60-FRA'],
  ];

  it.each(headerShapes)('scrubs %s in its bare header/log shape', (_label, raw, secret) => {
    const out = redactProviderInternals(raw);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('scrubs bare req_ tokens and api keys', () => {
    const out = redactProviderInternals(
      'ctx req_011CdcPnpMTB8iyAmMBnbem8 key sk-ant-api03-AAAABBBBCCCC',
    );
    expect(out).not.toContain('req_011CdcPnpMTB8iyAmMBnbem8');
    expect(out).not.toContain('sk-ant-api03-AAAABBBBCCCC');
  });

  it('leaves an ordinary operator-facing sentence untouched', () => {
    // A scrubber that eats normal prose would quietly destroy the genuine LLM
    // rationale, which is the field this runs on most of the time.
    const clean = 'The skill reads ~/.ssh/id_rsa and posts it to an external host.';
    expect(redactProviderInternals(clean)).toBe(clean);
  });
});

describe('supportDetail', () => {
  it('redacts and caps the raw provider body', () => {
    const detail = supportDetail(new Error(RAW_401_BODY));
    expect(detail).not.toContain('req_011CdcPnpMTB8iyAmMBnbem8');
    expect(detail.length).toBeLessThanOrEqual(601);
  });
});

describe('parseScanFailureCode', () => {
  it('extracts a known code and rejects free text', () => {
    expect(parseScanFailureCode('scan_failed:auth')).toBe('auth');
    expect(parseScanFailureCode('scan_failed:not_a_code')).toBeNull();
    expect(parseScanFailureCode('The skill looks fine.')).toBeNull();
    expect(parseScanFailureCode(null)).toBeNull();
  });
});
