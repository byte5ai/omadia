/**
 * Unit tests for the loading screen's decision logic (#935, #936 / OM-59, OM-60).
 *
 * `bootView.js` is a classic script, not a module: the renderer runs under a
 * strict CSP (`script-src 'self'`, no modules) and the repo has no jsdom and no
 * budget for a new dependency. So it attaches to `window`, and these tests load
 * it in a `node:vm` context with a stub window. That covers the ordering and the
 * localization fallbacks — the part worth testing — without a DOM.
 *
 * FIXTURE PROVENANCE, deliberately checked rather than invented: the progress
 * payload shape is `{ phase, message, detail? }` from `BootProgress` in
 * `src/supervisor.ts`, and the log-line shape is `{ level, msg }` with level
 * `'INFO' | 'WARN' | 'ERROR'` from `BootLogLine` in `src/ipcTypes.ts`. A fixture
 * modelling a shape the runtime never produces would hide the very bug it claims
 * to cover.
 */
import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

interface BootViewApi {
  readonly MAX_LOG_ROWS: number;
  readonly UNKNOWN_PHASE_PERCENT: number;
  phasePercent(phase: string): number;
  phaseMessage(
    progress: { phase?: string; message?: string; detail?: string },
    translate: (key: string, fallback: string) => string,
  ): string;
  logLineClass(level: string): string;
  shouldAutoRevealDetails(level: string): boolean;
  detailSummaryLabel(count: number, translate: (key: string, fallback: string) => string): string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
let view: BootViewApi;

/** The German entries the shipped dictionary actually carries, for realism. */
const DE: Record<string, string> = {
  'boot.starting-db': 'Eingebettete Datenbank wird gestartet…',
  'boot.ready': 'omadia ist bereit.',
  'loading.details.empty': 'Startprotokoll',
  'loading.details.count': 'Startprotokoll ({count} Zeilen)',
};

const german = (key: string, fallback: string): string => DE[key] ?? fallback;
const english = (_key: string, fallback: string): string => fallback;

before(() => {
  const source = fs.readFileSync(
    path.join(here, '..', 'src', 'renderer', 'bootView.js'),
    'utf8',
  );
  const window: Record<string, unknown> = {};
  vm.runInNewContext(source, { window, globalThis: window });
  view = window['omadiaBootView'] as BootViewApi;
  assert.ok(view, 'bootView.js must attach omadiaBootView to window');
});

describe('bootView.phasePercent', () => {
  it('maps every supervisor BootPhase to its own percentage', () => {
    // Per-phase equality, not a range. The first draft asserted only
    // `pct > 0 && pct <= 100`, which the UNKNOWN_PHASE_PERCENT fallback of 10
    // satisfies — so emptying PHASE_PERCENT entirely left this test green. It
    // claimed to check the mapping and checked nothing of the sort.
    const expected: Readonly<Record<string, number>> = {
      'starting-db': 15,
      'starting-kernel': 35,
      'waiting-kernel': 60,
      'starting-ui': 85,
      ready: 100,
      error: 100,
    };
    // The full union from src/supervisor.ts BootPhase.
    for (const [phase, pct] of Object.entries(expected)) {
      assert.equal(view.phasePercent(phase), pct, `${phase} must map to ${pct}`);
      assert.notEqual(
        view.phasePercent(phase),
        view.UNKNOWN_PHASE_PERCENT,
        `${phase} must be a real entry, not the unknown-phase fallback`,
      );
    }
  });

  it('advances monotonically through the boot', () => {
    // Pairwise on purpose: `a < b < c` in JS is `(a < b) < c`, which coerces the
    // boolean and passes for ANY values. The first draft of this test did that
    // and asserted nothing. What caught it was running `tsc` over these files by
    // hand (TS2365) — NOT anything in the repo's normal loop: `npm test` uses
    // Node's type STRIPPING, which checks nothing, and the root tsconfig covers
    // only `src/**/*.ts`. #932 wires a real `typecheck:test` job; until that is
    // in, a test file here can type-lie and still go green.
    const order = ['starting-db', 'starting-kernel', 'waiting-kernel', 'starting-ui', 'ready'];
    for (let i = 1; i < order.length; i += 1) {
      const previous = view.phasePercent(order[i - 1] as string);
      const current = view.phasePercent(order[i] as string);
      assert.ok(previous < current, `${order[i - 1]} (${previous}) must precede ${order[i]} (${current})`);
    }
    assert.equal(view.phasePercent('ready'), 100);
  });

  it('moves the bar off zero for an unknown phase instead of looking frozen', () => {
    assert.equal(view.phasePercent('a-phase-added-later'), view.UNKNOWN_PHASE_PERCENT);
    assert.ok(view.UNKNOWN_PHASE_PERCENT > 0);
  });
});

describe('bootView.phaseMessage — OM-59', () => {
  it('prefers the shared boot.* dictionary entry over the raw English message', () => {
    const shown = view.phaseMessage(
      { phase: 'starting-db', message: 'Starting embedded database…' },
      german,
    );
    assert.equal(shown, 'Eingebettete Datenbank wird gestartet…');
  });

  it("falls back to the supervisor's message for a phase no dictionary knows", () => {
    // The whole fix is the ORDERING: raw English becomes the last resort.
    const shown = view.phaseMessage({ phase: 'brand-new', message: 'Raw English text' }, german);
    assert.equal(shown, 'Raw English text');
  });

  it('renders English when no translation is active', () => {
    const shown = view.phaseMessage(
      { phase: 'starting-db', message: 'Starting embedded database…' },
      english,
    );
    assert.equal(shown, 'Starting embedded database…');
  });

  it('appends the optional detail the supervisor may attach', () => {
    const shown = view.phaseMessage(
      { phase: 'ready', message: 'omadia is ready.', detail: 'port 7777' },
      german,
    );
    assert.equal(shown, 'omadia ist bereit. — port 7777');
  });

  it('does not append a separator when there is no detail', () => {
    const shown = view.phaseMessage({ phase: 'ready', message: 'omadia is ready.' }, german);
    assert.doesNotMatch(shown, /—/);
  });

  it('survives a payload with no phase', () => {
    assert.equal(view.phaseMessage({ message: 'only a message' }, german), 'only a message');
  });
});

describe('bootView log presentation — OM-60', () => {
  it('classes errors and warnings, leaving info unstyled', () => {
    assert.equal(view.logLineClass('ERROR'), 'l-err');
    assert.equal(view.logLineClass('WARN'), 'l-warn');
    assert.equal(view.logLineClass('INFO'), '');
  });

  it('opens the collapsed detail view for an ERROR', () => {
    // Hiding the one line that explains a stuck boot behind a disclosure would
    // recreate the original complaint in a new place.
    assert.equal(view.shouldAutoRevealDetails('ERROR'), true);
  });

  it('leaves it collapsed for a WARN, which is routine developer noise here', () => {
    // The boot legitimately reports disabled optional integrations as warnings —
    // exactly the `.env` chatter OM-60 is about. Promoting them defeats the fix.
    assert.equal(view.shouldAutoRevealDetails('WARN'), false);
    assert.equal(view.shouldAutoRevealDetails('INFO'), false);
  });

  it('labels the disclosure with a line count so a stuck boot looks different', () => {
    assert.equal(view.detailSummaryLabel(12, german), 'Startprotokoll (12 Zeilen)');
    assert.equal(view.detailSummaryLabel(12, english), 'Startup log (12 lines)');
  });

  it('uses the empty label before anything has been logged', () => {
    assert.equal(view.detailSummaryLabel(0, german), 'Startprotokoll');
    assert.equal(view.detailSummaryLabel(-1, german), 'Startprotokoll');
  });

  it('caps retained log rows so a long boot cannot grow the DOM forever', () => {
    assert.ok(view.MAX_LOG_ROWS > 0 && view.MAX_LOG_ROWS <= 1000);
  });
});
