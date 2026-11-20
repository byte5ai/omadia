/**
 * #2085 — `deliver_data`: the side channel for data inside a turn (spec 2042
 * §5.13). The agent decides which of its own read tools runs; the harness
 * runs it under the agent's grants and the audience floor, puts the rows on
 * the answer as side-channel data (`SemanticAnswer.data`, rendered into the
 * text under the agent's identity and AI disclosure) and hands the model a
 * status only: row count, columns, refusal. The rows never reach a model.
 *
 * Discretion labels (INV-9) are not known yet (#2079, S5): until they are,
 * the read runs in the conversation the turn belongs to and nowhere else,
 * like any tool the model dispatches there.
 */

import { guardToolEgress, MAX_DATA_PAYLOADS_PER_TURN, turnContext } from '@omadia/orchestrator';
import type { NativeToolSpec } from '@omadia/plugin-api';

import { MAX_TABLE_ROWS, toTableData, type DataActionRunner } from './dataActions.js';
import type { DataActionSpec } from './types.js';

export const DELIVER_DATA_TOOL_NAME = 'deliver_data';

export const deliverDataToolSpec: NativeToolSpec = {
  name: DELIVER_DATA_TOOL_NAME,
  description:
    `Show data to the user as a table without reading it yourself: runs one of your own read tools and puts its result under your answer. You get a status (row count, columns), never the rows, so do not restate or summarise values — refer to "the table below". Prefer this whenever the user asks to see records (lists, open items, reports). Call the read tool directly only when you must reason about specific values. At most ${String(MAX_DATA_PAYLOADS_PER_TURN)} tables per answer; at most ${String(MAX_TABLE_ROWS)} rows each.`,
  input_schema: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'The name of one of your read tools.' },
      input: { type: 'object', description: 'The input for that tool, exactly as you would pass it.' },
      title: { type: 'string', description: 'A short caption for the table.' },
    },
    required: ['tool'],
  },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface DeliverDataDeps {
  readonly dataActions: DataActionRunner;
}

/** The tool's handler. Every outcome is a status string for the model. */
export function createDeliverDataHandler(deps: DeliverDataDeps): (input: unknown) => Promise<string> {
  return async (input: unknown): Promise<string> => {
    const ctx = turnContext.current();
    const collector = ctx?.dataSideChannel;
    const agentSlug = ctx?.agentSlug;
    if (!collector || !agentSlug) return 'Error (no_turn): data can only be delivered as part of an answer.';
    const raw = isRecord(input) ? input : {};
    const tool = typeof raw['tool'] === 'string' ? raw['tool'].trim() : '';
    if (tool === '') return 'Error (invalid): `tool` is required.';
    const title = typeof raw['title'] === 'string' && raw['title'].trim() !== '' ? raw['title'].trim().slice(0, 200) : undefined;
    const toolInput = raw['input'];
    if (toolInput !== undefined && !isRecord(toolInput)) return 'Error (invalid): `input` must be an object.';
    const action: DataActionSpec = { tool, input: toolInput ?? {} };

    const refusal = await guardToolEgress(tool);
    if (refusal) return refusal;
    const result = await deps.dataActions.run(agentSlug, action);
    if (!result.ok) return `Error (data_action_failed): ${result.error}`;

    const table = toTableData(result.rows, result.columns, title);
    const added = collector.add(table);
    if (!added.accepted) {
      return `Error (limit_reached): this answer already carries ${String(MAX_DATA_PAYLOADS_PER_TURN)} tables.`;
    }
    return JSON.stringify({
      status: 'delivered',
      rows: result.rows.length,
      shownRows: table.rows.length,
      columns: table.columns,
      ...(title ? { title } : {}),
      note: 'The user sees this table below your answer. You did not receive its rows: do not state values from it.',
    });
  };
}
