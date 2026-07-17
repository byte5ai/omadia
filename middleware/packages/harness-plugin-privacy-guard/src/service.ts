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
  BypassedToolEntry,
  PrivacyBypassedToolRequest,
  PrivacyGuardService,
  PrivacyPromptMaskRequest,
  PrivacyPromptMaskResult,
  PrivacyReceipt,
  PrivacyRenderedAnswer,
  PrivacySubAgentResultV4Request,
  PrivacyToolResultV4Request,
  PrivacyToolResultV4Result,
  PrivacyV4ToolRequest,
  PrivacyV4ToolSpec,
  PromptMaskedSpanInfo,
  PromptPiiDetector,
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
import {
  createPiiSchemaClassifier,
  type LlmComplete,
  type PiiSchemaClassifier,
} from './v4/piiClassifier.js';
import { createBaselineDetector, maskPrompt } from './promptMask.js';
import { findIdentityLeaks } from './v4/onTheWire.js';
import { resolvePseudonyms } from './v4/pseudonym.js';
import type { PseudonymMap } from './v4/types.js';

/**
 * Collect the identity-bearing string(s) of a single field VALUE into `out`
 * — a plain string, or the display label of an Odoo many2one `[id,"name"]`
 * tuple. Used to gather the REAL values of Haiku-classified PII fields so
 * the receipt can report which ones the user named in their own request.
 * Values shorter than 3 chars are skipped (too loose to match reliably).
 */
function collectIdentityValues(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length >= 3) out.add(value);
    return;
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'string' &&
    value[1].length >= 3
  ) {
    out.add(value[1]);
  }
}

/** Per-turn counters drained into the user-facing `PrivacyReceipt`. */
interface V4ReceiptAccum {
  datasetsInterned: number;
  fieldsMasked: number;
  fieldsCleartext: number;
  readonly verbsExecuted: string[];
  pseudonymProjectionUsed: boolean;
  /** #361 — PII-free records of prompt spans masked this turn. */
  readonly maskedPromptSpans: PromptMaskedSpanInfo[];
}

/** #361 — config key on THIS plugin's install that turns prompt masking on.
 *  Default off: absent/other values mean `maskUserPrompt` reports `disabled`
 *  and the orchestrator proceeds byte-identically to legacy behavior. */
export const MASK_USER_PROMPT_CONFIG_KEY = 'mask_user_prompt';

function isPromptMaskEnabled(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on';
}

const V4_RENDER_NOTE =
  '[privacy-shield-v4] Final answer rendered server-side for the user. ' +
  'The turn is complete — do not restate the answer.';

interface PendingCanvasTreeEnvelope {
  readonly _pendingCanvasTree: {
    readonly tree: {
      readonly type: 'container';
      readonly id: 'pg-render';
      readonly layout: 'stack';
      readonly children: readonly [
        {
          readonly type: 'table';
          readonly id: 'pg-render-table';
          readonly columns: readonly {
            readonly fieldKey: string;
            readonly label: string;
            readonly type?: string;
            readonly privacy?: 'guard-protected';
          }[];
          readonly rows: readonly {
            readonly rowKey: string;
            readonly cells: Record<string, unknown>;
          }[];
        },
      ];
    };
  };
  readonly _note: string;
}

function buildRenderSnapshotResultText(
  structuredTable: NonNullable<ReturnType<typeof materialize>['structuredTable']>,
): string {
  const payload: PendingCanvasTreeEnvelope = {
    _pendingCanvasTree: {
      tree: {
        type: 'container',
        id: 'pg-render',
        layout: 'stack',
        children: [
          {
            type: 'table',
            id: 'pg-render-table',
            columns: structuredTable.columns,
            rows: structuredTable.rows,
          },
        ],
      },
    },
    _note: V4_RENDER_NOTE,
  };
  return JSON.stringify(payload);
}

