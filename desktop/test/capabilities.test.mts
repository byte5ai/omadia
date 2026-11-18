/**
 * The first-run capability switches as data: what counts as a valid selection,
 * which kernel env each switch produces, and how the kernel's `/health` answer
 * is judged against what the switch asked for.
 *
 * The switches used to be write-only: the wizard stored them in setup.json and
 * nothing read them back, so every choice booted the same stack. The wiring is
 * pinned in `supervisorKernelEnv.test.mts`; this file pins the rules it uses.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CAPABILITY_ENV_KEYS,
  DEFAULT_CAPABILITIES,
  attachmentReadiness,
  capabilityKernelEnv,
  parseCapabilities,
  withoutCapabilityEnv,
} from '../src/capabilities.ts';

const DIRS = { attachments: '/Users/someone/omadia/attachments' };

describe('parseCapabilities', () => {
  it('accepts a selection with a boolean attachments switch', () => {
    assert.deepEqual(parseCapabilities({ attachments: true }), { attachments: true });
    assert.deepEqual(parseCapabilities({ attachments: false }), { attachments: false });
  });

  it('keeps only the switches that exist, dropping keys older builds stored', () => {
    assert.deepEqual(
      parseCapabilities({ attachments: false, embeddings: true, diagrams: true }),
      { attachments: false },
    );
  });

  it('rejects anything that is not a selection', () => {
    for (const bad of [null, undefined, 'attachments', 1, [], {}, { attachments: 'yes' }, { attachments: 1 }]) {
      assert.equal(parseCapabilities(bad), null, JSON.stringify(bad));
    }
  });

  it('starts a fresh install with attachments on, like the pre-ticked checkbox', () => {
    assert.deepEqual(DEFAULT_CAPABILITIES, { attachments: true });
  });
});

describe('capabilityKernelEnv', () => {
  it('points ATTACHMENT_STORE_DIR at the data folder when attachments are on', () => {
    assert.deepEqual(capabilityKernelEnv({ attachments: true }, DIRS), {
      ATTACHMENT_STORE_DIR: DIRS.attachments,
    });
  });

  it('sets nothing when attachments are off', () => {
    assert.deepEqual(capabilityKernelEnv({ attachments: false }, DIRS), {});
  });

  it('only ever produces keys the switches own', () => {
    for (const attachments of [true, false]) {
      for (const key of Object.keys(capabilityKernelEnv({ attachments }, DIRS))) {
        assert.ok(CAPABILITY_ENV_KEYS.includes(key), key);
      }
    }
  });
});

describe('withoutCapabilityEnv', () => {
  it('drops an inherited value for every key a switch owns, and nothing else', () => {
    const inherited = { PATH: '/usr/bin', ATTACHMENT_STORE_DIR: '/somewhere/else', HOME: '/Users/x' };
    const out = withoutCapabilityEnv(inherited);
    assert.equal('ATTACHMENT_STORE_DIR' in out, false);
    assert.equal(out['PATH'], '/usr/bin');
    assert.equal(out['HOME'], '/Users/x');
    // A copy: the process env it was handed stays as it was.
    assert.equal(inherited.ATTACHMENT_STORE_DIR, '/somewhere/else');
  });
});

describe('attachmentReadiness — the switch against what /health reports', () => {
  const health = (store: unknown): unknown => ({ status: 'ok', attachments: { store } });

  it('is honoured when the switch is on and the kernel runs the local store', () => {
    const v = attachmentReadiness(true, health('filesystem'));
    assert.equal(v.honoured, true);
    assert.match(v.message, /attachments/i);
  });

  it('is honoured, and says so, when S3 from the environment takes precedence', () => {
    const v = attachmentReadiness(true, health('s3'));
    assert.equal(v.honoured, true);
    assert.match(v.message, /S3/);
  });

  it('is not honoured when the switch is on and the kernel has no store', () => {
    const v = attachmentReadiness(true, health('none'));
    assert.equal(v.honoured, false);
    assert.match(v.message, /no attachment store/i);
  });

  it('is not honoured when the kernel did not report a store at all', () => {
    for (const body of [null, undefined, 'ok', {}, { status: 'ok' }, health(42), health('ftp')]) {
      const v = attachmentReadiness(true, body);
      assert.equal(v.honoured, false, JSON.stringify(body));
      assert.match(v.message, /did not report/i);
    }
  });

  it('is honoured when the switch is off and the kernel keeps nothing locally', () => {
    assert.equal(attachmentReadiness(false, health('none')).honoured, true);
    assert.equal(attachmentReadiness(false, health('s3')).honoured, true);
    // Nothing was asked for, so an unreadable answer is no broken promise.
    assert.equal(attachmentReadiness(false, null).honoured, true);
  });

  it('is not honoured when the switch is off but the kernel still stores locally', () => {
    const v = attachmentReadiness(false, health('filesystem'));
    assert.equal(v.honoured, false);
    assert.match(v.message, /switched off/i);
  });
});
