import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  COLD_START_TARGET_KIND,
  buildEmailColdStartTarget,
  isColdStartTarget,
  isRoutineRecipient,
  normaliseRecipientEmail,
  type ColdStartTarget,
} from '@omadia/plugin-api';

describe('routineTarget — isColdStartTarget', () => {
  it('accepts a well-formed email cold-start target', () => {
    const target: ColdStartTarget = {
      kind: COLD_START_TARGET_KIND,
      channel: 'teams',
      recipient: { by: 'email', email: 'marcel@byte5.de' },
      orchestratorProfile: 'bare',
      createdBy: { tenant: 't1', userId: 'u1' },
    };
    assert.equal(isColdStartTarget(target), true);
  });

  it('accepts an aadObjectId cold-start target', () => {
    const target: ColdStartTarget = {
      kind: COLD_START_TARGET_KIND,
      channel: 'teams',
      recipient: { by: 'aadObjectId', aadObjectId: 'guid-123' },
      orchestratorProfile: 'inherit',
      createdBy: { tenant: 't1', userId: 'u1' },
    };
    assert.equal(isColdStartTarget(target), true);
  });

  it('rejects a plain Bot Framework conversation reference (warm path)', () => {
    // The legacy/warm value has no `kind: 'coldStart'` discriminator and
    // MUST be treated as an already-resolved reference.
    const warm = { conversation: { id: '19:abc@thread.skype' }, serviceUrl: 'x' };
    assert.equal(isColdStartTarget(warm), false);
  });

  it('rejects null / non-object / empty', () => {
    assert.equal(isColdStartTarget(null), false);
    assert.equal(isColdStartTarget(undefined), false);
    assert.equal(isColdStartTarget('coldStart'), false);
    assert.equal(isColdStartTarget({}), false);
  });

  it('rejects a cold-start shape with missing channel or bad recipient', () => {
    assert.equal(
      isColdStartTarget({
        kind: COLD_START_TARGET_KIND,
        channel: '',
        recipient: { by: 'email', email: 'a@b.de' },
      }),
      false,
    );
    assert.equal(
      isColdStartTarget({
        kind: COLD_START_TARGET_KIND,
        channel: 'teams',
        recipient: { by: 'phone', phone: '123' },
      }),
      false,
    );
  });
});

describe('routineTarget — isRoutineRecipient', () => {
  it('accepts email and aadObjectId variants', () => {
    assert.equal(isRoutineRecipient({ by: 'email', email: 'a@b.de' }), true);
    assert.equal(
      isRoutineRecipient({ by: 'aadObjectId', aadObjectId: 'g' }),
      true,
    );
  });

  it('rejects empty values and unknown discriminators', () => {
    assert.equal(isRoutineRecipient({ by: 'email', email: '' }), false);
    assert.equal(isRoutineRecipient({ by: 'aadObjectId', aadObjectId: '' }), false);
    assert.equal(isRoutineRecipient({ by: 'sms' }), false);
    assert.equal(isRoutineRecipient(null), false);
  });
});

describe('routineTarget — normaliseRecipientEmail', () => {
  it('trims and lowercases a valid email', () => {
    assert.equal(normaliseRecipientEmail('  Marcel@Byte5.DE '), 'marcel@byte5.de');
  });

  it('rejects malformed input', () => {
    assert.equal(normaliseRecipientEmail('not-an-email'), null);
    assert.equal(normaliseRecipientEmail('a@b'), null);
    assert.equal(normaliseRecipientEmail('a@@b.de'), null);
    assert.equal(normaliseRecipientEmail('a b@c.de'), null);
    assert.equal(normaliseRecipientEmail(''), null);
  });
});

describe('routineTarget — buildEmailColdStartTarget', () => {
  it('builds a bare-orchestrator target by default and normalises the email', () => {
    const target = buildEmailColdStartTarget({
      channel: 'teams',
      email: '  Marcel@Byte5.DE ',
      createdBy: { tenant: 't1', userId: 'u1' },
    });
    assert.ok(target);
    assert.equal(target.kind, COLD_START_TARGET_KIND);
    assert.equal(target.channel, 'teams');
    assert.equal(target.orchestratorProfile, 'bare');
    assert.deepEqual(target.recipient, { by: 'email', email: 'marcel@byte5.de' });
    assert.deepEqual(target.createdBy, { tenant: 't1', userId: 'u1' });
    assert.equal(isColdStartTarget(target), true);
  });

  it('honours an explicit orchestratorProfile override', () => {
    const target = buildEmailColdStartTarget({
      channel: 'teams',
      email: 'a@b.de',
      createdBy: { tenant: 't1', userId: 'u1' },
      orchestratorProfile: 'inherit',
    });
    assert.equal(target?.orchestratorProfile, 'inherit');
  });

  it('returns null for an invalid email', () => {
    const target = buildEmailColdStartTarget({
      channel: 'teams',
      email: 'nope',
      createdBy: { tenant: 't1', userId: 'u1' },
    });
    assert.equal(target, null);
  });
});
