/**
 * The ingest gate for Tailwind arbitrary values (epic #470 C8 / §4.3a).
 *
 * The scanner is the enforcement half of "plugins ship no CSS": the stylesheet
 * core serves carries a finite vocabulary, so a class outside it renders
 * unstyled with no error anywhere. These cases pin both directions — what must
 * be rejected, and what must NOT be, because a scanner that cries wolf on
 * ordinary bundle text gets switched off and then enforces nothing.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  formatArbitraryValueOffenders,
  scanForArbitraryTailwindValues,
} from '../src/plugins/tailwindArbitraryValueScan.js';

function scan(content: string, file = 'ui/assets/app-1234abcd.js') {
  return scanForArbitraryTailwindValues([{ path: file, content }]);
}

describe('scanForArbitraryTailwindValues — rejects', () => {
  it('an arbitrary length', () => {
    const found = scan('const c = "flex w-[137px] p-4";');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.token, 'w-[137px]');
    assert.equal(found[0]?.kind, 'arbitrary-value');
  });

  it('an arbitrary colour — the case the vocabulary exists to prevent', () => {
    const found = scan('e.className = "bg-[#abc] text-fg";');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.token, 'bg-[#abc]');
  });

  it('a dashed utility head with an arbitrary track list', () => {
    const found = scan('"grid grid-cols-[1fr_2fr] gap-4"');
    assert.equal(found[0]?.token, 'grid-cols-[1fr_2fr]');
  });

  it('an arbitrary value behind variant prefixes', () => {
    const found = scan('"md:hover:w-[42rem]"');
    assert.equal(found[0]?.token, 'md:hover:w-[42rem]');
  });

  it('an arbitrary variant', () => {
    const found = scan('"[&>tr]:border-border"');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.kind, 'arbitrary-variant');
  });

  it('reports the 1-based line and the file', () => {
    const found = scan('a\nb\nconst c = "p-[3px]";\n', 'ui/main-99887766.js');
    assert.equal(found[0]?.line, 3);
    assert.equal(found[0]?.file, 'ui/main-99887766.js');
  });

  it('caps the offender list so a hostile bundle cannot become the payload', () => {
    const line = Array.from({ length: 200 }, (_, i) => `w-[${String(i)}px]`).join(' ');
    const found = scan(line);
    assert.ok(found.length <= 25, `expected <= 25 offenders, got ${String(found.length)}`);
  });

  it('deduplicates the same token on the same line', () => {
    const found = scan('"w-[1px] w-[1px] w-[1px]"');
    assert.equal(found.length, 1);
  });
});

describe('scanForArbitraryTailwindValues — accepts', () => {
  it('the whole proof bundle vocabulary', () => {
    const bundle = [
      'const CARD = "rounded-md border border-border bg-bg-elevated p-4 shadow-sm";',
      'const H = "text-lg font-semibold text-fg-strong";',
      'const B = "hover:bg-accent-hover disabled:opacity-50 md:grid-cols-2";',
      'grid.className = "grid grid-cols-1 gap-4 max-w-4xl mx-auto";',
    ].join('\n');
    assert.deepEqual(scan(bundle), []);
  });

  it('array indexing — the obvious false positive', () => {
    assert.deepEqual(scan('const x = arr[0] + items[i] + m[key];'), []);
  });

  it('property access on a dashed-looking identifier', () => {
    assert.deepEqual(scan('const v = obj["data-theme"]; const w = a[b];'), []);
  });

  it('a regex character class', () => {
    assert.deepEqual(scan('const re = /^[a-z0-9]+$/;'), []);
  });

  it('a destructured import with brackets', () => {
    assert.deepEqual(scan('const [state, setState] = useState(0);'), []);
  });

  it('an empty bundle list', () => {
    assert.deepEqual(scanForArbitraryTailwindValues([]), []);
  });
});

describe('formatArbitraryValueOffenders', () => {
  it('renders one line per offender with file, line and token', () => {
    const rendered = formatArbitraryValueOffenders(scan('"w-[137px]"'));
    assert.match(rendered, /ui\/assets\/app-1234abcd\.js:1 — w-\[137px\] \(arbitrary-value\)/);
  });
});

describe('documented limits — pinned so the next reader is not misled', () => {
  it('cannot see a class assembled at runtime (accepted false negative)', () => {
    assert.deepEqual(scan('const c = "w-[" + n + "px]";'), []);
  });

  it('matches bracket text that is not a class (accepted false positive)', () => {
    // Reported on purpose: the offender line carries file+line+token so an
    // author can see at a glance that the hit is not a class name. Widening
    // the regex to exclude this would also start missing real offenders.
    const found = scan('const msg = "see step-[2] of the guide";');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.token, 'step-[2]');
  });
});
