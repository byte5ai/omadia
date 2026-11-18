/**
 * The wizard's recovery-key step, run as the page script under a stub DOM.
 *
 * The key on screen must be the key of the folder setup completes with: it is
 * asked for with the wizard's `dataDir`, hidden again when another folder is
 * chosen, and "Copy" copies exactly what is shown. Main's side of that (the key
 * of a folder that already holds a blob) is pinned in `ipcRegistration.test.mts`
 * and `secrets.test.mts`.
 *
 * Like `wizardConfig.test.mts`, the script runs in a `node:vm` context; this
 * stub also records click listeners so the buttons can be pressed.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const wizardJs = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'wizard.js'),
  'utf8',
);

const MASK = '••••••••';

type Listener = (event: unknown) => unknown;

interface StubElement {
  textContent: string;
  value: string;
  listeners: Listener[];
  [member: string]: unknown;
}

function stubElement(): StubElement {
  const listeners: Listener[] = [];
  return {
    textContent: '',
    className: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    listeners,
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'click') listeners.push(fn);
    },
  };
}

interface Bridge {
  chooseDataDir(): Promise<string | null>;
  exportRecoveryKey(dataDir: string | null): Promise<string>;
}

function runWizard(bridge: Bridge) {
  const els = new Map<string, StubElement>();
  const el = (id: string): StubElement => {
    if (!els.has(id)) els.set(id, stubElement());
    return els.get(id) as StubElement;
  };
  el('recoveryKey').textContent = MASK;
  const copied: string[] = [];
  const context = vm.createContext({
    window: { omadia: bridge, location: { search: '', hash: '' } },
    navigator: {
      language: 'en-US',
      clipboard: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    },
    document: {
      body: el('body'),
      getElementById: el,
      querySelector: (sel: string) => el(sel.replace(/^#/, '')),
      querySelectorAll: () => [],
    },
  });
  vm.runInContext(wizardJs, context);
  const click = async (id: string): Promise<void> => {
    await Promise.all(el(id).listeners.map((fn) => fn({})));
  };
  return { el, click, copied };
}

/** A bridge whose picker answers `picks` in order and whose keys are named after the folder. */
function bridgeFor(picks: Array<string | null>, requested: Array<string | null>): Bridge {
  return {
    chooseDataDir: async () => picks.shift() ?? null,
    exportRecoveryKey: async (dataDir) => {
      requested.push(dataDir);
      return `key-of-${dataDir ?? 'default'}`;
    },
  };
}

describe('wizard recovery key: shown and copied for the folder setup uses', () => {
  it('asks for the key of the chosen folder and copies exactly what it shows', async () => {
    const requested: Array<string | null> = [];
    const page = runWizard(bridgeFor(['/data/earlier-install'], requested));

    await page.click('chooseDir');
    await page.click('revealKey');
    assert.deepEqual(requested, ['/data/earlier-install']);
    assert.equal(page.el('recoveryKey').textContent, 'key-of-/data/earlier-install');

    await page.click('revealKey');
    assert.deepEqual(page.copied, ['key-of-/data/earlier-install']);
    assert.deepEqual(requested, ['/data/earlier-install'], 'copying does not ask again');
  });

  it('asks with null while the default folder is kept', async () => {
    const requested: Array<string | null> = [];
    const page = runWizard(bridgeFor([], requested));
    await page.click('revealKey');
    assert.deepEqual(requested, [null]);
    assert.equal(page.el('recoveryKey').textContent, 'key-of-default');
  });

  it('hides a shown key when another folder is chosen, so the old one cannot be copied', async () => {
    const requested: Array<string | null> = [];
    const page = runWizard(bridgeFor(['/data/other'], requested));

    await page.click('revealKey');
    assert.equal(page.el('recoveryKey').textContent, 'key-of-default');

    await page.click('chooseDir');
    assert.equal(page.el('recoveryKey').textContent, MASK, 'the key is hidden again');
    assert.equal(page.el('revealKey').textContent, 'Reveal');

    await page.click('revealKey');
    await page.click('revealKey');
    assert.deepEqual(requested, [null, '/data/other']);
    assert.deepEqual(page.copied, ['key-of-/data/other']);
  });

  it('keeps a shown key when the picker is cancelled', async () => {
    const requested: Array<string | null> = [];
    const page = runWizard(bridgeFor([null], requested));
    await page.click('revealKey');
    await page.click('chooseDir');
    assert.equal(page.el('recoveryKey').textContent, 'key-of-default');
    await page.click('revealKey');
    assert.deepEqual(page.copied, ['key-of-default']);
  });

  it('drops a key that arrives after another folder was chosen', async () => {
    let answer: (key: string) => void = () => {};
    const requested: Array<string | null> = [];
    const page = runWizard({
      chooseDataDir: async () => '/data/other',
      exportRecoveryKey: (dataDir) => {
        requested.push(dataDir);
        return dataDir === null
          ? new Promise<string>((resolve) => {
              answer = resolve;
            })
          : Promise.resolve(`key-of-${dataDir}`);
      },
    });

    const slow = page.click('revealKey');
    await page.click('chooseDir');
    answer('key-of-default');
    await slow;
    assert.equal(page.el('recoveryKey').textContent, MASK, 'the late key is not shown');

    await page.click('revealKey');
    assert.deepEqual(requested, [null, '/data/other']);
    assert.equal(page.el('recoveryKey').textContent, 'key-of-/data/other');
  });

  it('shows the reason when main cannot give a key, and copies nothing', async () => {
    const page = runWizard({
      chooseDataDir: async () => null,
      exportRecoveryKey: async () => {
        throw new Error('omadia could not open its secrets file');
      },
    });
    await page.click('revealKey');
    assert.match(page.el('recoveryKey').textContent, /^unavailable — omadia could not open its secrets file/);
    assert.deepEqual(page.copied, []);
  });
});
