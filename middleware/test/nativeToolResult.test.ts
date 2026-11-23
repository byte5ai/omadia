/**
 * S3c (spec 2042 §5.10) — a tool a plugin registers with `ctx.tools.register`
 * may return the same structured result a sub-agent tool returns:
 * `{ output, limitSignal?, postcondition?, structured? }`. Before, only the
 * sub-agent path read these fields; a native tool could return text only.
 *
 *  - `limitSignal` — the model sees `output` plus the limit note.
 *  - `postcondition` — lands on the run trace, so the verifier raises a
 *    `tool_postcondition` claim; a verifier re-entry that replays the call
 *    carries it again.
 *  - `structured` — never reaches the model.
 *
 * Drives the REAL `Orchestrator` under the REAL `VerifierService`. All values
 * are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  formatLimitSignalNote,
  makeLimitSignal,
  nativeToolResultText,
  normalizeNativeToolResult,
  type NativeToolResult,
} from '@omadia/plugin-api';

import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { invokePluginTool } from '../src/platform/pluginToolInvoker.js';
import {
  REQUEST,
  doneOf,
  drain,
  text,
  toolCalls,
  toolResultContents,
  verifiedTurn,
} from './_helpers/replayTurnFixture.js';
import { approved, blocked } from './_helpers/verifierVerdictFixtures.js';

const ROWS = '[{"partner":"K-1001"},{"partner":"K-1002"}]';
const LIMIT = makeLimitSignal('row_cap', 'Only the first 2 partners were returned', { cap: 2, observed: 840 });
const ANSWER = 'Es gibt zwei Partner: K-1001 und K-1002.';

function registryReturning(result: NativeToolResult): { registry: NativeToolRegistry; calls: unknown[] } {
  const registry = new NativeToolRegistry();
  const calls: unknown[] = [];
  registry.register('list_partners', {
    handler: (input: unknown) => {
      calls.push(input);
      return Promise.resolve(result);
    },
    spec: {
      name: 'list_partners',
      description: 'lists partners (test)',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    agentId: '@acme/integration-crm',
  });
  return { registry, calls };
}

describe('normalizeNativeToolResult', () => {
  it('passes text through and reads a structured result', () => {
    assert.deepEqual(normalizeNativeToolResult('plain'), { text: 'plain' });
    const normalized = normalizeNativeToolResult({
      output: ROWS,
      limitSignal: LIMIT,
      postcondition: { issues: ['partner: missing'] },
      structured: { kind: 'rows', data: [1, 2] },
    });
    assert.equal(normalized.text, `${ROWS}\n\n${formatLimitSignalNote(LIMIT)}`);
    assert.deepEqual(normalized.postcondition, { issues: ['partner: missing'] });
    assert.deepEqual(normalized.structured, { kind: 'rows', data: [1, 2] });
  });

  it('never throws on a value that breaks the type, and ignores an empty issue list', () => {
    assert.equal(nativeToolResultText({ rows: 2 }), '{"rows":2}');
    assert.equal(nativeToolResultText(undefined), '');
    assert.equal(normalizeNativeToolResult({ output: 'x', postcondition: { issues: [] } }).postcondition, undefined);
  });
});

describe('a native tool’s structured result in a turn', () => {
  it('the model gets output plus the limit note, never the structured data', async () => {
    const { registry } = registryReturning({
      output: ROWS,
      limitSignal: LIMIT,
      structured: { kind: 'rows', data: { secretColumn: 'not for the model' } },
    });
    const t = verifiedTurn({
      registry,
      responses: [toolCalls(['list_partners', {}]), text(ANSWER)],
      verdicts: [approved()],
    });

    await t.service.chat(REQUEST);

    const results = toolResultContents(t.model.requests[1]);
    assert.deepEqual(results, [`${ROWS}\n\n${formatLimitSignalNote(LIMIT)}`]);
    assert.equal(JSON.stringify(t.model.requests).includes('not for the model'), false);
  });

  it('a postcondition reaches the verifier, and a re-entry that replays the call carries it again', async () => {
    const { registry, calls } = registryReturning({ output: ROWS, postcondition: { issues: ['partner: missing'] } });
    const t = verifiedTurn({
      registry,
      responses: [toolCalls(['list_partners', {}]), text(ANSWER), toolCalls(['list_partners', {}]), text(ANSWER)],
      verdicts: [blocked(), approved()],
    });

    await t.service.chat(REQUEST);

    const evidence = (i: number) =>
      (t.verifyInputs[i]?.toolPostconditionViolations ?? []).map((v) => ({ toolName: v.toolName, issues: v.issues }));
    assert.equal(t.verifyInputs.length, 2);
    assert.deepEqual(evidence(0), [{ toolName: 'list_partners', issues: ['partner: missing'] }]);
    assert.deepEqual(evidence(1), evidence(0), 'the replayed call keeps its postcondition');
    assert.equal(calls.length, 1, 'the re-entry replayed the call instead of running it again');
  });

  it('on the streaming path, the postcondition is on the delivered run trace too', async () => {
    const { registry } = registryReturning({ output: ROWS, postcondition: { issues: ['partner: missing'] } });
    const t = verifiedTurn({
      registry,
      responses: [toolCalls(['list_partners', {}]), text(ANSWER)],
      verdicts: [approved()],
    });

    const terminal = doneOf(await drain(t.service.chatStream(REQUEST)));

    const calls = terminal?.runTrace?.orchestratorToolCalls ?? [];
    assert.deepEqual(calls.map((c) => c.postcondition), [{ issues: ['partner: missing'] }]);
  });

  it('a result that is neither text nor a structured result is refused, never handed on unmasked', async () => {
    const registry = new NativeToolRegistry();
    registry.register('list_partners', {
      // Breaks the type on purpose: a content-block array with a personal value.
      handler: (() => Promise.resolve([{ type: 'text', text: 'erika.mustermann@example.com' }])) as never,
      spec: {
        name: 'list_partners',
        description: 'lists partners (test)',
        input_schema: { type: 'object' as const, properties: {}, required: [] },
      } as never,
      agentId: '@acme/integration-crm',
    });
    const t = verifiedTurn({
      registry,
      responses: [toolCalls(['list_partners', {}]), text(ANSWER)],
      verdicts: [approved()],
    });

    await t.service.chat(REQUEST);

    assert.equal(JSON.stringify(t.model.requests).includes('erika.mustermann'), false);
    assert.match(toolResultContents(t.model.requests[1])[0] ?? '', /neither text nor a structured result; it was not passed on/);
  });

  it('a deterministic caller (canvas, Conductor) gets the same model-facing text', async () => {
    const { registry } = registryReturning({ output: ROWS, limitSignal: LIMIT });
    assert.equal(await invokePluginTool(registry, 'list_partners', {}), `${ROWS}\n\n${formatLimitSignalNote(LIMIT)}`);
    assert.equal(await invokePluginTool(registry, 'unknown_tool', {}), undefined);
  });
});