export function createPrivacyGuardService(deps?: {
  /**
   * Host-LLM accessor (`ctx.llm.complete`) for Slice-2 schema-level PII
   * classification. Absent ⇒ no classifier runs and intern behaves
   * byte-identically to the pre-Slice-2 path — the deny-by-default shape
   * masking is wholly independent of this.
   */
  readonly llmComplete?: LlmComplete;
  /**
   * #361 — live config reader (`ctx.config.get`) for the default-off
   * `mask_user_prompt` flag. Absent ⇒ prompt masking always reports
   * `disabled` (byte-identical legacy behavior).
   */
  readonly readConfig?: (key: string) => unknown;
  /**
   * #361 — the C1 transformer detector slot (Piiranha / GLiNER). Absent ⇒
   * only the C0 regex baseline runs. When present and it THROWS, masking
   * degrades to C0 with a `promptMaskDegraded` audit log (failure-closed
   * tier 1); it never silently passes an unmasked prompt.
   */
  readonly c1Detector?: PromptPiiDetector;
}): PrivacyGuardService {
  // One turn-scoped Dataset Store per turn, minted lazily on the first
  // `internToolResultV4` and dropped by `finalizeTurn`.
  const stores = new Map<string, DatasetStore>();
  // Per-turn stash for the server-materialized final answer produced by a
  // `v4_render_answer` call — the rendered text plus the masked values it
  // resolved behind the boundary.
  const renderedAnswers = new Map<string, PrivacyRenderedAnswer>();
  // Per-turn receipt counters.
  const receipts = new Map<string, V4ReceiptAccum>();
  // Per-turn bag of REAL values from Haiku-classified PII fields. Stays
  // server-side; only the count of those the user named themselves reaches
  // the receipt (`identityValuesOnWire`). Dropped by `finalizeTurn`.
  const turnPiiValues = new Map<string, Set<string>>();
  // Slice 2.5 — per-turn list of tools whose raw results bypassed the
  // boundary (operator set `_privacy_mode=bypass` on the originating
  // plugin). Drained into the receipt by `finalizeTurn`. Entries carry
  // only tool/plugin names + a byte count (no values).
  const bypassedTools = new Map<string, BypassedToolEntry[]>();
  // #361 — per-turn prompt-surrogate map (real↔surrogate), server-side
  // only. Extended across repeated mask calls within one turn (message +
  // ingested attachment tail) so surrogates stay stable; inverted over the
  // final answer by `restorePromptPseudonyms`; dropped by `finalizeTurn`.
  const promptMaskMaps = new Map<string, PseudonymMap>();
  // Slice 2 — cached, Haiku-backed schema PII classifier. Process-scoped
  // (its cache spans turns — schema verdicts are tool-shape-stable). Absent
  // when no host LLM is wired.
  const piiClassifier: PiiSchemaClassifier | undefined =
    deps?.llmComplete !== undefined
      ? createPiiSchemaClassifier({
          complete: deps.llmComplete,
          log: (msg) => {
            console.log(msg);
          },
        })
      : undefined;

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
        maskedPromptSpans: [],
      };
      receipts.set(turnId, r);
    }
    return r;
  }

  /** Intern a raw tool result, update the turn receipt, return the digest
   *  text + datasetId. Shared by `internToolResultV4` and the
   *  `subAgentResultV4` fallback so the receipt accounting lives in one
   *  place. */
  function internAndCount(
    turnId: string,
    toolName: string,
    rawResult: string,
  ): PrivacyToolResultV4Result {
    const store = storeFor(turnId);
    const { digest } = store.internToolResult(toolName, rawResult);
    const maskedFields = digest.fields.filter(
      (f) => f.classification === 'sensitive-masked',
    ).length;
    const receipt = receiptFor(turnId);
    receipt.datasetsInterned += 1;
    receipt.fieldsMasked += maskedFields;
    receipt.fieldsCleartext += digest.fields.length - maskedFields;
    console.log(
      `[privacy-guard v4] intern turn=${turnId} ` +
        `tool=${toolName} datasetId=${digest.datasetId} ` +
        `rows=${String(digest.rowCount)} fields=${String(digest.fields.length)} ` +
        `masked=${String(maskedFields)}${digest.truncated ? ' truncated' : ''}`,
    );
    return {
      digestText: digestToToolResultText(digest),
      datasetId: digest.datasetId,
    };
  }

  return {
    async internToolResultV4(
      request: PrivacyToolResultV4Request,
    ): Promise<PrivacyToolResultV4Result> {
      const result = internAndCount(
        request.turnId,
        request.toolName,
        request.rawResult,
      );
      // Slice 2 — schema-level PII classification. Schema only (field names
      // + types, never a value); cached per tool shape. Never throws; the
      // verdict drives detection only, not masking.
      if (piiClassifier !== undefined) {
        const dataset = stores.get(request.turnId)?.get(result.datasetId);
        if (dataset !== undefined) {
          const piiPaths = await piiClassifier.classify(
            request.toolName,
            dataset.schema.fields.map((f) => ({ path: f.path, type: f.type })),
          );
          // Gather the REAL values of the PII-classified fields so the
          // receipt can report which ones the user named themselves. The
          // values stay server-side — only the count reaches the receipt.
          if (piiPaths.size > 0) {
            let bag = turnPiiValues.get(request.turnId);
            if (bag === undefined) {
              bag = new Set<string>();
              turnPiiValues.set(request.turnId, bag);
            }
            for (const row of dataset.rows) {
              for (const path of piiPaths) {
                collectIdentityValues(row[path], bag);
              }
            }
          }
        }
      }
      return result;
    },

    async recordBypassedTool(
      request: PrivacyBypassedToolRequest,
    ): Promise<void> {
      let list = bypassedTools.get(request.turnId);
      if (list === undefined) {
        list = [];
        bypassedTools.set(request.turnId, list);
      }
      list.push({
        toolName: request.toolName,
        pluginId: request.pluginId,
        reason: request.reason,
        bytes: request.bytes,
      });
      console.log(
        `[privacy-guard v4] bypass turn=${request.turnId} ` +
          `tool=${request.toolName} plugin=${request.pluginId} ` +
          `bytes=${String(request.bytes)} reason=${request.reason}`,
      );
    },

    async runV4Tool(
      request: PrivacyV4ToolRequest,
    ): Promise<{ readonly resultText: string }> {
      const store = storeFor(request.turnId);
      try {
        if (request.toolName === RENDER_TOOL_SPEC.name) {
          const directive = parseRenderDirective(request.input);
          const rendered = materialize(store, directive);
          renderedAnswers.set(request.turnId, {
            text: rendered.text,
            maskedValues: rendered.maskedValues,
          });
          console.log(
            `[privacy-guard v4] render turn=${request.turnId} ` +
              `datasetId=${directive.datasetId} rows=${String(rendered.rowCount)} ` +
              `format=${directive.format}`,
          );
          return {
            resultText:
              rendered.structuredTable !== undefined
                ? buildRenderSnapshotResultText(rendered.structuredTable)
                : V4_RENDER_NOTE,
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

    async subAgentResultV4(
      request: PrivacySubAgentResultV4Request,
    ): Promise<{ readonly resultText: string }> {
      const store = stores.get(request.turnId);
      const digests: string[] = [];
      if (store !== undefined) {
        for (const id of request.datasetIds) {
          const ds = store.get(id);
          if (ds !== undefined) digests.push(JSON.stringify(buildDigest(ds)));
        }
      }
      // No dataset resolved — the sub-agent interned nothing addressable
      // (pure graph lookup, an error, or stale ids). Fall back to interning
      // the narration so the parent agent still gets a usable digest.
      if (digests.length === 0) {
        return {
          resultText: internAndCount(
            request.turnId,
            'sub-agent',
            request.narration,
          ).digestText,
        };
      }
      console.log(
        `[privacy-guard v4] sub-agent bridge turn=${request.turnId} ` +
          `datasets=${String(digests.length)}`,
      );
      const header = [
        '[privacy-shield-v4] A sub-agent fetched data behind the data-plane',
        'boundary. Its working notes are below, then the datasets it produced',
        '— each holds the REAL rows server-side, addressable by its datasetId.',
        'To answer the user, pick the relevant datasetId and call',
        'v4_render_answer (compose the verb tools first if you must filter /',
        'aggregate / join). Include identity / sensitive-masked columns — the',
        'server fills in their real values. If the user instead wants a',
        'downloadable FILE (Excel/.xlsx export, a report), call the file-export',
        'tool (e.g. create_xlsx) with the datasetId rather than v4_render_answer',
        '— the server materializes the real rows into the file. The sub-agent only ever saw',
        '"[masked]"; do NOT repeat any "cannot show" / "filtered" caveat from',
        'its notes — the user receives the real values.',
      ].join('\n');
      return {
        resultText:
          `${header}\n\n--- sub-agent notes ---\n${request.narration}\n\n` +
          `--- datasets (${String(digests.length)}) ---\n${digests.join('\n')}`,
      };
    },

    async takeRenderedAnswerV4(
      turnId: string,
    ): Promise<PrivacyRenderedAnswer | undefined> {
      const answer = renderedAnswers.get(turnId);
      renderedAnswers.delete(turnId);
      return answer;
    },

    // #361 — free-text prompt masking. Failure-closed: there is no
    // pass-through-unmasked outcome. Tier 1: the C1 transformer throwing
    // degrades to C0 results with a `promptMaskDegraded` audit line.
    // Tier 2: the C0 baseline itself failing, or a residual real span
    // surviving substitution (asserted via `findIdentityLeaks`), BLOCKS
    // the turn.
    async maskUserPrompt(
      request: PrivacyPromptMaskRequest,
    ): Promise<PrivacyPromptMaskResult> {
      if (!isPromptMaskEnabled(deps?.readConfig?.(MASK_USER_PROMPT_CONFIG_KEY))) {
        return { outcome: 'disabled' };
      }
      const detectors = [createBaselineDetector()];
      let degraded = false;
      if (deps?.c1Detector) {
        // Run the C1 detector up-front so its failure cannot take the C0
        // baseline down with it (tier-1 degrade, audited); its spans are
        // memoized into a pass-through detector for the mask pass.
        const c1 = deps.c1Detector;
        try {
          const c1Spans = await c1.detect(request.text);
          detectors.push({ id: c1.id, detect: async () => c1Spans });
        } catch (err) {
          degraded = true;
          console.warn(
            `[privacy-guard v4] promptMaskDegraded turn=${request.turnId} ` +
              `detector=${c1.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      try {
        const result = await maskPrompt(
          request.text,
          detectors,
          promptMaskMaps.get(request.turnId),
        );
        // Post-mask invariant: no detected real value may survive in the
        // wire-bound text. A hit means substitution failed — block.
        const residual = findIdentityLeaks(result.maskedText, [
          ...result.map.forward.keys(),
        ]);
        if (residual.length > 0) {
          console.error(
            `[privacy-guard v4] promptMaskBlocked turn=${request.turnId} ` +
              `residual=${String(residual.length)} span(s) survived substitution`,
          );
          return {
            outcome: 'blocked',
            reason: 'residual PII span survived substitution',
          };
        }
        promptMaskMaps.set(request.turnId, result.map);
        const spanInfos: PromptMaskedSpanInfo[] = result.spans.map((s) => ({
          type: s.type,
          detector: s.detector,
        }));
        if (spanInfos.length > 0) {
          receiptFor(request.turnId).maskedPromptSpans.push(...spanInfos);
        }
        console.log(
          `[privacy-guard v4] promptMask turn=${request.turnId} ` +
            `spans=${String(spanInfos.length)}${degraded ? ' degraded=c0-only' : ''}`,
        );
        return {
          outcome: 'masked',
          maskedText: result.maskedText,
          spans: spanInfos,
          degraded,
        };
      } catch (err) {
        // Tier 2 — the baseline path itself failed. Never pass unmasked.
        console.error(
          `[privacy-guard v4] promptMaskBlocked turn=${request.turnId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          outcome: 'blocked',
          reason: 'prompt PII detection failed',
        };
      }
    },

    async restorePromptPseudonyms(turnId: string, text: string): Promise<string> {
      const map = promptMaskMaps.get(turnId);
      if (map === undefined || map.reverse.size === 0) return text;
      return resolvePseudonyms(text, map);
    },

    snapshotPromptRestorer(
      turnId: string,
    ): ((text: string) => string) | undefined {
      const map = promptMaskMaps.get(turnId);
      if (map === undefined || map.reverse.size === 0) return undefined;
      // Self-contained copy: the closure must keep working after
      // `finalizeTurn` dropped the live map — fire-and-forget fact
      // extraction restores extracted facts to real values long after the
      // turn's answer went out.
      const snapshot: PseudonymMap = {
        forward: new Map(map.forward),
        reverse: new Map(map.reverse),
      };
      return (text: string): string => resolvePseudonyms(text, snapshot);
    },

    resolveDatasetForRender(turnId, datasetId) {
      const dataset = stores.get(turnId)?.get(datasetId);
      if (dataset === undefined) return undefined;
      console.log(
        `[privacy-guard v4] resolve-for-render turn=${turnId} ` +
          `datasetId=${datasetId} rows=${String(dataset.rows.length)}`,
      );
      return {
        rowCount: dataset.rows.length,
        columns: dataset.schema.fields.map((f) => ({
          path: f.path,
          type: f.type,
          classification: f.classification,
        })),
        rows: dataset.rows as ReadonlyArray<Record<string, unknown>>,
      };
    },

    v4ToolSpecs(): ReadonlyArray<PrivacyV4ToolSpec> {
      return [...VERB_TOOL_SPECS, RENDER_TOOL_SPEC].map((spec) => ({
        name: spec.name,
        description: spec.description,
        input_schema: spec.inputSchema,
      }));
    },

    async finalizeTurn(
      turnId: string,
      turnInput?: string,
    ): Promise<PrivacyReceipt | undefined> {
      stores.get(turnId)?.finalizeTurn();
      stores.delete(turnId);
      renderedAnswers.delete(turnId);
      // #361 — drop the prompt-surrogate map. `restorePromptPseudonyms`
      // must have run over the final answer before this point.
      promptMaskMaps.delete(turnId);
      const accum = receipts.get(turnId);
      receipts.delete(turnId);
      const piiValues = turnPiiValues.get(turnId);
      turnPiiValues.delete(turnId);
      const bypassed = bypassedTools.get(turnId);
      bypassedTools.delete(turnId);
      // No receipt for a turn that touched neither the boundary, a bypass,
      // nor prompt masking — there is nothing to report and a zero receipt
      // is just noise in the channel UI.
      const hasInterned = accum !== undefined && accum.datasetsInterned > 0;
      const hasBypassed = bypassed !== undefined && bypassed.length > 0;
      const hasMaskedPrompt =
        accum !== undefined && accum.maskedPromptSpans.length > 0;
      if (!hasInterned && !hasBypassed && !hasMaskedPrompt) return undefined;
      // identityValuesOnWire — personal-identity values the requester named
      // in their own message text. A transparency notice (the user put a
      // real identity on the wire), NOT a leak of tool data.
      let identityValuesOnWire = 0;
      if (turnInput !== undefined && piiValues !== undefined) {
        for (const value of piiValues) {
          if (turnInput.includes(value)) identityValuesOnWire += 1;
        }
      }
      console.log(
        `[privacy-guard v4] finalize turn=${turnId} ` +
          `datasets=${String(accum?.datasetsInterned ?? 0)} ` +
          `masked=${String(accum?.fieldsMasked ?? 0)} ` +
          `cleartext=${String(accum?.fieldsCleartext ?? 0)} ` +
          `verbs=[${(accum?.verbsExecuted ?? []).join(',')}] ` +
          `bypassed=${String(bypassed?.length ?? 0)} ` +
          `identityOnWire=${String(identityValuesOnWire)}`,
      );
      return {
        datasetsInterned: accum?.datasetsInterned ?? 0,
        fieldsMasked: accum?.fieldsMasked ?? 0,
        fieldsCleartext: accum?.fieldsCleartext ?? 0,
        verbsExecuted: accum ? [...accum.verbsExecuted] : [],
        pseudonymProjectionUsed: accum?.pseudonymProjectionUsed ?? false,
        identityValuesOnWire,
        ...(hasBypassed ? { bypassedTools: [...bypassed] } : {}),
        ...(hasMaskedPrompt
          ? { maskedPromptSpans: [...accum.maskedPromptSpans] }
          : {}),
      };
    },
  };
}
