/**
 * What the setup wizard offers, and what it hands main when setup finishes.
 *
 * The wizard used to offer three capability switches (attachments, semantic
 * memory, diagrams). main stored them in setup.json and the supervisor never
 * read them, so every choice booted the same stack. Attachments now reach the
 * kernel as `ATTACHMENT_STORE_DIR` (`capabilities.ts`, pinned in
 * `supervisorKernelEnv.test.mts`). Semantic memory and diagrams cannot be
 * switched on from here: the embedding weights are fetched from the admin
 * page, and diagrams need a Kroki server and S3 storage the desktop does not
 * ship. So the wizard no longer offers them, and says where they live instead.
 *
 * Like `logHint.test.mts`, the page scripts run in a `node:vm` context under a
 * stub DOM; the markup is checked as text.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const rendererDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const read = (file: string): string => fs.readFileSync(path.join(rendererDir, file), 'utf8');
const html = read('wizard.html');
const wizardJs = read('wizard.js');
const i18nJs = read('wizard-i18n.js');

interface StubElement {
  textContent: string;
  className: string;
  value: string;
  checked: boolean;
  [member: string]: unknown;
}

function stubElement(): StubElement {
  const classes = new Set<string>();
  return {
    textContent: '',
    className: '',
    value: '',
    checked: false,
    style: {},
    dataset: {},
    childElementCount: 0,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      toggle: (c: string, on?: boolean) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
    },
    addEventListener: () => {},
    appendChild: () => {},
  };
}

/** Run the wizard's scripts with some elements pre-set, and return its `collectConfig`. */
function wizardWith(preset: Record<string, Partial<StubElement>>): () => unknown {
  const els = new Map<string, StubElement>();
  const el = (id: string): StubElement => {
    if (!els.has(id)) els.set(id, { ...stubElement(), ...(preset[id] ?? {}) });
    return els.get(id) as StubElement;
  };
  const bridge = { complete: async () => ({ ok: true }), onBootProgress: () => () => {}, onBootLog: () => () => {} };
  const context = vm.createContext({
    window: { omadia: bridge, location: { search: '', hash: '' } },
    navigator: { language: 'en-US' },
    document: {
      body: el('body'),
      getElementById: el,
      querySelector: (sel: string) => el(sel.replace(/^#/, '')),
      querySelectorAll: () => [],
      createElement: stubElement,
    },
    URLSearchParams,
    setInterval,
    clearInterval,
  });
  vm.runInContext(i18nJs, context);
  vm.runInContext(wizardJs, context);
  const collect = context['collectConfig'];
  assert.equal(typeof collect, 'function', 'wizard.js must declare collectConfig()');
  // A JSON round trip moves the payload out of the vm realm, so deepEqual
  // compares values rather than prototypes.
  return () => JSON.parse(JSON.stringify((collect as () => unknown)()));
}

const API_KEY_SETUP = {
  provider: { value: 'anthropic' },
  apiKey: { value: 'sk-synthetic-test-key' },
};

describe('the payload the wizard sends to main (collectConfig)', () => {
  it('sends exactly provider, apiKey, capabilities and dataDir', () => {
    const config = wizardWith({ ...API_KEY_SETUP, capAttachments: { checked: true } })() as Record<string, unknown>;
    assert.deepEqual(Object.keys(config).sort(), ['apiKey', 'capabilities', 'dataDir', 'provider']);
    assert.equal(config['provider'], 'anthropic');
    assert.equal(config['apiKey'], 'sk-synthetic-test-key');
  });

  it('carries the attachments switch as ticked, and no other switch', () => {
    for (const checked of [true, false]) {
      const config = wizardWith({ ...API_KEY_SETUP, capAttachments: { checked } })() as {
        capabilities: unknown;
      };
      assert.deepEqual(config.capabilities, { attachments: checked });
    }
  });
});

describe('wizard.html offers only switches the supervisor wires', () => {
  const checkboxIds = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map(
    (m) => /id="([^"]+)"/.exec(m[0])?.[1],
  );

  it('has one capability checkbox, attachments, pre-ticked', () => {
    assert.deepEqual(checkboxIds, ['capAttachments']);
    assert.match(html, /<input type="checkbox" id="capAttachments" checked \/>/);
  });

  it('reads every checkbox it offers into the payload', () => {
    for (const id of checkboxIds) {
      assert.ok(wizardJs.includes(`$('#${id}').checked`), `${id} is offered but never sent`);
    }
  });

  it('no longer offers semantic memory or diagrams as switches', () => {
    assert.doesNotMatch(html, /id="capEmbeddings"|id="capDiagrams"/);
    assert.doesNotMatch(html, /data-i18n="caps\.(embeddings|diagrams)/);
    assert.doesNotMatch(wizardJs, /capEmbeddings|capDiagrams|embeddings:|diagrams:/);
  });

  it('says where semantic memory and diagrams are set up instead', () => {
    assert.match(html, /data-i18n="caps\.later"/);
  });

  it('does not promise the choice can be changed later', () => {
    // There is no settings path after setup; the old lead text said otherwise.
    assert.doesNotMatch(html, /change these later/i);
    assert.doesNotMatch(i18nJs, /jederzeit ändern/);
  });
});

describe('rail, sections and LAST_STEP agree', () => {
  const railSteps = [...html.matchAll(/<li data-step="(\d+)"/g)].map((m) => Number(m[1]));
  const sectionSteps = [...html.matchAll(/<section class="step[^"]*" data-step="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => s !== 'provision')
    .map(Number);
  const lastStep = Number(/const LAST_STEP = (\d+);/.exec(wizardJs)?.[1]);

  it('numbers the rail 0..n without gaps', () => {
    assert.deepEqual(railSteps, railSteps.map((_s, i) => i));
  });

  it('has one section per rail item', () => {
    assert.deepEqual(sectionSteps, railSteps);
  });

  it('finishes on the last rail item', () => {
    assert.equal(lastStep, railSteps.length - 1);
  });
});

describe('the German overlay matches the markup', () => {
  const germanKeys = [...i18nJs.matchAll(/^\s*'([a-zA-Z][\w.-]*)':/gm)].map((m) => m[1] as string);
  const markupKeys = [...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map((m) => m[1] as string);

  it('translates every marked-up string', () => {
    for (const key of markupKeys) assert.ok(germanKeys.includes(key), `no German text for ${key}`);
  });

  it('keeps no capability-step strings the markup no longer uses', () => {
    for (const key of germanKeys.filter((k) => k.startsWith('caps.'))) {
      assert.ok(markupKeys.includes(key), `orphan German string ${key}`);
    }
  });
});
