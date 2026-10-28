/**
 * #1456 — an activation failure must be recorded as a CODE, not only as the
 * plugin author's exception sentence.
 *
 * The bug this pins down: the only reason an operator got was
 * `err.message` from the plugin API — English in both UI languages, written
 * for a plugin author ("add 'entityRefBus@<major>' to the manifest's
 * `requires:` list"), and useless to the person reading it, who cannot edit a
 * manifest. The fix classifies the throw into a closed set of codes, each
 * keyed on what the OPERATOR can do about it, so the UI can say it in their
 * language.
 *
 * Classification reads the error OBJECT (name + typed fields), never the
 * message — the same policy `toolErrorNotice.ts` already applies to exception
 * text that would otherwise reach a model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyActivationError,
  dependencyUnresolvedReason,
  TRANSIENT_UNREACHABLE_RE,
} from '../src/plugins/activationErrorReason.js';
import {
  MissingConfigError,
  MissingSecretError,
  ServiceNotDeclaredError,
  SqlPermissionError,
} from '@omadia/plugin-api';

test('an undeclared capability is a plugin defect, with the capability named', () => {
  const reason = classifyActivationError(
    new ServiceNotDeclaredError('@omadia/integration-odoo', 'entityRefBus'),
  );
  assert.deepEqual(reason, {
    code: 'capability_not_declared',
    capability: 'entityRefBus',
  });
});

test('a missing secret names the setup field, never its value', () => {
  const reason = classifyActivationError(
    new MissingSecretError('@omadia/integration-odoo', 'odoo_api_key'),
  );
  assert.deepEqual(reason, { code: 'secret_missing', field: 'odoo_api_key' });
});

test('a missing config value is its own code — the form is the fix', () => {
  const reason = classifyActivationError(
    new MissingConfigError('@omadia/integration-odoo', 'odoo_url'),
  );
  assert.deepEqual(reason, { code: 'config_missing', field: 'odoo_url' });
});

test('an ungranted sql permission is operator-actionable, an undeclared one is not', () => {
  assert.deepEqual(
    classifyActivationError(
      new SqlPermissionError('@omadia/integration-odoo', 'sql', 'ungranted'),
    ),
    { code: 'permission_not_granted', capability: 'sql' },
  );
  assert.deepEqual(
    classifyActivationError(
      new SqlPermissionError('@omadia/integration-odoo', 'sql', 'undeclared'),
    ),
    { code: 'capability_not_declared', capability: 'sql' },
  );
});

test('a connection errno is an unreachable target, not a broken plugin', () => {
  const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
    code: 'ECONNREFUSED',
  });
  assert.deepEqual(classifyActivationError(err), {
    code: 'target_unreachable',
  });
});

test('a connection fingerprint that only survived in the message still reads as unreachable', () => {
  // A wrapper that rethrows keeps the errno in the text and loses `err.code`.
  assert.deepEqual(
    classifyActivationError(
      new Error('ECONNREFUSED: agent dependency unavailable'),
    ),
    { code: 'target_unreachable' },
  );
  // Driver prose has no errno at all and exists only in the text. This is the
  // one failure class that resolves itself, so telling the operator to forward
  // it to the plugin's author would be the wrong action.
  assert.deepEqual(
    classifyActivationError(
      new Error('error: the database system is starting up'),
    ),
    { code: 'target_unreachable' },
  );
});

test('the retry loop and the operator copy read the same fingerprints', () => {
  // While these were two lists they disagreed: bootstrap retried "the database
  // system is starting up" as transient while the classifier called it
  // `unknown`. One exported regex now answers both questions.
  for (const text of [
    'connect ECONNREFUSED 127.0.0.1:5432',
    'getaddrinfo EAI_AGAIN ollama',
    'Connection terminated unexpectedly',
    'the database system is starting up',
    'request timed out',
  ]) {
    assert.ok(
      TRANSIENT_UNREACHABLE_RE.test(text),
      `bootstrap would retry "${text}"`,
    );
    assert.deepEqual(
      classifyActivationError(new Error(text)),
      { code: 'target_unreachable' },
      `…so the operator must be told the target was unreachable for "${text}"`,
    );
  }
});

test('an unknown throw classifies as unknown rather than guessing', () => {
  assert.deepEqual(classifyActivationError(new Error('kaboom')), {
    code: 'unknown',
  });
  assert.deepEqual(classifyActivationError('a thrown string'), {
    code: 'unknown',
  });
  assert.deepEqual(classifyActivationError(undefined), { code: 'unknown' });
});

test('classification never copies the exception message into the reason', () => {
  const message =
    "plugin '@omadia/integration-odoo' has no secret 'odoo_api_key' in vault";
  const reason = classifyActivationError(
    new MissingSecretError('@omadia/integration-odoo', 'odoo_api_key'),
  );
  assert.equal(
    JSON.stringify(reason).includes(message),
    false,
    'the raw sentence belongs in last_activation_error, not in the reason',
  );
});

test('an unresolved dependency chain carries the requires list it was refused for', () => {
  assert.deepEqual(dependencyUnresolvedReason(['entityRefBus@1', 'odooClient@2']), {
    code: 'dependency_unresolved',
    requires: ['entityRefBus@1', 'odooClient@2'],
  });
  assert.deepEqual(dependencyUnresolvedReason([]), {
    code: 'dependency_unresolved',
  });
});
