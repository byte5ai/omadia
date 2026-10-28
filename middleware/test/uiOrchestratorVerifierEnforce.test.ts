/**
 * The canvas composer's skeleton on a base that holds content until the
 * verdict (the answer verifier in `enforce` mode). The skeleton is built from
 * the user's request only and the verifier never judges it, so it goes out
 * IMMEDIATELY — before the main turn and its verdict — on every base. What
 * the verdict gates is the TURN's content (text, the published rows): a
 * released turn patches onto the skeleton; a withheld or failed turn replaces
 * it with a status tree, so no loading placeholder is orphaned and no
 * withheld figure reaches the canvas.
 *
 * Drives the REAL canvas agent over a REAL `VerifierService`; only the
 * orchestrator (a scripted stream), the verifier pipeline and the composer
 * LLM are stubbed.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext } from '../packages/plugin-api/src/index.js';
import type { CompositionLlm } from '../packages/omadia-ui-orchestrator/src/composition.js';
import { activate } from '../packages/omadia-ui-orchestrator/src/plugin.js';
import { validateTree } from '../packages/omadia-ui-orchestrator/src/treeValidator.js';
import { withheldTree } from '../packages/omadia-ui-orchestrator/src/verdictHold.js';
import { createVerifierHarness } from './_helpers/verifierServiceHarness.js';
import type { ScriptedVerdict } from './_helpers/verifierServiceHarness.js';
import { AMOUNT_TEXT, approved, blocked } from './_helpers/verifierVerdictFixtures.js';
import { ANSWER, deltasOf, doneOf } from './_helpers/verifierStreamScript.js';

const SKELETON_TREE = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [
    { type: 'text', id: 'lead', content: 'Q3-Umsatz je Monat' },
    {
      type: 'table',
      id: 'revenue',
      loading: 'skeleton',
      columns: [
        { fieldKey: 'month', label: 'Monat' },
        { fieldKey: 'amount', label: 'Betrag' },
      ],
      rows: [],
    },
  ],
};

const COMPOSER_OUTPUT = JSON.stringify({
  tree: SKELETON_TREE,
  dataRequirements: [
    {
      containerId: 'revenue',
      description: 'Umsatz im dritten Quartal je Monat',
      fields: [
        { fieldKey: 'month', label: 'Monat' },
        { fieldKey: 'amount', label: 'Betrag' },
      ],
    },
  ],
});

const PUBLISH_OUTPUT = JSON.stringify({
  prose: 'ein Monat',
  _pendingStructuredPayload: {
    prose: 'ein Monat',
    dataRefId: 'rev-q3',
    data: { containerId: 'revenue', rows: [{ rowKey: 'jul', month: 'Juli', amount: AMOUNT_TEXT }] },
  },
});

/** The main turn behind the skeleton: one canvas publish, then the answer. */
const CANVAS_TURN: ChatStreamEvent[] = [
  { type: 'iteration_start', iteration: 1 },
  { type: 'tool_use', id: 't1', name: 'revenue_tool', input: {} },
  { type: 'tool_result', id: 't1', output: PUBLISH_OUTPUT, durationMs: 1 },
  { type: 'text_delta', text: ANSWER },
  { type: 'done', answer: ANSWER, toolCalls: 1, iterations: 1 },
];

const composer: CompositionLlm = {
  complete: () => Promise.resolve({ text: COMPOSER_OUTPUT }),
};

function makeCtx(): { ctx: PluginContext; reg: Map<string, unknown> } {
  const reg = new Map<string, unknown>();
  const config: Record<string, string> = { canvas_output_tools: 'revenue_tool' };
  const ctx = {
    log: () => {},
    services: {
      get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
      provide: (name: string, impl: unknown) => {
        reg.set(name, impl);
        return () => reg.delete(name);
      },
    },
    llm: composer,
    config: { get: <T>(k: string): T | undefined => config[k] as T | undefined },
  } as unknown as PluginContext;
  return { ctx, reg };
}

/** Runs one canvas turn through the canvas agent over a verifier in `mode`;
 *  `atVerify` holds the event types the canvas consumer had received when
 *  the verifier was asked. */
async function canvasTurn(
  mode: 'shadow' | 'enforce',
  verdicts: readonly ScriptedVerdict[],
  script: readonly ChatStreamEvent[] = CANVAS_TURN,
): Promise<{ events: ChatStreamEvent[]; atVerify: string[][] }> {
  const events: ChatStreamEvent[] = [];
  const atVerify: string[][] = [];
  const h = createVerifierHarness({
    mode,
    streams: [script],
    verdicts,
    onVerify: () => atVerify.push(events.map((e) => e.type)),
  });
  const { ctx, reg } = makeCtx();
  reg.set(CHAT_AGENT_SERVICE, { agent: h.service } satisfies ChatAgentBundle);
  await activate(ctx);
  const canvas = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
  const input = { userMessage: 'Zeig den Q3-Umsatz', canvasSessionId: 'c1' } as unknown as ChatTurnInput;
  for await (const event of canvas.chatStream(input)) events.push(event);
  return { events, atVerify };
}

