/**
 * Service factory for `privacy.redact@1` — Privacy Shield v4 Data-Plane
 * Boundary.
 *
 * Pure function — returns a stateful `PrivacyGuardService` that the
 * plugin's `activate` publishes via `ctx.services.provide`. Kept as a free
 * function (not a class) so tests can construct without a `PluginContext`.
 *
 * State held by the returned service, all turn-scoped and dropped by
 * `finalizeTurn` (Constitution I — no module-scope mutable state):
 *   - `Map<turnId, DatasetStore>` — the interned tool results. Real rows
 *     live here, server-side, never on the LLM wire.
 *   - `Map<turnId, string>` — the server-materialized final answer a
 *     `v4_render_answer` call produced, drained by `takeRenderedAnswerV4`.
 *   - `Map<turnId, V4ReceiptAccum>` — per-turn counters for the receipt.
 */

import type {
  PrivacyGuardService,
  PrivacyReceipt,
  PrivacyToolResultV4Request,
  PrivacyToolResultV4Result,
  PrivacyV4ToolRequest,
  PrivacyV4ToolSpec,
} from '@omadia/plugin-api';

import { createDatasetStore } from './v4/datasetStore.js';
import { createShapeClassifier } from './v4/shapeClassifier.js';
import { buildDigest, digestToToolResultText } from './v4/digest.js';
import type { DatasetStore } from './v4/types.js';
import { createVerbEngine } from './v4/verbs/index.js';
import {
  RENDER_TOOL_SPEC,
  VERB_TOOL_SPECS,
  dispatchVerbCall,
  parseRenderDirective,
} from './v4/toolDefs.js';
import { materialize } from './v4/materializer.js';

/** Per-turn counters drained into the user-facing `PrivacyReceipt`. */
interface V4ReceiptAccum {
  datasetsInterned: number;
  fieldsMasked: number;
  fieldsCleartext: number;
  readonly verbsExecuted: string[];
  pseudonymProjectionUsed: boolean;
}

export function createPrivacyGuardService(): PrivacyGuardService {
  // One turn-scoped Dataset Store per turn, minted lazily on the first
  // `internToolResultV4` and dropped by `finalizeTurn`.
  const stores = new Map<string, DatasetStore>();
  // Per-turn stash for the server-materialized final answer produced by a
  // `v4_render_answer` call.
  const renderedAnswers = new Map<string, string>();
  // Per-turn receipt counters.
  const receipts = new Map<string, V4ReceiptAccum>();

  function storeFor(turnId: string): DatasetStore {
    let s = stores.get(turnId);
    if (s === undefined) {
      s = createDatasetStore({
        classify: createShapeClassifier(),
        buildDigest,
        turnId,
      });
      stores.set(turnId, s);
    }
    return s;
  }

  function receiptFor(turnId: string): V4ReceiptAccum {
    let r = receipts.get(turnId);
    if (r === undefined) {
      r = {
        datasetsInterned: 0,
        fieldsMasked: 0,
        fieldsCleartext: 0,
        verbsExecuted: [],
        pseudonymProjectionUsed: false,
      };
      receipts.set(turnId, r);
    }
    return r;
  }

  return {
    async internToolResultV4(
      request: PrivacyToolResultV4Request,
    ): Promise<PrivacyToolResultV4Result> {
      const store = storeFor(request.turnId);
      const { digest } = store.internToolResult(
        request.toolName,
        request.rawResult,
      );
      const maskedFields = digest.fields.filter(
        (f) => f.classification === 'sensitive-masked',
      ).length;
      const receipt = receiptFor(request.turnId);
      receipt.datasetsInterned += 1;
      receipt.fieldsMasked += maskedFields;
      receipt.fieldsCleartext += digest.fields.length - maskedFields;
      console.log(
        `[privacy-guard v4] intern turn=${request.turnId} ` +
          `tool=${request.toolName} datasetId=${digest.datasetId} ` +
          `rows=${String(digest.rowCount)} fields=${String(digest.fields.length)} ` +
          `masked=${String(maskedFields)}${digest.truncated ? ' truncated' : ''}`,
      );
      return { digestText: digestToToolResultText(digest) };
    },

    async runV4Tool(
      request: PrivacyV4ToolRequest,
    ): Promise<{ readonly resultText: string }> {
      const store = storeFor(request.turnId);
      try {
        if (request.toolName === RENDER_TOOL_SPEC.name) {
          const directive = parseRenderDirective(request.input);
          const rendered = materialize(store, directive);
          renderedAnswers.set(request.turnId, rendered.text);
          console.log(
            `[privacy-guard v4] render turn=${request.turnId} ` +
              `datasetId=${directive.datasetId} rows=${String(rendered.rowCount)} ` +
              `format=${directive.format}`,
          );
          return {
            resultText:
              '[privacy-shield-v4] Final answer rendered server-side for ' +
              'the user. The turn is complete — do not restate the answer.',
          };
        }
        const engine = createVerbEngine({
          store,
          classify: createShapeClassifier(),
        });
        const result = dispatchVerbCall(engine, request.toolName, request.input);
        receiptFor(request.turnId).verbsExecuted.push(
          request.toolName.replace(/^v4_/, ''),
        );
        console.log(
          `[privacy-guard v4] verb turn=${request.turnId} ` +
            `tool=${request.toolName} datasetId=${result.digest.datasetId} ` +
            `rows=${String(result.digest.rowCount)}`,
        );
        return { resultText: digestToToolResultText(result.digest) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[privacy-guard v4] tool error turn=${request.turnId} ` +
            `tool=${request.toolName}: ${message}`,
        );
        return { resultText: `[privacy-shield-v4] tool error: ${message}` };
      }
    },

    async takeRenderedAnswerV4(turnId: string): Promise<string | undefined> {
      const text = renderedAnswers.get(turnId);
      renderedAnswers.delete(turnId);
      return text;
    },

    v4ToolSpecs(): ReadonlyArray<PrivacyV4ToolSpec> {
      return [...VERB_TOOL_SPECS, RENDER_TOOL_SPEC].map((spec) => ({
        name: spec.name,
        description: spec.description,
        input_schema: spec.inputSchema,
      }));
    },

    async finalizeTurn(turnId: string): Promise<PrivacyReceipt | undefined> {
      stores.get(turnId)?.finalizeTurn();
      stores.delete(turnId);
      renderedAnswers.delete(turnId);
      const accum = receipts.get(turnId);
      receipts.delete(turnId);
      // No receipt for a turn that interned nothing — there is nothing to
      // report and a zero receipt is just noise in the channel UI.
      if (accum === undefined || accum.datasetsInterned === 0) return undefined;
      console.log(
        `[privacy-guard v4] finalize turn=${turnId} ` +
          `datasets=${String(accum.datasetsInterned)} ` +
          `masked=${String(accum.fieldsMasked)} ` +
          `cleartext=${String(accum.fieldsCleartext)} ` +
          `verbs=[${accum.verbsExecuted.join(',')}]`,
      );
      return {
        datasetsInterned: accum.datasetsInterned,
        fieldsMasked: accum.fieldsMasked,
        fieldsCleartext: accum.fieldsCleartext,
        verbsExecuted: [...accum.verbsExecuted],
        pseudonymProjectionUsed: accum.pseudonymProjectionUsed,
      };
    },
  };
}
