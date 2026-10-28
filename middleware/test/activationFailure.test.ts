import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  MissingConfigError,
  MissingSecretError,
  ServiceNotDeclaredError,
  SqlPermissionError,
} from '@omadia/plugin-api';

import {
  activationResultOf,
  classifyActivationError,
  describeActivationFailure,
} from '../src/plugins/activationFailure.js';
import {
  InMemoryInstalledRegistry,
  recordActivationFailure,
  recordActivationSuccess,
  type InstalledAgent,
} from '../src/plugins/installedRegistry.js';
import { computeReadiness } from '../src/plugins/readiness.js';

/**
 * #1456 — an activation failure is recorded with an operator-facing CODE next
 * to the raw developer message, classified from the error object.
 */

const ID = '@omadia/integration-odoo';

function entry(over: Partial<InstalledAgent> = {}): InstalledAgent {
  return {
    id: ID,
    installed_version: '0.2.0',
    installed_at: '2026-10-01T00:00:00.000Z',
    status: 'active',
    config: {},
    ...over,
  };
}

describe('classifyActivationError (#1456)', () => {
  it('maps the two reproductions of the issue to operator actions', () => {
    assert.equal(
      classifyActivationError(new ServiceNotDeclaredError(ID, 'entityRefBus')),
      'capability_not_declared',
    );
    assert.equal(
      classifyActivationError(new MissingSecretError(ID, 'odoo_api_key')),
      'secret_missing',
    );
  });

  it('separates the author defect from the operator consent on SQL', () => {
    assert.equal(
      classifyActivationError(new SqlPermissionError(ID, 'sql.ledger', 'undeclared')),
      'capability_not_declared',
    );
    assert.equal(
      classifyActivationError(new SqlPermissionError(ID, 'sql.ledger', 'ungranted')),
      'permission_not_granted',
    );
  });

  it('classifies by name, so a plugin-bundled copy of the class still counts', () => {
    const foreign = Object.assign(new Error('whatever'), { name: 'MissingConfigError' });
    assert.equal(classifyActivationError(foreign), 'config_missing');
    assert.equal(classifyActivationError(new MissingConfigError(ID, 'url')), 'config_missing');
  });

  it('reads the errno from the error or its undici cause, never from the message', () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    });
    assert.equal(classifyActivationError(refused), 'target_unreachable');
    assert.equal(
      classifyActivationError(new Error('getaddrinfo ENOTFOUND odoo.example')),
      'unknown',
      'a message that merely mentions an errno is not classified',
    );
  });

  it('falls back to unknown for anything else, including non-errors', () => {
    assert.equal(classifyActivationError(new Error('boom')), 'unknown');
    assert.equal(classifyActivationError('a string'), 'unknown');
    assert.equal(classifyActivationError(undefined), 'unknown');
  });

  it('never records an empty message', () => {
    assert.deepEqual(describeActivationFailure(new Error(''), 'fallback'), {
      message: 'fallback',
      code: 'unknown',
    });
  });
});

describe('registry × activation error code (#1456)', () => {
  it('stores the code with the reason and drops both on success', async () => {
    const registry = new InMemoryInstalledRegistry();
    await registry.register(entry());
    await recordActivationFailure(
      registry,
      ID,
      describeActivationFailure(new MissingSecretError(ID, 'odoo_api_key')),
    );
    const failed = registry.get(ID);
    assert.equal(failed?.status, 'errored');
    assert.equal(failed?.last_activation_error_code, 'secret_missing');
    assert.match(failed?.last_activation_error ?? '', /odoo_api_key/);

    await recordActivationSuccess(registry, ID);
    const ok = registry.get(ID);
    assert.equal(ok?.status, 'active');
    assert.equal(ok?.last_activation_error_code, undefined);
    assert.equal(ok?.last_activation_error, undefined);
  });

  it('a later failure without a code does not keep the previous code', async () => {
    const registry = new InMemoryInstalledRegistry();
    await registry.register(entry());
    await registry.markActivationFailed(ID, { message: 'x', code: 'secret_missing' });
    await registry.markActivationFailed(ID, 'plain reason');
    assert.equal(registry.get(ID)?.last_activation_error_code, undefined);
    assert.equal(activationResultOf({ ...registry.get(ID)!, status: 'errored' })?.error_code, 'unknown');
  });
});

describe('activationResultOf (#1497)', () => {
  it('reports active with no error fields, even with a stale failure count', () => {
    assert.deepEqual(
      activationResultOf(entry({ activation_failure_count: 1, last_activation_error: 'old' })),
      { state: 'active', ok: true, error: null, error_code: null },
    );
  });

  it('reports errored with the raw detail and its code', () => {
    assert.deepEqual(
      activationResultOf(
        entry({
          status: 'errored',
          last_activation_error: "plugin '…' has no secret 'odoo_api_key' in vault",
          last_activation_error_code: 'secret_missing',
        }),
      ),
      {
        state: 'errored',
        ok: false,
        error: "plugin '…' has no secret 'odoo_api_key' in vault",
        error_code: 'secret_missing',
      },
    );
  });

  it('degrades a pre-upgrade entry (reason, no code) to unknown + raw', () => {
    const preUpgrade = entry({ status: 'errored', last_activation_error: 'legacy reason' });
    assert.deepEqual(activationResultOf(preUpgrade), {
      state: 'errored',
      ok: false,
      error: 'legacy reason',
      error_code: 'unknown',
    });
  });

  it('is null for a plugin that is not installed', () => {
    assert.equal(activationResultOf(undefined), null);
  });
});

describe('readiness.error_code (#1456)', () => {
  it('carries the code next to error_detail for an errored plugin', async () => {
    const registry = new InMemoryInstalledRegistry();
    await registry.register(
      entry({
        status: 'errored',
        last_activation_error: 'raw',
        last_activation_error_code: 'capability_not_declared',
      }),
    );
    const r = await computeReadiness({ id: ID, setup_fields: [] }, registry);
    assert.equal(r.state, 'errored');
    assert.equal(r.error_code, 'capability_not_declared');
    assert.equal(r.error_detail, 'raw');
  });

  it('answers unknown for an errored entry written before codes existed', async () => {
    const registry = new InMemoryInstalledRegistry();
    await registry.register(entry({ status: 'errored', last_activation_error: 'raw' }));
    const r = await computeReadiness({ id: ID, setup_fields: [] }, registry);
    assert.equal(r.error_code, 'unknown');
  });
});

describe('readiness × keyless LLM provider (#1460)', () => {
  async function readinessWith(verdict: { status: 'unverified'; reason: 'not_checked' | 'network_error' }) {
    const registry = new InMemoryInstalledRegistry();
    await registry.register(entry({ id: '@omadia/orchestrator' }));
    return computeReadiness({ id: '@omadia/orchestrator', setup_fields: [] }, registry, undefined, {
      resolve: async () => verdict,
    });
  }

  it('does not turn amber for a keyless provider nobody has checked since boot', async () => {
    const r = await readinessWith({ status: 'unverified', reason: 'not_checked' });
    assert.equal(r.state, 'ready');
  });

  it('turns amber once a check ran and could not reach the provider', async () => {
    const r = await readinessWith({ status: 'unverified', reason: 'network_error' });
    assert.equal(r.state, 'awaiting_llm');
  });
});
