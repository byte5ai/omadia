/**
 * #1543 / #1559 — a Privacy Shield render, driven through the REAL
 * `Orchestrator` with the REAL privacy-guard service.
 *
 * #1543: the render's ack carries the table's provenance (source tool, verb
 * chain, row count, columns) and the turn's persisted row starts with that
 * note, so the next turn knows which query produced the table on screen —
 * and neither carries a real cell value or a filter literal.
 *
 * #1559: a truncated render offers the full list as an Excel file, and the
 * Privacy Shield prompt rule a) tells the model to offer one, only when
 * `create_xlsx` is offered on the turn.
 *
 * #1972: "offered" includes the grant — an agent the Office plugin is not
 * granted to gets no file offer, no file-generation rules and no forced
 * file-build retry.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import type { PrivacyGuardService } from '@omadia/plugin-api';
import { NativeToolRegistry, Orchestrator, today, turnContext } from '@omadia/orchestrator';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

/** 55 rows — above the 50-row chat cap, so the render is truncated. */
const HR_ROWS = Array.from({ length: 55 }, (_, i) => ({
  employee: `Zelda Quarzbrunn ${String(i + 1)}`,
  work_email: `zelda.quarzbrunn${String(i + 1)}@example.com`,
  level: (i % 5) + 1,
}));
const REAL_VALUES = ['Zelda', 'Quarzbrunn', 'zelda.quarzbrunn'];
/** The filter literal: model-authored, may be user data — never in a note. */
const FILTER_LITERAL = 4711;

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function toolCall(id: string, name: string, input: unknown): LlmResponse {
  return {
    content: [{ type: 'tool_call', id, name, input }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function text(t: string): LlmResponse {
  return {
    content: [{ type: 'text', text: t }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

interface Captured {
  readonly system: string;
  readonly messages: string;
}

/** Fetch → filter (level ne 4711) → sort level desc → render a table → stop. */
function scriptedProvider(finalText = 'Fertig.'): { provider: LlmProvider; requests: Captured[] } {
  const requests: Captured[] = [];
  let step = 0;
  const lastDatasetId = (messages: unknown): string => {
    const ids = JSON.stringify(messages).match(/ds_[0-9a-f-]{36}/g) ?? [];
    const id = ids[ids.length - 1];
    assert.ok(id, 'the model was handed a datasetId');
    return id;
  };
  const provider = {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: (request: { system?: unknown; messages?: unknown[] }) => {
      requests.push({
        system: JSON.stringify(request.system ?? ''),
        messages: JSON.stringify(request.messages ?? []),
      });
      step += 1;
      if (step === 1) return Promise.resolve(toolCall('use-1', 'hr_employees', {}));
      if (step === 2) {
        return Promise.resolve(
          toolCall('use-2', 'v4_filter', {
            datasetId: lastDatasetId(request.messages),
            predicate: { op: 'ne', field: 'level', value: FILTER_LITERAL },
          }),
        );
      }
      if (step === 3) {
        return Promise.resolve(
          toolCall('use-3', 'v4_sort', {
            datasetId: lastDatasetId(request.messages),
            by: 'level',
            direction: 'desc',
          }),
        );
      }
      if (step === 4) {
        return Promise.resolve(
          toolCall('use-4', 'v4_render_answer', {
            datasetId: lastDatasetId(request.messages),
            columns: [{ field: 'employee', label: 'Name' }, { field: 'work_email', label: 'E-Mail' }],
            format: 'table',
          }),
        );
      }
      return Promise.resolve(text(finalText));
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, requests };
}

/** `none`: no Office plugin; `granted`/`ungranted`: registered by the Office
 *  plugin, which the agent does or does not hold. */
type ExportMode = 'none' | 'granted' | 'ungranted';
const OFFICE_PLUGIN_ID = '@omadia/plugin-office';

function registry(mode: ExportMode): NativeToolRegistry {
  const r = new NativeToolRegistry();
  r.register('hr_employees', {
    handler: () => Promise.resolve(JSON.stringify(HR_ROWS)),
    spec: {
      name: 'hr_employees',
      description: 'HR employees',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    domain: 'odoo.hr',
  });
  if (mode !== 'none') {
    r.register('create_xlsx', {
      agentId: OFFICE_PLUGIN_ID,
      handler: () => Promise.resolve('ok'),
      spec: {
        name: 'create_xlsx',
        description: 'Excel export',
        input_schema: { type: 'object' as const, properties: {}, required: [] },
      } as never,
    });
  }
  return r;
}

interface LoggedRow {
  readonly assistantAnswer: string;
}

async function runRenderTurn(
  mode: ExportMode,
  finalText?: string,
): Promise<{
  answer: string;
  requests: Captured[];
  logged: LoggedRow[];
}> {
  const service: PrivacyGuardService = createPrivacyGuardService();
  const { provider, requests } = scriptedProvider(finalText);
  const logged: LoggedRow[] = [];
  const sessionLogger = {
    log: (entry: LoggedRow): Promise<{ turnExternalId: string }> => {
      logged.push(entry);
      return Promise.resolve({ turnExternalId: 'turn:s1543:stub' });
    },
  };
  const orchestrator = new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 8,
    domainTools: [],
    nativeToolRegistry: registry(mode),
    ...(mode === 'ungranted' ? { grantedPluginIds: ['@omadia/plugin-hr'] } : {}),
    privacyGuard: () => service,
    sessionLogger,
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
  const result = await turnContext.run(
    { turnId: '', turnDate: today(), canvasSentinelSink: () => undefined },
    () => orchestrator.runTurn({ userMessage: 'Liste alle Mitarbeiter', sessionScope: 's1543' }),
  );
  return { answer: result.answer, requests, logged };
}

/** The tool_result the model got for the render — the ack. */
function renderAck(requests: readonly Captured[]): string {
  const last = requests[requests.length - 1];
  assert.ok(last, 'the model was asked again after the render');
  const at = last.messages.lastIndexOf('Final answer rendered server-side');
  assert.ok(at >= 0, 'the render ack reached the model');
  return last.messages.slice(at);
}

describe('#1543 — the render ack and the persisted row carry the table provenance', () => {
  it('names source tool, steps, row count and columns — never a value or a filter literal', async () => {
    const { requests, logged } = await runRenderTurn('none');
    const ack = renderAck(requests);
    assert.ok(ack.includes('Table provenance'), ack);
    assert.ok(ack.includes('source tool `hr_employees`'), ack);
    assert.ok(ack.includes('filter `level` ne …'), ack);
    assert.ok(ack.includes('sort by `level` desc'), ack);
    assert.ok(ack.includes('55 rows, the first 50 shown'), ack);
    assert.ok(ack.includes('`Name` (`employee`)'), ack);
    assert.ok(!ack.includes(String(FILTER_LITERAL)), 'the filter literal reached the ack');

    // No real value anywhere on the LLM wire.
    const wire = JSON.stringify(requests);
    for (const value of REAL_VALUES) {
      assert.ok(!wire.includes(value), `real value "${value}" reached the LLM wire`);
    }

    // The persisted row — what the next turn recalls — leads with the note.
    const row = logged[0];
    assert.ok(row, 'the turn was persisted');
    assert.ok(row.assistantAnswer.startsWith('<!-- orchestrator:rendered_table'), row.assistantAnswer);
    assert.ok(row.assistantAnswer.includes('source tool `hr_employees`'));
    assert.ok(!row.assistantAnswer.includes(String(FILTER_LITERAL)));
    for (const value of REAL_VALUES) {
      assert.ok(!row.assistantAnswer.includes(value), `real value "${value}" in the persisted note`);
    }
  });

  it('the Privacy Shield prompt tells the model to re-run the query or say it is a new one', async () => {
    const { requests } = await runRenderTurn('none');
    const system = requests[0]?.system ?? '';
    assert.ok(system.includes('Rückfragen zu einer früher gezeigten Tabelle'));
    assert.ok(system.includes('auf einer neuen Abfrage beruht'));
  });
});

describe('#1559 — an Excel file is offered only when create_xlsx is offered', () => {
  it('without create_xlsx: the footer counts the omitted rows, no file; rule a) offers none', async () => {
    const { answer, requests } = await runRenderTurn('none');
    assert.ok(answer.includes('5 weitere Zeilen nicht angezeigt (50 von 55)'), answer);
    assert.ok(!answer.includes('Excel'), `footer promised a file: ${answer}`);
    const system = requests[0]?.system ?? '';
    assert.ok(system.includes('Biete KEINE Excel'), 'rule a) must not offer a file');
    assert.ok(!system.includes('biete die vollständige Liste als Excel an'));
  });

  it('with create_xlsx: the footer and rule a) offer the full list as Excel', async () => {
    const { answer, requests } = await runRenderTurn('granted');
    assert.ok(answer.includes('5 weitere Zeilen nicht angezeigt (50 von 55)'), answer);
    assert.ok(answer.includes('Excel-Datei'), answer);
    const system = requests[0]?.system ?? '';
    assert.ok(system.includes('biete die vollständige Liste als Excel an'));
    assert.ok(!system.includes('Biete KEINE Excel'));
  });
});

describe('#1972 — file export, file rules and the forced retry follow the agent grant', () => {
  const ANNOUNCE = 'Ich erstelle jetzt die Excel-Datei mit allen Zeilen.';

  it('ungranted create_xlsx: no file in the footer, no file rules, no dedup file step', async () => {
    const { answer, requests } = await runRenderTurn('ungranted');
    assert.ok(answer.includes('5 weitere Zeilen nicht angezeigt (50 von 55)'), answer);
    assert.ok(!answer.includes('Excel'), `footer promised a file: ${answer}`);
    const system = requests[0]?.system ?? '';
    assert.ok(system.includes('Biete KEINE Excel'));
    assert.ok(!system.includes('Datei-Erzeugung (Excel/Word)'));
    assert.ok(!system.includes('wenn der User eine Datei will'));
  });

  it('granted create_xlsx: the file rules and the dedup file step are in the prompt', async () => {
    const { requests } = await runRenderTurn('granted');
    const system = requests[0]?.system ?? '';
    assert.ok(system.includes('Datei-Erzeugung (Excel/Word)'));
    assert.ok(system.includes('wenn der User eine Datei will'));
  });

  it('an announced file forces one retry only when the agent holds the tool', async () => {
    const ungranted = await runRenderTurn('ungranted', ANNOUNCE);
    const granted = await runRenderTurn('granted', ANNOUNCE);
    assert.equal(granted.requests.length, ungranted.requests.length + 1);
    // The nudge is English since #1219.
    assert.ok(JSON.stringify(granted.requests).includes('You said you would build a file'));
    assert.ok(!JSON.stringify(ungranted.requests).includes('You said you would build a file'));
  });

  it('#2345 — a capability list forces no retry, even with the tool granted', async () => {
    const list = 'Ich bin für FAQ zuständig, beantworte Fragen und erstelle bei Bedarf Excel- und Word-Dateien.';
    const granted = await runRenderTurn('granted', list);
    const ungranted = await runRenderTurn('ungranted', list);
    assert.equal(granted.requests.length, ungranted.requests.length);
    assert.ok(!JSON.stringify(granted.requests).includes('You said you would build a file'));
  });
});
