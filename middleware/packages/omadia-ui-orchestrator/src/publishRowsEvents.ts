import { randomUUID } from 'node:crypto';

import { type ChatStreamEvent } from '@omadia/channel-sdk';
import { type RefreshSource } from '@omadia/fast-path';

import { CANVAS_PUBLISH_TOOL, handleCanvasPublishRows } from './canvasPublishHandlers.js';
import { type PlanColumn } from './fastPathBinding.js';
import { type VariantAction } from './recipeVariant.js';

/** Synthetic `canvas_publish_rows` calls for deterministically fetched
 *  rows — the LLM-free publish shared by canvas_refresh and the fast path.
 *  A `source` rides along so synthesis captures it as the refresh recipe. */
export async function* publishRowsEvents(
  jobs: ReadonlyArray<{
    containerId: string;
    rows: Array<Record<string, unknown>>;
    source?: RefreshSource;
    /** suggested actions (deterministic recipe variants) for the table */
    actions?: readonly VariantAction[];
    /** fast path: the plan's columns replace the table's */
    columns?: ReadonlyArray<PlanColumn>;
  }>,
): AsyncGenerator<ChatStreamEvent> {
  for (const job of jobs) {
    const id = randomUUID();
    yield { type: 'tool_use', id, name: CANVAS_PUBLISH_TOOL, input: { containerId: job.containerId } };
    const output = await handleCanvasPublishRows(
      {
        containerId: job.containerId,
        rows: job.rows,
        ...(job.source ? { source: job.source } : {}),
        ...(job.actions && job.actions.length > 0 ? { actions: job.actions } : {}),
      },
      undefined,
      job.columns ? { columns: job.columns } : undefined,
    );
    yield { type: 'tool_result', id, output, durationMs: 0 };
  }
}
