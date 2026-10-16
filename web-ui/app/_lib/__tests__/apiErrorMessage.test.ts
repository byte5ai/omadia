import { describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import { serverErrorMessage, serverFieldErrors } from '../apiErrorMessage';

const fail = (body: string, status = 400): ApiError =>
  new ApiError(status, `POST /x failed: ${String(status)}`, body);

describe('serverErrorMessage', () => {
  it('reads `message` from a { code, message } envelope', () => {
    const err = fail('{"code":"conductor.webhook_url_forbidden","message":"invalid URL \'x\'"}');
    expect(serverErrorMessage(err)).toBe("invalid URL 'x'");
  });

  it('reads a string `error` and a nested `error.message`', () => {
    expect(serverErrorMessage(fail('{"error":"bad scope"}'))).toBe('bad scope');
    expect(serverErrorMessage(fail('{"error":{"message":"rate limited"}}'))).toBe('rate limited');
  });

  it('never returns the raw body or the transport line', () => {
    expect(serverErrorMessage(fail('<html>Bad Gateway</html>', 502))).toBeNull();
    expect(serverErrorMessage(fail('{"code":"x.only_code"}'))).toBeNull();
    expect(serverErrorMessage(fail(''))).toBeNull();
    expect(serverErrorMessage(fail('["not","an","object"]'))).toBeNull();
  });

  it('returns null for anything that is not an ApiError', () => {
    expect(serverErrorMessage(new Error('{"message":"nope"}'))).toBeNull();
    expect(serverErrorMessage('{"message":"nope"}')).toBeNull();
  });
});

describe('serverFieldErrors', () => {
  it('reads the per-field rejections of a 400 settings.invalid_values (#1330)', () => {
    const err = fail(
      '{"code":"settings.invalid_values","errors":[' +
        '{"key":"OPENAI_API_KEY","message":"OpenAI keys start with \\"sk-\\"","code":"settings.openai_key_format"},' +
        '{"key":"MISTRAL_API_KEY","message":"too short"}]}',
    );
    expect(serverFieldErrors(err)).toEqual([
      {
        key: 'OPENAI_API_KEY',
        message: 'OpenAI keys start with "sk-"',
        code: 'settings.openai_key_format',
      },
      { key: 'MISTRAL_API_KEY', message: 'too short' },
    ]);
  });

  it('skips malformed entries instead of guessing', () => {
    const err = fail('{"errors":[null,{"key":"A"},{"message":"m"},{"key":"B","message":"ok"}]}');
    expect(serverFieldErrors(err)).toEqual([{ key: 'B', message: 'ok' }]);
  });

  it('is empty without an errors array', () => {
    expect(serverFieldErrors(fail('{"code":"x"}'))).toEqual([]);
    expect(serverFieldErrors(new Error('x'))).toEqual([]);
  });
});
