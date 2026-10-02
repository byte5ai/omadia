/**
 * #1071 — composition-root wiring the unit suites cannot see.
 *
 * `webChatProactiveSender.test.ts` and `routineWebDelivery.test.ts` prove the
 * web-chat sender delivers a routine's output into the originating chat
 * session. Both stay green if `src/index.ts` never hands that sender to
 * `initRoutines` — and then `manage_routine create` from the browser fails
 * again with "no proactive sender for channel 'web'", which is exactly the
 * #1071 bug. `src/index.ts` boots the whole middleware on import, so, like
 * `778RouteMounts.wiring.test.ts` and `providerPoolInvalidation.wiring.test.ts`,
 * this pins the wiring from the source text.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const middlewareRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Line comments stripped: a sender that only survives in a `//` comment must
// not satisfy these checks.
const src = readFileSync(resolve(middlewareRoot, 'src', 'index.ts'), 'utf8')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

const INIT_ROUTINES_ANCHOR = 'routinesHandle = await initRoutines({';
const GRAPH_POOL_GUARD = 'if (graphPool) {';

/** Index just past the brace that closes the one opened at `openIdx`. */
function matchingBraceEnd(openIdx: number): number {
  assert.equal(src[openIdx], '{', 'expected an opening brace');
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  assert.fail(`unbalanced braces after offset ${openIdx} in src/index.ts`);
}

/** The `initRoutines({ … })` options object literal, braces included. */
function initRoutinesOptions(): { start: number; text: string } {
  const callIdx = src.indexOf(INIT_ROUTINES_ANCHOR);
  assert.notEqual(callIdx, -1, `src/index.ts no longer contains \`${INIT_ROUTINES_ANCHOR}\``);
  const openIdx = callIdx + INIT_ROUTINES_ANCHOR.length - 1;
  return { start: callIdx, text: src.slice(openIdx, matchingBraceEnd(openIdx)) };
}

describe('#1071 boot wiring — routines get the web-chat proactive sender', () => {
  it('imports createWebChatProactiveSender from ./plugins/routines/index.js', () => {
    const routinesImport = /import\s*\{([^}]*)\}\s*from\s*'\.\/plugins\/routines\/index\.js';/.exec(src);
    assert.ok(routinesImport, "src/index.ts must import from './plugins/routines/index.js'");
    assert.match(
      routinesImport[1] ?? '',
      /\bcreateWebChatProactiveSender\b/,
      "createWebChatProactiveSender must be imported from './plugins/routines/index.js'",
    );
  });

  it('passes createWebChatProactiveSender({ getStore: getChatSessionStore … }) in proactiveSenders', () => {
    const { text } = initRoutinesOptions();
    const sendersIdx = text.indexOf('proactiveSenders: [');
    assert.notEqual(
      sendersIdx,
      -1,
      'initRoutines({ … }) must receive a live `proactiveSenders: [ … ]` array',
    );
    const arrayOpen = sendersIdx + 'proactiveSenders: '.length;
    let depth = 0;
    let arrayEnd = -1;
    for (let i = arrayOpen; i < text.length; i += 1) {
      if (text[i] === '[') depth += 1;
      else if (text[i] === ']') {
        depth -= 1;
        if (depth === 0) {
          arrayEnd = i + 1;
          break;
        }
      }
    }
    assert.notEqual(arrayEnd, -1, 'proactiveSenders array is not closed');
    assert.match(
      text.slice(arrayOpen, arrayEnd),
      /createWebChatProactiveSender\(\{\s*getStore:\s*getChatSessionStore\b/,
      "proactiveSenders must contain createWebChatProactiveSender({ getStore: getChatSessionStore, … }) — without it every browser-created routine fails with \"no proactive sender for channel 'web'\" (#1071)",
    );
  });

  it('calls initRoutines inside the `if (graphPool) {` block', () => {
    const { start } = initRoutinesOptions();
    const guardIdx = src.lastIndexOf(GRAPH_POOL_GUARD, start);
    assert.notEqual(guardIdx, -1, `initRoutines must be preceded by \`${GRAPH_POOL_GUARD}\``);
    const blockOpen = guardIdx + GRAPH_POOL_GUARD.length - 1;
    const blockEnd = matchingBraceEnd(blockOpen);
    assert.ok(
      start > blockOpen && start < blockEnd,
      'initRoutines({ … }) must sit inside the `if (graphPool) { … }` block — routines persist in the graph pool',
    );
  });
});
