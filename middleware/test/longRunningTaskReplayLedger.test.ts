/**
 * A long-running task's detached runner is not part of the request that
 * started it, so it never runs against that request's replay ledger.
 *
 * `<tool>_start` returns at once and its runner keeps working after the turn —
 * and, in `enforce`, while the verifier re-enters the request. The runner is
 * started inside the dispatch's turn scope, so it used to inherit the
 * request's `ToolReplayLedger` through AsyncLocalStorage. Once the verifier
 * called `beginReentry()` that ledger was in replay mode for good: every inner
 * call the background task made afterwards was refused as a miss outside the
 * first run (which also abandoned whatever re-entry was running at that
 * moment) or handed a replayed first-run result, and the ledger — raw
 * pre-shield results included — lived as long as the runner. Now the runner
 * gets a turn-local ledger of its own: it executes its calls, and only a
 * repeat of a call whose outcome is unknown is refused, within the task.
 *
 * Drives the REAL `LocalSubAgent`, long-running sub-agent tool and — in the
 * second test — `Orchestrator` under `VerifierService`; only the models, the
 * pipeline and the store are scripted. All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest } from '@omadia/llm-provider';
import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { LocalSubAgent } from '../packages/harness-orchestrator/src/localSubAgent.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { InMemoryTaskStore } from '../packages/harness-orchestrator/src/tasks/inMemoryTaskStore.js';
import type { LongRunningToolHandle } from '../packages/harness-orchestrator/src/tasks/longRunningTool.js';
import { createLongRunningSubAgentTool } from '../packages/harness-orchestrator/src/tasks/subAgentTaskTool.js';
import { createDomainTool } from '../packages/harness-orchestrator/src/tools/domainQueryTool.js';
import { ToolReplayLedger } from '../packages/harness-orchestrator/src/toolReplayLedger.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import {
  REQUEST,
  scriptedModel,
  text,
  toolCalls,
  verifiedTurn,
} from './_helpers/replayTurnFixture.js';
import { approved, blocked } from './_helpers/verifierVerdictFixtures.js';

const QUESTION = 'Wie viele Urlaubstage hat MA-7 noch?';
const LOOKUP = { model: 'hr.leave.allocation', employee: 'MA-7' };
const ROWS = '[{"employee":"MA-7","remaining_days":12}]';
const HR_ANSWER = 'MA-7 hat noch 12 Urlaubstage.';
const STARTED = 'Ich habe die Personalabteilung gefragt und melde mich mit dem Ergebnis.';
const CORRECTED = 'Die Anfrage an die Personalabteilung läuft; das Ergebnis folgt.';

/** A model whose requests wait until `release()` — the sub-agent's model, so
 *  the background task makes its inner call when the test decides. */
function gated(model: ReturnType<typeof scriptedModel>): {
  provider: LlmProvider;
  release: () => void;
} {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = model.provider as unknown as {
    stream: (req: LlmRequest) => AsyncIterable<unknown>;
    complete: (req: LlmRequest) => Promise<unknown>;
  };
  const provider = {
    ...(model.provider as object),
    complete: async (req: LlmRequest) => {
      await gate;
      return inner.complete(req);
    },
    stream: (req: LlmRequest) => ({
      async *[Symbol.asyncIterator]() {
        await gate;
        yield* inner.stream(req);
      },
    }),
  };
  return { provider: provider as unknown as LlmProvider, release };
}

interface HrTask {
  readonly handle: LongRunningToolHandle;
  readonly lookups: unknown[];
  readonly release: () => void;
  start(input: unknown): Promise<string>;
  status(taskId: string): Promise<{ status: string; result?: string }>;
}

/** `ask_hr_start` / `_status` over a LocalSubAgent whose one inner tool reads
 *  leave data — the shape `subAgentToolHydration` registers for a slow agent. */