const surfacesOf = (events: readonly ChatStreamEvent[]): ChatStreamEvent[] =>
  events.filter((e) => e.type.startsWith('surface_'));

const field = (e: ChatStreamEvent | undefined, key: string): unknown =>
  (e as unknown as Record<string, unknown> | undefined)?.[key];

describe('canvasChatAgent over an enforce-mode verifier — skeleton early, content on release', () => {
  it('the skeleton goes out before the verdict, as the first event', async () => {
    const { events, atVerify } = await canvasTurn('enforce', [approved()]);
    assert.equal(events[0]?.type, 'surface_snapshot');
    assert.deepEqual(field(events[0], 'tree'), SKELETON_TREE);
    assert.equal(atVerify.length, 1);
    assert.deepEqual(
      atVerify[0]?.filter((t) => t.startsWith('surface_')),
      ['surface_snapshot'],
      'only the skeleton is visible before the verdict — no patch, no text',
    );
    assert.equal(atVerify[0]?.includes('text_delta'), false);
  });

  it('a released turn patches onto the skeleton after the verdict', async () => {
    const { events } = await canvasTurn('enforce', [approved()]);
    const [skeleton, patch, ...rest] = surfacesOf(events);
    assert.equal(rest.length, 0);
    assert.equal(field(skeleton, 'producesRevision'), '0');
    assert.equal(field(skeleton, 'surfaceSeq'), 0);
    assert.equal(patch?.type, 'surface_patch');
    assert.equal(field(patch, 'basedOnRevision'), '0', 'the patch builds on the skeleton');
    assert.equal(field(patch, 'surfaceSeq'), 1);
    const at = (e: ChatStreamEvent | undefined): number => (e ? events.indexOf(e) : -1);
    assert.ok(at(skeleton) < at(patch), 'skeleton before its patch');
    assert.ok(
      at(skeleton) < events.findIndex((e) => e.type === 'text_delta'),
      'skeleton before the answer text',
    );
    assert.equal(doneOf(events)?.answer, ANSWER);
  });

  it('a withheld turn replaces the skeleton with the notice — no patch, no figure', async () => {
    const { events } = await canvasTurn('enforce', [blocked()]);
    const [skeleton, replacement, ...rest] = surfacesOf(events);
    assert.equal(rest.length, 0);
    assert.deepEqual(field(skeleton, 'tree'), SKELETON_TREE);
    assert.equal(replacement?.type, 'surface_snapshot', 'a full replace, not a patch');
    assert.equal(field(replacement, 'producesRevision'), '1');
    assert.equal(field(replacement, 'surfaceSeq'), 1);
    assert.ok(validateTree(field(replacement, 'tree')).ok, 'valid canvas tree');
    const notice = deltasOf(events);
    assert.equal(notice.length, 1, 'the notice is the only text');
    const status = (field(replacement, 'tree') as { children: Array<{ text: string; tone: string }> }).children[0];
    assert.equal(status?.text, notice[0]?.trim(), 'the status carries the verifier notice');
    assert.equal(status?.tone, 'warning');
    assert.ok(
      events.indexOf(replacement as ChatStreamEvent) < events.findIndex((e) => e.type === 'done'),
      'replaced before the terminal done',
    );
    assert.equal(JSON.stringify(events).includes(AMOUNT_TEXT), false, 'the withheld figure leaked');
    assert.equal(doneOf(events)?.answerSource, 'verifier-blocked');
  });

  it('a failed turn replaces the skeleton with an error status before the error', async () => {
    const failing: ChatStreamEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      { type: 'tool_use', id: 't1', name: 'revenue_tool', input: {} },
      { type: 'error', message: 'provider unavailable' },
    ];
    const { events, atVerify } = await canvasTurn('enforce', [approved()], failing);
    assert.equal(atVerify.length, 0, 'never verified');
    const [skeleton, replacement, ...rest] = surfacesOf(events);
    assert.equal(rest.length, 0);
    assert.deepEqual(field(skeleton, 'tree'), SKELETON_TREE);
    assert.deepEqual(field(replacement, 'tree'), withheldTree('failed'));
    assert.equal(events.at(-1)?.type, 'error');
    assert.equal(events.at(-2), replacement);
  });

  it('both replacement trees are valid canvas trees', () => {
    assert.ok(validateTree(withheldTree('failed')).ok);
    assert.ok(validateTree(withheldTree('withheld')).ok);
    assert.ok(validateTree(withheldTree('withheld', 'Die Antwort wurde zurückgehalten.')).ok);
  });
});

describe('canvasChatAgent over a shadow-mode verifier — skeleton-first is unchanged', () => {
  it('the skeleton is the first event, sent before the turn and its verdict', async () => {
    const { events, atVerify } = await canvasTurn('shadow', [blocked()]);
    assert.equal(events[0]?.type, 'surface_snapshot');
    assert.deepEqual(field(events[0], 'tree'), SKELETON_TREE);
    assert.ok(atVerify[0]?.includes('surface_snapshot'), 'shadow sends the skeleton before the verdict');
    assert.equal(surfacesOf(events).filter((e) => e.type === 'surface_snapshot').length, 1, 'never replaced');
  });
});
