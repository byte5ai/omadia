import type { ChatStreamEvent } from '@omadia/channel-sdk';
import type { PrivacyStoredTextScope } from '@omadia/plugin-api';

import { maskExampleQuestion, STORED_TEXT_JOB } from './exampleMasking.js';
import { planId, type LearnedPlanStore, type PlanCandidate } from './learnedPlanStore.js';
import { isLearnableToolName, isRowTool, stripLiterals } from './literalStripping.js';
import { parseRefreshSource, type RefreshFilter, type RefreshSource } from './refreshRecipes.js';

/**
 * Learned fast path — capture on the agent path.
 *
 * Observes one agent canvas turn (new canvas or in-place) and, when its
 * `done` is neither verifier-blocked nor an error, derives a plan candidate:
 * the rows published to ONE container came from exactly ONE learnable read
 * tool call (top-level or sub-agent), the column map is known (the publish's
 * own `source` recipe, else the dataset's column paths), and the turn ran no
 * other data tool. Multi-tool turns, joins, aggregations, KPI publishes →
 * nothing is learned. Only the call's INPUT is kept, never a result; the
 * input and the question are literal-stripped before anything is stored.
 */

/** Housekeeping tools that never feed published rows (memory checks). */
const NON_DATA_TOOLS: ReadonlySet<string> = new Set(['memory']);

interface Call {
  name: string;
  input: unknown;
}

interface Publish {
  containerId: string;
  isFields: boolean;
  source?: unknown;
  datasetPaths?: string[];
}

/** The field contract of one data container (a canvas table's columns). */
export interface ContainerFields {
  containerId: string;
  fields: ReadonlyArray<{ fieldKey: string }>;
}

export interface TurnLearnerOptions {
  /** the user's question (raw text of the turn) */
  question: string;
  /** the field contract of the turn's containers */
  requirements: readonly ContainerFields[];
  /** canvas producer tools (canvas_publish_rows, …) — not data calls */
  isProducerTool: (name: string) => boolean;
  store: LearnedPlanStore;
  /** the Privacy Shield's stored-text scope opener (`privacyRedact`
   *  service); absent → no example can be stored (failure-closed) */
  openStoredTextScope?: (request: { job: string }) => PrivacyStoredTextScope;
  log: (message: string) => void;
}

export interface TurnLearner {
  /** synthesis hook: one parsed `_pendingStructuredPayload.data` */
  onPublishedPayload(data: unknown): void;
  /** pass-through tap; commits the candidate when `done` arrives */
  tap(stream: AsyncIterable<ChatStreamEvent>): AsyncGenerator<ChatStreamEvent>;
}

type Derived =
  | { ok: true; candidate: PlanCandidate; literals: ReadonlyMap<string, string | number> }
  | { ok: false; reason: string };