function hrTask(): HrTask {
  const lookups: unknown[] = [];
  const lookup: LocalSubAgentTool = {
    spec: {
      name: 'query_hr_leave',
      description: 'reads leave allocations (test)',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    handle: (input: unknown) => {
      lookups.push(input);
      return Promise.resolve(ROWS);
    },
  };
  const subModel = gated(scriptedModel([toolCalls(['query_hr_leave', LOOKUP]), text(HR_ANSWER)]));
  const agent = new LocalSubAgent({
    name: 'hr',
    provider: subModel.provider,
    model: 'test',
    maxTokens: 1024,
    maxIterations: 4,
    systemPrompt: 'HR sub-agent (test).',
    tools: [lookup],
  });
  const askHr = createDomainTool({ name: 'ask_hr', description: 'HR specialist (test)', agent, domain: 'hr' });
  const handle = createLongRunningSubAgentTool({
    baseToolName: 'ask_hr',
    displayName: 'hr',
    description: 'HR specialist (test).',
    agent: { ask: (question, observer) => askHr.handle({ question }, observer) },
    store: new InMemoryTaskStore(),
  });
  const handler = (name: string) => {
    const reg = handle.registrations.find((r) => r.name === name);
    if (!reg) throw new Error(`no registration ${name}`);
    return reg.handler;
  };
  return {
    handle,
    lookups,
    release: subModel.release,
    start: async (input) => String(await handler('ask_hr_start')(input)),
    status: async (taskId) =>
      JSON.parse(String(await handler('ask_hr_status')({ taskId }))) as { status: string; result?: string },
  };
}

describe('a detached task runner keeps out of the request’s replay ledger', () => {
  it('MUTATION CHECK: a background call after beginReentry() runs, and abandons nothing', async () => {
    const hr = hrTask();
    const ledger = new ToolReplayLedger();
    const started = await turnContext.run(
      { turnId: 'turn-c07', turnDate: '2026-10-01', toolReplayLedger: ledger },
      () => hr.start({ question: QUESTION }),
    );
    const { taskId } = JSON.parse(started) as { taskId: string };

    // The verifier re-enters the request while the task is still running.
    ledger.beginReentry();
    hr.release();
    await hr.handle.drainForTest();

    assert.deepEqual(hr.lookups, [LOOKUP], 'the background task ran its inner call');
    assert.equal(ledger.abortedTool, undefined, 'the task did not abandon the re-entry');
    const status = await hr.status(taskId);
    assert.equal(status.status, 'completed');
    assert.equal(status.result, HR_ANSWER);
  });

  it('MUTATION CHECK, enforce: a task running during the correction retry leaves the retry alone', async () => {
    const hr = hrTask();
    const registry = new NativeToolRegistry();
    for (const reg of hr.handle.registrations) {
      registry.register(reg.name, { handler: reg.handler, spec: reg.spec, promptDoc: reg.promptDoc });
    }
    // The parent model: the first run starts the task; while the retry's model
    // call is in flight, the background task makes its inner call.
    const parent = scriptedModel([
      toolCalls(['ask_hr_start', { question: QUESTION }]),
      text(STARTED),
      text(CORRECTED),
    ]);
    const base = parent.provider as unknown as { complete: (req: LlmRequest) => Promise<unknown> };
    const provider = {
      ...(parent.provider as object),
      complete: async (req: LlmRequest) => {
        if (parent.requests.length === 2) {
          hr.release();
          await hr.handle.drainForTest();
        }
        return base.complete(req);
      },
    } as unknown as LlmProvider;
    const t = verifiedTurn({
      registry,
      responses: [],
      verdicts: [blocked(), approved()],
      orchestrator: { provider },
    });

    const sa = await t.service.chat(REQUEST);

    assert.equal(parent.requests.length, 3, 'the correction retry ran');
    assert.deepEqual(hr.lookups, [LOOKUP], 'the background task ran its inner call once');
    assert.deepEqual(sa.verifier, { status: 'corrected' }, 'the retry was not abandoned');
    assert.equal(
      t.logs.some((l) => /abandoned/.test(l)),
      false,
      `no re-entry was abandoned: ${t.logs.join(' | ')}`,
    );
  });
});
