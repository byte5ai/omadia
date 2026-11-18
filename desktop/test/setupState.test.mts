/**
 * setup.json keeps the capability switches the supervisor actually reads.
 *
 * Installs since the first desktop build stored three switches
 * (`{ embeddings, diagrams, attachments }`). Only `attachments` reaches the
 * kernel now. `readSetup()` must still load such a file, keep the user's
 * attachments choice, and drop the two dead keys so the next `writeSetup()`
 * stops carrying them. It used to merge them back in on every read.
 *
 * The electron fake gives `app.getPath('userData')` a fresh temp dir per test
 * process, which is where `setupFile()` points.
 */
import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';

import { readSetup, writeSetup } from '../src/setupState.ts';
import { setupFile } from '../src/paths.ts';

function writeRaw(value: unknown): void {
  fs.writeFileSync(setupFile(), JSON.stringify(value), 'utf8');
}

afterEach(() => {
  fs.rmSync(setupFile(), { force: true });
});

const LEGACY = {
  configured: true,
  completed: true,
  llmProvider: 'anthropic',
  capabilities: { embeddings: true, diagrams: true, attachments: false },
  recoveryKeyShown: false,
};

describe('readSetup — capability switches', () => {
  it('keeps the attachments choice of an existing install and drops the dead keys', () => {
    writeRaw(LEGACY);
    const setup = readSetup();
    assert.deepEqual(setup.capabilities, { attachments: false });
    // Everything else of the old file survives.
    assert.equal(setup.completed, true);
    assert.equal(setup.configured, true);
    assert.equal(setup.llmProvider, 'anthropic');
  });

  it('stops persisting the dead keys on the next write', () => {
    writeRaw(LEGACY);
    writeSetup(readSetup());
    const raw = fs.readFileSync(setupFile(), 'utf8');
    assert.doesNotMatch(raw, /embeddings|diagrams/);
    assert.deepEqual((JSON.parse(raw) as { capabilities: unknown }).capabilities, { attachments: false });
  });

  it('falls back to attachments on for a missing or malformed selection', () => {
    for (const capabilities of [undefined, null, 'on', { attachments: 'yes' }, { embeddings: true }]) {
      writeRaw({ ...LEGACY, capabilities });
      assert.deepEqual(readSetup().capabilities, { attachments: true }, JSON.stringify(capabilities));
    }
  });

  it('starts a fresh install with attachments on', () => {
    assert.equal(fs.existsSync(setupFile()), false);
    assert.deepEqual(readSetup().capabilities, { attachments: true });
  });
});