function readPublish(data: unknown): Publish | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d['containerId'] !== 'string') return undefined;
  const cols = Array.isArray(d['datasetColumns']) ? (d['datasetColumns'] as unknown[]) : undefined;
  const datasetPaths = cols
    ?.map((c) => (typeof c === 'object' && c !== null ? (c as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  return {
    containerId: d['containerId'],
    isFields: typeof d['fields'] === 'object' && d['fields'] !== null,
    ...(d['source'] !== undefined ? { source: d['source'] } : {}),
    ...(datasetPaths && datasetPaths.length > 0 ? { datasetPaths } : {}),
  };
}

export function createTurnLearner(opts: TurnLearnerOptions): TurnLearner {
  const calls = new Map<string, Call>();
  const parents = new Set<string>();
  const failed = new Set<string>();
  const publishes: Publish[] = [];
  let sawError = false;

  /** The one recipe the published rows came from, or why there is none. */
  function recipeFromTurn(): { recipe: RefreshSource; containerId: string } | { reason: string } {
    if (publishes.length === 0) return { reason: 'no-publish' };
    const containers = new Set(publishes.map((p) => p.containerId));
    if (containers.size > 1) return { reason: 'multi-container' };
    if (publishes.some((p) => p.isFields)) return { reason: 'fields-publish' };
    const dataCalls = [...calls.entries()].filter(
      ([id, c]) => !parents.has(id) && !opts.isProducerTool(c.name) && !NON_DATA_TOOLS.has(c.name),
    );
    if (dataCalls.some(([, c]) => !isLearnableToolName(c.name))) return { reason: 'non-read-tool' };
    const rowCalls = dataCalls.filter(([, c]) => isRowTool(c.name));
    const only = rowCalls[0];
    if (rowCalls.length !== 1 || only === undefined) return { reason: `read-calls=${rowCalls.length}` };
    const [callId, call] = only;
    if (failed.has(callId)) return { reason: 'tool-error' };
    const containerId = [...containers][0] as string;
    const declared = publishes.find((p) => p.source !== undefined)?.source;
    if (declared !== undefined) {
      const recipe = parseRefreshSource(declared);
      if (!recipe) return { reason: 'invalid-source' };
      if (recipe.tool !== call.name) return { reason: 'source-tool-mismatch' };
      const fields = opts.requirements.find((r) => r.containerId === containerId)?.fields ?? [];
      const keys = new Set(fields.map((f) => f.fieldKey));
      if (keys.size > 0 && Object.keys(recipe.map).some((k) => !keys.has(k))) {
        return { reason: 'map-mismatch' };
      }
      return { recipe, containerId };
    }
    const paths = publishes.find((p) => p.datasetPaths !== undefined)?.datasetPaths;
    if (paths === undefined) return { reason: 'no-map' };
    return {
      recipe: { tool: call.name, input: call.input, map: Object.fromEntries(paths.map((p) => [p, p])) },
      containerId,
    };
  }

  function derive(): Derived {
    const found = recipeFromTurn();
    if ('reason' in found) return { ok: false, reason: found.reason };
    const { recipe } = found;
    // ONE stripper run over input + filter: shared placeholder numbering
    const { template, literals } = stripLiterals({ input: recipe.input, filter: recipe.filter ?? null });
    const t = template as { input: unknown; filter: RefreshFilter[] | null };
    return {
      ok: true,
      literals,
      candidate: {
        tool: recipe.tool,
        inputTemplate: t.input,
        map: recipe.map,
        ...(t.filter ? { filter: t.filter } : {}),
        ...(recipe.rowKey ? { rowKey: recipe.rowKey } : {}),
        ...(recipe.itemsPath ? { itemsPath: recipe.itemsPath } : {}),
      },
    };
  }

  /** Never throws; never logs the question. */
  async function commit(done: Extract<ChatStreamEvent, { type: 'done' }>): Promise<void> {
    if (done.answerSource === 'verifier-blocked' || done.answerIsError === true) {
      opts.log(`[fast-path] learned skip reason=blocked`);
      return;
    }
    if (sawError) {
      opts.log(`[fast-path] learned skip reason=turn-error`);
      return;
    }
    const d = derive();
    if (!d.ok) {
      opts.log(`[fast-path] learned skip reason=${d.reason}`);
      return;
    }
    const open = opts.openStoredTextScope;
    const masked = await maskExampleQuestion(
      opts.question,
      d.literals,
      open ? () => open({ job: STORED_TEXT_JOB }) : undefined,
    );
    if (masked.ok) {
      await opts.store.recordSuccess({ ...d.candidate, example: masked.example });
      return;
    }
    // no safe example: the success counts only for a plan that already has one
    const prev = opts.store.get(planId(d.candidate));
    if (prev !== undefined && prev.examples.length > 0) {
      opts.log(`[fast-path] learned example not stored reason=example-unmasked detail=${masked.detail}`);
      await opts.store.recordSuccess(d.candidate);
      return;
    }
    opts.log(`[fast-path] learned skip reason=example-unmasked detail=${masked.detail}`);
  }

  function observe(ev: ChatStreamEvent): void {
    switch (ev.type) {
      case 'tool_use':
        calls.set(ev.id, { name: ev.name, input: ev.input });
        break;
      case 'sub_tool_use':
        calls.set(ev.id, { name: ev.name, input: ev.input });
        parents.add(ev.parentId);
        break;
      case 'tool_result':
      case 'sub_tool_result':
        if (ev.isError === true || /^\s*Error\b/.test(ev.output)) failed.add(ev.id);
        break;
      case 'error':
        sawError = true;
        break;
      default:
        break;
    }
  }

  return {
    onPublishedPayload(data) {
      const p = readPublish(data);
      if (p) publishes.push(p);
    },
    async *tap(stream) {
      let pending: Promise<void> | undefined;
      for await (const ev of stream) {
        // masking (a C1 call) runs behind `done`, never delaying it; started
        // before the yield so a consumer that stops at `done` still commits
        if (ev.type === 'done') {
          pending = commit(ev).catch((err: unknown) => {
            opts.log(`[fast-path] learned commit failed: ${err instanceof Error ? err.message : 'error'}`);
          });
        } else observe(ev);
        yield ev;
      }
      if (pending) await pending;
    },
  };
}
