import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import { serverDetail } from '../useAgentApiErrorText';

describe('serverDetail', () => {
  it('shows the reason without code or status when the body has one', () => {
    const err = new ApiError(409, 'PUT x failed: 409', JSON.stringify({ error: 'x_conflict', message: 'busy' }));
    expect(serverDetail(err)).toBe('busy');
  });

  it('keeps the code next to the status when the body has no reason', () => {
    const err = new ApiError(409, 'PUT x failed: 409', JSON.stringify({ error: 'x_conflict' }));
    expect(serverDetail(err)).toBe('x_conflict (HTTP 409)');
  });

  it('falls back to the bare status for a body without code or reason', () => {
    const err = new ApiError(502, 'PUT x failed: 502', '<html>bad gateway</html>');
    expect(serverDetail(err)).toBe('HTTP 502');
  });
});
