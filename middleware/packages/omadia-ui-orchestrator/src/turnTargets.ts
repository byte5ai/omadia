import { type ChatTurnInput } from '@omadia/channel-sdk';
import { type RecipeStore } from '@omadia/fast-path';

/**
 * Target-record helpers of action/row-bound canvas turns: which row a turn
 * refers to, the record that row resolves to via its table's recipe, and the
 * composer's TARGET RECORD block. Re-exported from `plugin.ts`.
 */

/** The row an action/row-bound turn refers to: its container and row key —
 *  from the TargetRef, the action's target, or a `{containerId, rowKey}`
 *  action payload. */
export function actionTargetRow(input: ChatTurnInput): { containerId: string; key: string } | undefined {
  const candidates: unknown[] = [input.target, input.action?.target, input.action?.payload];
  for (const c of candidates) {
    if (typeof c !== 'object' || c === null) continue;
    const o = c as Record<string, unknown>;
    const containerId = o['containerId'];
    const key = o['rowKey'] ?? o['itemKey'];
    if (typeof containerId === 'string' && containerId.length > 0 && (typeof key === 'string' || typeof key === 'number')) {
      return { containerId, key: String(key) };
    }
  }
  return undefined;
}

/** A target row resolved against the recipe that filled its table: the
 *  record id (the recipe's rowKey attribute) and the source it came from. */
export interface TargetRecord {
  containerId: string;
  tool: string;
  model?: string;
  keyAttr: string;
  id: string | number;
}

/** True when `value` contains `id` as a scalar anywhere (a domain operand). */
export function mentionsValue(value: unknown, id: string | number): boolean {
  if (value === id || (typeof value === 'string' && typeof id === 'number' && value === String(id))) return true;
  if (Array.isArray(value)) return value.some((v) => mentionsValue(v, id));
  if (typeof value === 'object' && value !== null) return Object.values(value).some((v) => mentionsValue(v, id));
  return false;
}

/** The composer's TARGET RECORD block for an action turn. */
export function targetRecordBlock(t: TargetRecord): string {
  const domain = JSON.stringify([[t.keyAttr, '=', t.id]]);
  return (
    `\n\nTARGET RECORD (the action refers to exactly this record): tool "${t.tool}"` +
    (t.model !== undefined ? `, model "${t.model}"` : '') +
    `, record ${t.keyAttr} ${JSON.stringify(t.id)}. For a details/open request plan ONE query for exactly ` +
    `this record — e.g. "domain": ${domain} — with the detail fields of that model from the FIELD CATALOG, ` +
    'and a summary such as "Details ({count} Datensatz).". Anything else (a change, several records, ' +
    'reasoning) → no fetch.'
  );
}

/** The record an action turn targets, resolved against the recipe that
 *  filled its table in THIS canvas (fast path or an agent publish with a
 *  `source`). No recipe, or a recipe without a rowKey → undefined: the
 *  agent handles the action. */
export function resolveTargetRecord(
  refreshRecipes: Pick<RecipeStore, 'get'>,
  input: ChatTurnInput,
  canvasSessionId: string,
): TargetRecord | undefined {
  const row = actionTargetRow(input);
  if (!row) return undefined;
  const recipe = refreshRecipes.get(canvasSessionId, row.containerId);
  if (!recipe?.rowKey) return undefined;
  const model = (recipe.input as { model?: unknown } | null)?.model;
  const id = /^\d{1,15}$/.test(row.key) ? Number(row.key) : row.key;
  return {
    containerId: row.containerId,
    tool: recipe.tool,
    ...(typeof model === 'string' ? { model } : {}),
    keyAttr: recipe.rowKey,
    id,
  };
}
