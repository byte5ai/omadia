/**
 * #2085 — data actions: a read tool the harness runs on the agent's behalf,
 * without a model (spec 2042 §5.13). Only the agent's OWN read tools qualify:
 * tools it was granted, that declare no write capability, and not the inner
 * tools of a sub-agent (those reach the model only through their domain tool;
 * a data action must not widen the agent's reach past what it was granted).
 *
 * The result stays in the harness: the side channel renders it to people, the
 * model gets only a status (row count, columns).
 */

import type { DataActionResult } from './triggerChain.js';
import type { DataActionSpec } from './types.js';

export type ReadToolInvoker = (input: unknown) => Promise<string>;

/** The agent's own read tools by name, or undefined when it is not in service. */
export type ReadToolsOf = (agentSlug: string) => ReadonlyMap<string, ReadToolInvoker> | undefined;

/** Fields a result object commonly keeps its rows under. */
const ROW_FIELDS = ['rows', 'items', 'records', 'results', 'data', 'entries', 'values'] as const;
const MAX_COLUMNS = 40;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Rows of a tool result: a JSON array, an object holding one, or one object. */
export function extractRows(raw: string): { rows: unknown[]; parsed: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) return { rows: parsed, parsed };
  if (isRecord(parsed)) {
    for (const field of ROW_FIELDS) {
      const value = parsed[field];
      if (Array.isArray(value)) return { rows: value, parsed };
    }
    return { rows: [parsed], parsed };
  }
  return undefined;
}

/** Column names: the union of the first rows' keys, in first-seen order. */
export function columnsOf(rows: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const row of rows.slice(0, 50)) {
    if (!isRecord(row)) continue;
    for (const key of Object.keys(row)) {
      if (seen.size >= MAX_COLUMNS) break;
      seen.add(key);
    }
  }
  return [...seen];
}

export interface DataActionRunner {
  /** Why the agent may not run this action (undefined = it may). */
  check(agentSlug: string, action: DataActionSpec): string | undefined;
  run(agentSlug: string, action: DataActionSpec): Promise<DataActionResult>;
}

export function createDataActionRunner(readToolsOf: ReadToolsOf): DataActionRunner {
  const check = (agentSlug: string, action: DataActionSpec): string | undefined => {
    const tools = readToolsOf(agentSlug);
    if (!tools) return `agent '${agentSlug}' is not in service`;
    if (tools.has(action.tool)) return undefined;
    const offered = [...tools.keys()].sort();
    return `'${action.tool}' is not one of this agent's own read tools${offered.length > 0 ? `; available: ${offered.join(', ')}` : ''}`;
  };
  return {
    check,
    async run(agentSlug, action) {
      const why = check(agentSlug, action);
      if (why) return { ok: false, error: why };
      const invoke = readToolsOf(agentSlug)?.get(action.tool);
      if (!invoke) return { ok: false, error: `'${action.tool}' is no longer available` };
      let raw: string;
      try {
        raw = await invoke(action.input);
      } catch (err) {
        return { ok: false, error: `${action.tool} failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const extracted = extractRows(raw);
      if (!extracted) return { ok: false, error: `${action.tool} returned no structured data` };
      return { ok: true, rows: extracted.rows, columns: columnsOf(extracted.rows), raw: extracted.parsed };
    },
  };
}
