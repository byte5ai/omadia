/**
 * Privacy Shield v4 — canvas-turn latency.
 *
 *   - The canvas producer tools (`canvas_publish_rows` / `_choice` /
 *     `_lumen`) are still INTERNED (their datasetId path carries real rows),
 *     but skip the Haiku schema classifier: its verdict only feeds the
 *     receipt's identity count, and the rows were classified when their
 *     source tool result was interned.
 *   - The C1 sidecar call logs its wall time, on success and on failure, so
 *     a slow GLiNER pass is visible in the turn log.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PromptPiiDetector } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const ROWS = [
  { employee: 'Marvin Vomberg', employee_id: 7, birthday: '1990-01-04' },
  { employee: 'Anna Schmidt', employee_id: 9, birthday: '1985-01-21' },
];

function countingService(): {
  svc: ReturnType<typeof createPrivacyGuardService>;
  calls: () => number;
} {
  let n = 0;
  const svc = createPrivacyGuardService({
    llmComplete: async () => {
      n += 1;
      return { text: '["employee"]' };
    },
  });
  return { svc, calls: () => n };
}

describe('PrivacyGuardService — canvas producer tools skip PII classification', () => {
  for (const toolName of [
    'canvas_publish_rows',
    'canvas_publish_choice',
    'canvas_publish_lumen',
  ]) {
    it(`${toolName}: interned, but no classifier call`, async () => {
      const { svc, calls } = countingService();
      const turnId = `t-${toolName}`;
      const result = await svc.internToolResultV4({
        sessionId: 's',
        turnId,
        toolName,
        rawResult: JSON.stringify(ROWS),
      });
      assert.ok(result.datasetId, 'the result is still interned');
      assert.equal(calls(), 0, 'no Haiku classifier call for a canvas producer');
      const receipt = await svc.finalizeTurn(turnId, 'Geburtstage im Januar');
      assert.ok(receipt);
      assert.equal(receipt.datasetsInterned, 1);
    });
  }

  it('a data-source tool is still classified', async () => {
    const { svc, calls } = countingService();
    await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't-source',
      toolName: 'hr.employees',
      rawResult: JSON.stringify(ROWS),
    });
    assert.equal(calls(), 1);
    const receipt = await svc.finalizeTurn('t-source', 'Wann hat Marvin Vomberg Geburtstag?');
    assert.ok(receipt);
    assert.equal(receipt.identityValuesOnWire, 1);
  });
});

/** Collect console.log lines while `fn` runs. */
async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

const C1_LINE = /^\[privacy-guard v4\] c1-detect ms=\d+ chars=(\d+) spans=(\d+)/;

describe('PrivacyGuardService — C1 timing log', () => {
  it('logs ms/chars/spans around a successful detector call', async () => {
    const text = 'Mail an Anna Schmidt';
    const c1: PromptPiiDetector = {
      id: 'c1-test',
      detect: async () => [{ start: 8, end: 20, type: 'person', confidence: 0.9 }],
    };
    const svc = createPrivacyGuardService({ readConfig: () => 'on', c1Detector: c1 });
    const lines = await captureLog(() =>
      svc.maskUserPrompt!({ sessionId: 's', turnId: 't-c1-ok', text }),
    );
    const match = lines.map((l) => C1_LINE.exec(l)).find((m) => m !== null);
    assert.ok(match, `no c1-detect line in: ${lines.join(' | ')}`);
    assert.equal(match[1], String(text.length));
    assert.equal(match[2], '1');
  });

  it('logs the timing line when the detector fails (timeout/error)', async () => {
    const c1: PromptPiiDetector = {
      id: 'c1-test',
      detect: async () => {
        throw new Error('C1 detector timed out after 15000 ms');
      },
    };
    const svc = createPrivacyGuardService({ readConfig: () => 'on', c1Detector: c1 });
    const lines = await captureLog(() =>
      svc.maskUserPrompt!({ sessionId: 's', turnId: 't-c1-fail', text: 'Mail an Anna' }),
    );
    const line = lines.find((l) => C1_LINE.test(l));
    assert.ok(line, `no c1-detect line in: ${lines.join(' | ')}`);
    assert.match(line, /spans=0/);
    assert.match(line, /failed/);
  });
});
