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
 *
 * One exception outlives a turn, still in the service closure: the C1
 * segment cache (`c1SegmentCache.ts`) — sha256-keyed span offsets for the
 * recalled tail's stored turns, bounded, holding no text and no value.
 */

import type {
  BypassedToolEntry,
  OperatorClearedFieldEntry,
  PrivacyBypassedToolRequest,
  PrivacyDatasetProvenance,
  PrivacyDigestAudience,
  PrivacyDatasetVerbStep,
  PrivacyEgressStage,
  PrivacyNameDetectorStatus,
  PrivacyNameDetectorTurnState,
  PrivacyPromptOrigin,
  PrivacyStructuredPayloadRequest,
  StructuredPayloadEntry,
  PrivacyGuardService,
  PrivacyPromptMaskRequest,
  PrivacyPromptMaskResult,
  PrivacyReceipt,
  PrivacyRenderedAnswer,
  PrivacyReplayedAnswerRequest,
  PrivacyStoredTextScope,
  PrivacyStoredTextScopeRequest,
  PrivacySubAgentResultV4Request,
  PrivacyToolErrorRedactRequest,
  PrivacyToolErrorRedactResult,
  PrivacyToolErrorRequest,
  PrivacyToolResultV4Request,
  PrivacyToolResultV4Result,
  PrivacyV4ToolRequest,
  PrivacyV4ToolResult,
  PrivacyV4ToolSpec,
  PrivacyVerifierProjectionRequest,
  PromptMaskedSpanInfo,
  PromptPiiDetector,
  PromptPiiSpan,
  ToolErrorEntry,
  UnresolvedSurrogateCountOptions,
} from '@omadia/plugin-api';
import { isControlFlowToolResult } from '@omadia/plugin-api';

import { createDatasetStore } from './v4/datasetStore.js';
import { createShapeClassifier } from './v4/shapeClassifier.js';
import {
  NON_PERSONAL_FIELDS_CONFIG_KEY,
  nonPersonalFieldRule,
  parseNonPersonalFields,
} from './nonPersonalFields.js';
import { buildDigest, digestToToolResultText } from './v4/digest.js';
import type { Classifier, Dataset, DatasetStore } from './v4/types.js';
import { createVerbEngine } from './v4/verbs/index.js';
import {
  RENDER_TOOL_SPEC,
  VERB_TOOL_SPECS,
  dispatchVerbCall,
  parseRenderDirective,
} from './v4/toolDefs.js';
import { FILE_EXPORT_EXCEPTION, RENDER_CONTRACT } from './v4/promptText.js';
import { materialize } from './v4/materializer.js';
import { describeRenderProvenance } from './v4/renderProvenance.js';
import {
  createPiiSchemaClassifier,
  type LlmComplete,
  type PiiSchemaClassifier,
} from './v4/piiClassifier.js';
import {
  baselineHasIdentityPii,
  createBaselineDetector,
  createCustomTermsDetector,
  maskPrompt,
} from './promptMask.js';
import {
  createToolErrorBaselineDetector,
  redactToolErrorSpans,
  withoutMaskMarkers,
} from './toolErrorRedact.js';
import { findIdentityLeaks } from './v4/onTheWire.js';
import { c1SegmentKey, createC1SegmentCache } from './c1SegmentCache.js';
import { propagatePersonNames } from './c1NamePropagation.js';
import {
  findResidualRealValues,
  remaskKnownValues,
  resolvePromptPseudonyms,
  restoreToolInputSurrogates,
} from './promptSurrogates.js';
import { countIdentityValuesNamed } from './identityOnWire.js';
import type { PseudonymMap } from './v4/types.js';
import {
  countUnresolvedSurrogates as countResidualSurrogates,
  createBaselineIdentityDetector,
  createIdentityValuesDetector,
  hasSurrogateCollision,
} from './verifierProjection.js';
import { createStoredTextScope } from './storedTextScope.js';
import { createTurnSerialQueue } from './turnSerialQueue.js';
import { createFieldClassificationService } from './fieldClassificationService.js';

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

/**
 * The canvas orchestrator's producer tools (`@omadia/ui-orchestrator`
 * plugin.ts). Their results are still INTERNED — a `datasetId` publish
 * resolves real rows — but they skip the Haiku schema classifier: its verdict
 * only feeds the receipt's `identityValuesOnWire` count (never masking), and
 * the rows they publish come from a source tool result whose values were
 * classified when IT was interned. Without this, every canvas turn paid one
 * Haiku round per publish for a count that cannot change.
 */
const CANVAS_PRODUCER_TOOLS: ReadonlySet<string> = new Set([
  'canvas_publish_rows',
  'canvas_publish_choice',
  'canvas_publish_lumen',
]);

/** #1556 follow-up — tools whose results are never field-classification
 *  candidates, on top of the `odoo_` scope: sub-agent narration and the
 *  canvas producers (their rows come from an already-observed source). */
const OBSERVATION_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'sub-agent',
  ...CANVAS_PRODUCER_TOOLS,
]);

/** Per-turn counters drained into the user-facing `PrivacyReceipt`. */
interface V4ReceiptAccum {
  datasetsInterned: number;
  fieldsMasked: number;
  fieldsCleartext: number;
  readonly verbsExecuted: string[];
  pseudonymProjectionUsed: boolean;
  /** #361 / #1541 — spans masked in the user's own text this turn, one per
   *  distinct value. Keyed by the value's surrogate (server-side state,
   *  dropped with the turn); the receipt gets the PII-free records only. */
  readonly promptSpans: Map<string, PromptMaskedSpanInfo>;
  /** #1541 — spans masked in text from earlier conversations, one per
   *  distinct value not already booked as the user's own. */
  readonly contextSpans: Map<string, PromptMaskedSpanInfo>;
  /** #1562 — free text of this turn went through the detectors. */
  freeTextScanned: boolean;
  /** #1562 — some scan of this turn ran without a configured C1, read when
   *  the text was masked (a config change mid-turn cannot relabel it). */
  scannedWithoutC1: boolean;
  /** Answer-verifier requests gated under this turn's privacy view. */
  verifierRequests: number;
  /** PII-free records of spans masked in verifier-bound text. */
  readonly verifierMaskedSpans: PromptMaskedSpanInfo[];
}

/** #361 — config key on THIS plugin's install that turns prompt masking on.
 *  Default off: absent/other values mean `maskUserPrompt` reports `disabled`
 *  and the orchestrator proceeds byte-identically to legacy behavior. */
export const MASK_USER_PROMPT_CONFIG_KEY = 'mask_user_prompt';

/** #760 — operator deny-list config keys (multiline strings, one entry per
 *  line): literal terms and advanced regex patterns. Both feed the
 *  'custom-terms' detector alongside the C0 baseline. */
export const CUSTOM_TERMS_CONFIG_KEY = 'custom_terms';
export const CUSTOM_PATTERNS_CONFIG_KEY = 'custom_patterns';

function isPromptMaskEnabled(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on';
}

/** Split a config value into entries. Terms additionally split on ';' (their
 *  setup field is a single-line input); patterns split ONLY on newlines —
 *  ';' is legal inside a regex and silently splitting one would corrupt it,
 *  so their field is `multiline` (#1525). */
function configLines(value: unknown, alsoSemicolon: boolean): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(alsoSemicolon ? /[\n;]/ : '\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** #760 — build the fingerprint-cached custom-detector resolver. Pattern
 *  vetting runs a wall-clock probe, so construction must happen on config
 *  CHANGE, not on every turn; rejected patterns are logged once per config
 *  change — an operator who typed a protection must learn it is not active.
 *  The cache lives in the SERVICE closure (returned resolver), never at
 *  module level: two service instances with different configs would
 *  alternate-thrash a shared slot, re-running the probe budget and
 *  re-emitting the rejection log on every turn (review M4). */
function makeCustomDetectorResolver(): (
  readConfig: ((key: string) => unknown) | undefined,
) => PromptPiiDetector | undefined {
  let cache: { fingerprint: string; detector: PromptPiiDetector | undefined } | undefined;
  return (readConfig) => {
    const terms = configLines(readConfig?.(CUSTOM_TERMS_CONFIG_KEY), true);
    const patterns = configLines(readConfig?.(CUSTOM_PATTERNS_CONFIG_KEY), false);
    const fingerprint = JSON.stringify([terms, patterns]);
    if (cache?.fingerprint === fingerprint) {
      return cache.detector;
    }
    const { detector, rejected } = createCustomTermsDetector({ terms, patterns });
    for (const r of rejected) {
      console.error(
        `[privacy-guard v4] customPatternRejected reason=${r.reason} pattern=${JSON.stringify(r.source)} — this protection is NOT active`,
      );
    }
    cache = { fingerprint, detector };
    return detector;
  };
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

type RenderedStructuredTable = NonNullable<
  ReturnType<typeof materialize>['structuredTable']
>;

/** #1402 — the `_pendingCanvasTree` snapshot of a table render. It carries the
 *  REAL cell values, so it leaves `runV4Tool` only as `canvasSentinel` (the
 *  kernel's pre-intern canvas side channel) and never as the `resultText` the
 *  model reads back. */
function buildRenderSnapshotSentinel(structuredTable: RenderedStructuredTable): string {
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

/** #1402 — the model's `tool_result` for a render: shape only (row counts,
 *  the column labels the model itself chose, the columns that could not be
 *  rendered, the provenance note), never a cell. */
function buildRenderAckText(
  rendered: ReturnType<typeof materialize>,
  provenance: string | undefined,
): string {
  const parts = [V4_RENDER_NOTE];
  const table = rendered.structuredTable;
  if (table !== undefined) {
    const labels = table.columns.map((c) => c.label);
    const rows =
      rendered.renderedRowCount < rendered.rowCount
        ? `${String(rendered.renderedRowCount)} of ${String(rendered.rowCount)} rows`
        : `${String(rendered.rowCount)} rows`;
    parts.push(`Rendered a table with ${rows}; columns: ${JSON.stringify(labels)}.`);
  }
  // #1542 — a column whose cells could not be rendered is not silently
  // empty: the server put a note under the table, and the model learns it
  // so it never claims that column's content was shown.
  if (rendered.unrenderedColumns.length > 0) {
    parts.push(
      `Could not be rendered: ${JSON.stringify(rendered.unrenderedColumns)} — those ` +
        'cells show a "not renderable" marker, the content is withheld, and a ' +
        'server note under the table told the user that an administrator can ' +
        "set the agent's privacy mode to bypass to show it. You may state this " +
        'fact; never claim that content was shown.',
    );
  }
  // #1543 — the rows are gone next turn; this is what a follow-up re-runs.
  if (provenance !== undefined) parts.push(provenance);
  return parts.join(' ');
}

/**
 * #1097 — true when a dataset is one control-flow string and nothing else (a
 * tool error or MCP auth prompt that reached the store by a route the dispatch
 * guards do not cover, e.g. a masked thrown exception). Decided on the SOURCE
 * cell, not on the materialized text: the model's prose and the list/table
 * framing around the value would hide the prefix.
 */
function isControlFlowDataset(dataset: Dataset | undefined): boolean {
  if (dataset === undefined || dataset.rows.length !== 1) return false;
  const cells = Object.values(dataset.rows[0] ?? {});
  const only = cells[0];
  return (
    cells.length === 1 &&
    typeof only === 'string' &&
    isControlFlowToolResult(only)
  );
}

/** Longest verb chain walked back to its origin — a guard, verbs nest shallowly. */
const MAX_PROVENANCE_HOPS = 16;

/** Copy of a JSON-shaped tool input; `undefined` when it is not JSON. */
function copyToolInput(input: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(input)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Walk a dataset's `derivedFrom` chain back to the tool result it came from.
 * The verbs come out in application order (origin first). No provenance when
 * the origin carries no tool input (interned without it, a sub-agent
 * narration, a canvas producer) or the chain is broken/too deep.
 */
function datasetProvenanceOf(
  store: DatasetStore | undefined,
  datasetId: string,
): PrivacyDatasetProvenance | undefined {
  let ds = store?.get(datasetId);
  const verbs: PrivacyDatasetVerbStep[] = [];
  for (let hops = 0; ds?.provenance.derivedFrom !== undefined; hops++) {
    if (hops >= MAX_PROVENANCE_HOPS) return undefined;
    verbs.unshift({ verb: ds.provenance.toolName, args: ds.provenance.verbArgs ?? {} });
    ds = store?.get(ds.provenance.derivedFrom);
  }
  if (ds?.provenance.toolInput === undefined) return undefined;
  const input = copyToolInput(ds.provenance.toolInput);
  if (input === undefined) return undefined;
  return {
    tool: ds.provenance.toolName,
    input,
    verbs: verbs.map((v) => ({ verb: v.verb, args: copyToolInput(v.args) as Record<string, unknown> })),
    truncated: ds.provenance.truncated,
    // an envelope origin: where a replay finds the records (v414)
    ...(ds.envelope !== undefined ? { itemsPath: ds.envelope.itemsPath } : {}),
  };
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
  /**
   * Identity of the C1 detector's LIVE configuration (the plugin passes its
   * sidecar-URL resolver). Part of the process-wide segment-cache key, so a
   * reconfigured sidecar never serves the previous one's spans; `undefined`
   * means C1 is currently unconfigured (its `detect()` returns `[]`) and
   * nothing is cached — a configured sidecar later must not be shadowed by
   * those empty results. Absent ⇒ one fixed scope (a detector whose
   * configuration cannot change, e.g. in tests).
   */
  readonly c1CacheScope?: () => string | undefined;
  /**
   * #1562 — probe the configured C1 sidecar now: where its URL comes from and
   * whether its health endpoint answers. The plugin passes one built on the
   * same live URL resolver as `c1Detector`. Absent ⇒ `nameDetectorStatus`
   * reports from `c1Detector`/`c1CacheScope` alone (`active` when configured).
   */
  readonly probeC1?: () => Promise<{
    readonly source: 'setup' | 'env' | null;
    readonly reachable: boolean;
  }>;
  /**
   * #1556 follow-up — the C1 detector at the lower near-miss threshold
   * (`C1_NEAR_MISS_THRESHOLD`), on the background lane, for vetting a masked
   * field's value sample. Absent ⇒ `vetFieldSample` uses `c1Detector` and
   * can report `hit` but never `near-miss`. Only used while C1 is
   * configured (`c1CacheScope`).
   */
  readonly c1NearMissDetector?: PromptPiiDetector;
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
  const operatorClearedFields = new Map<string, Map<string, OperatorClearedFieldEntry>>();
  // #547 / #569 — per-turn list of external MCP tools that returned
  // `structuredContent`. Recorded by the boot-wired `structuredSink` so the
  // receipt accounts for the sidecar that otherwise fires beneath every
  // dispatcher. Drained into the receipt by `finalizeTurn`. Accounting only —
  // the payload never crossed the model boundary, so nothing here is masked;
  // entries carry tool/server names + a byte count + a schema flag, no value.
  const structuredPayloads = new Map<string, StructuredPayloadEntry[]>();
  // Per-turn list of tool errors the dispatch seams withheld, redacted or
  // passed. Drained into the receipt by `finalizeTurn`. Entries carry tool
  // name, carrier, outcome, a byte count and masked span TYPES — no text.
  const toolErrors = new Map<string, ToolErrorEntry[]>();
  // #361 — per-turn prompt-surrogate map (real↔surrogate), server-side
  // only. Extended across repeated mask calls within one turn (message +
  // ingested attachment tail) so surrogates stay stable; inverted over the
  // final answer by `restorePromptPseudonyms`; dropped by `finalizeTurn`.
  const promptMaskMaps = new Map<string, PseudonymMap>();
  // A mask call reads the turn's map, awaits its detectors and writes the
  // extended map back; two interleaved calls — the answer verifier's judge
  // projects its requests in parallel — would both mint from the same base,
  // hand the same placeholder to different values, and the later write would
  // drop the earlier call's entries. So that read-modify-write runs one call
  // at a time per turn (detection by the C1 sidecar still runs concurrently,
  // before a call joins the queue).
  const serialPerTurn = createTurnSerialQueue();

  // #979 / #980 — per-turn C1 state. TWO mechanisms, because the two things
  // being avoided have different keys.
  //
  // A single turn calls `maskUserPrompt` roughly a dozen times: the user
  // message, each prior turn, ingested attachment text, recalled context,
  // plus the fact-extraction, routing and excerpt passes. #979 assumed those
  // passes largely repeat the SAME text and cached results keyed by text.
  // Measured after deploying it, the turn time did not move (20.0 s vs
  // 19.9 s): the passes carry DIFFERENT text, so a text-keyed cache almost
  // always misses. It is kept — repeats do happen, and a hit is free — but
  // it is not the thing that matters.
  //
  // What matters is the failure path, and #979 got its key wrong. C1's
  // timeout is 15 s (deliberately generous, see c1Detector.ts). A sidecar
  // that is DOWN is down for every text, so keying the "already failed"
  // memo by text meant a dozen distinct texts each paid a fresh 15 s
  // timeout: ~3 minutes of wall clock to reach the C0 fallback the first
  // attempt already reached. Before the timeout was raised the same failure
  // cost 18 s, so that was a regression, and the text-keyed memo did not
  // close it.
  //
  // Hence a per-TURN latch: the first failure marks the turn degraded and
  // every later call in it skips the network entirely. Correctness is
  // unaffected — those calls degrade to C0 exactly as they would have after
  // waiting, and each still reports `degraded: true` honestly.
  //
  // Both structures are per-turn state dropped by `finalizeTurn`, like
  // `promptMaskMaps`: cached spans carry real PII values, so they must not
  // outlive the turn that produced them or be reachable from another user's
  // turn.
  const c1Cache = new Map<string, Map<string, readonly PromptPiiSpan[]>>();
  const c1FailedTurns = new Set<string>();
  // #1562 — when C1 last failed in any turn, for the operator's posture.
  let lastC1FailureAt: Date | undefined;
  /** Is a C1 detector configured right now? An unconfigured sidecar URL
   *  makes the detector report no spans without a call. */
  const c1Configured = (): boolean =>
    deps?.c1Detector !== undefined &&
    (deps.c1CacheScope === undefined || deps.c1CacheScope() !== undefined);
  const c1CacheGet = (
    turnId: string,
    text: string,
  ): readonly PromptPiiSpan[] | undefined => c1Cache.get(turnId)?.get(text);
  const c1CacheSet = (
    turnId: string,
    text: string,
    spans: readonly PromptPiiSpan[],
  ): void => {
    let perTurn = c1Cache.get(turnId);
    if (perTurn === undefined) {
      perTurn = new Map<string, readonly PromptPiiSpan[]>();
      c1Cache.set(turnId, perTurn);
    }
    perTurn.set(text, spans);
  };

  /**
   * #979 / #980 — the C1 step shared by prompt masking, the verifier
   * projection and tool-error redaction, so all three run the SAME detector
   * assembly: the per-turn span cache, the per-turn degrade latch, and an
   * audited tier-1 degrade to the baseline. Runs C1 up-front so its failure
   * cannot take the baseline down with it; its spans are memoized into a
   * pass-through detector for the substitution pass. A down sidecar costs one
   * timeout per turn, not one per call. `degraded` reports the C0-only fall
   * back; it is audited here and never passes text through unmasked.
   */
  async function c1DetectorFor(
    turnId: string,
    text: string,
    degradeLogTag: string,
  ): Promise<{ readonly detector?: PromptPiiDetector; readonly degraded: boolean }> {
    const c1 = deps?.c1Detector;
    if (c1 === undefined) return { degraded: false };
    // Nothing to detect — e.g. a verifier request that carries only the
    // turn's wire view books itself with an empty text. No sidecar call.
    if (text.trim().length === 0) return { degraded: false };
    if (c1FailedTurns.has(turnId)) {
      // C1 already failed once in THIS turn. A down sidecar is down for
      // every text, so retrying only buys another full timeout — a dozen
      // of which is ~3 minutes for the C0 result the first attempt
      // already produced. Degrade immediately, still audited by the caller.
      return { degraded: true };
    }
    const cached = c1CacheGet(turnId, text);
    if (cached !== undefined) {
      return { detector: { id: c1.id, detect: async () => cached }, degraded: false };
    }
    const startedAt = Date.now();
    try {
      const c1Spans = await c1.detect(text);
      logC1Detect({ startedAt, text, turnId, spans: c1Spans.length, cached: 0, total: 1 });
      c1CacheSet(turnId, text, c1Spans);
      return { detector: { id: c1.id, detect: async () => c1Spans }, degraded: false };
    } catch (err) {
      logC1Detect({ startedAt, text, turnId, spans: 0, cached: 0, total: 1, failed: true });
      return latchC1Failure(turnId, c1.id, degradeLogTag, err);
    }
  }

  /** The sidecar is an HTTP hop with a generous timeout — its wall time is
   *  logged on every outcome so a slow pass is visible in the turn log, not
   *  a silent gap. `cached=<n>/<total>`: segments served from the
   *  process-wide segment cache out of those that needed detection. */
  function logC1Detect(entry: {
    readonly startedAt: number;
    readonly text: string;
    readonly turnId: string;
    readonly spans: number;
    readonly cached: number;
    readonly total: number;
    readonly failed?: boolean;
  }): void {
    console.log(
      `[privacy-guard v4] c1-detect ms=${String(Date.now() - entry.startedAt)} ` +
        `chars=${String(entry.text.length)} spans=${String(entry.spans)} ` +
        `cached=${String(entry.cached)}/${String(entry.total)} ` +
        `turn=${entry.turnId}${entry.failed === true ? ' failed' : ''}`,
    );
  }

  /** #980 — the first C1 failure marks the turn degraded (see the latch
   *  rationale above); audited, and the caller falls back to C0. */
  function latchC1Failure(
    turnId: string,
    detectorId: string,
    degradeLogTag: string,
    err: unknown,
  ): { readonly degraded: true } {
    c1FailedTurns.add(turnId);
    lastC1FailureAt = new Date();
    console.warn(
      `[privacy-guard v4] ${degradeLogTag} turn=${turnId} ` +
        `detector=${detectorId}: ${err instanceof Error ? err.message : String(err)} ` +
        `(C1 disabled for the remainder of this turn)`,
    );
    return { degraded: true };
  }

  // Process-wide C1 span cache for the recalled tail, keyed by sha256 of
  // each stored-turn segment (see `c1SegmentCache.ts`). Unlike `c1Cache` it
  // outlives the turn: it holds no text and no value — offsets, type and
  // confidence only — so there is nothing in it to drop at `finalizeTurn`.
  const c1SegmentCache = createC1SegmentCache();
  // A fixed scope for a detector whose configuration cannot change.
  const readC1CacheScope = deps?.c1CacheScope ?? ((): string => '');

  /**
   * `c1DetectorFor` for text the caller hands over as a partition of whole
   * stored units (`segments.join('') === text`): C1 runs per segment, a
   * segment already scanned in ANY earlier turn is served from the
   * process-wide cache, and the segment spans are shifted onto `text`'s
   * offsets. Only cache misses reach the sidecar. Failure behaviour is that
   * of `c1DetectorFor`: the per-turn latch first, and the first failing
   * segment degrades the WHOLE text to C0 (no partial C1 result) and latches
   * the turn. A list that is not a partition of `text` is ignored.
   */
  async function c1SegmentedDetectorFor(
    turnId: string,
    text: string,
    segments: readonly string[] | undefined,
    degradeLogTag: string,
  ): Promise<{ readonly detector?: PromptPiiDetector; readonly degraded: boolean }> {
    if (segments === undefined || segments.join('') !== text) {
      return c1DetectorFor(turnId, text, degradeLogTag);
    }
    const c1 = deps?.c1Detector;
    if (c1 === undefined) return { degraded: false };
    if (text.trim().length === 0) return { degraded: false };
    if (c1FailedTurns.has(turnId)) return { degraded: true };

    const startedAt = Date.now();
    const spans: PromptPiiSpan[] = [];
    let offset = 0;
    let cached = 0;
    let total = 0;
    for (const segment of segments) {
      const base = offset;
      offset += segment.length;
      // Nothing to detect in a blank segment (a separator) — same rule as a
      // blank whole text; the sidecar would chunk it to nothing.
      if (segment.trim().length === 0) continue;
      total += 1;
      const segmentSpans = await detectSegment(c1, segment);
      if (segmentSpans instanceof Error) {
        logC1Detect({ startedAt, text, turnId, spans: 0, cached, total, failed: true });
        return latchC1Failure(turnId, c1.id, degradeLogTag, segmentSpans);
      }
      if (segmentSpans.cached) cached += 1;
      for (const s of segmentSpans.spans) {
        spans.push({ ...s, start: s.start + base, end: s.end + base });
      }
    }
    // Per-segment detection loses GLiNER's cross-turn context (a surname-only
    // "Frau Weißenborn" in one turn, the full name in another): propagate
    // person-name tokens over the full text. Only adds spans; runs on cached
    // and uncached passes alike, so both stay identical.
    const propagated = propagatePersonNames(text, spans);
    logC1Detect({ startedAt, text, turnId, spans: propagated.length, cached, total });
    return { detector: { id: c1.id, detect: async () => propagated }, degraded: false };
  }

  /** One segment through the process-wide cache. A miss calls the detector
   *  and caches the result only when the detector's configuration scope was
   *  the same before and after the call (and defined — see `c1CacheScope`).
   *  Returns the thrown error instead of throwing. */
  async function detectSegment(
    c1: PromptPiiDetector,
    segment: string,
  ): Promise<{ readonly spans: readonly PromptPiiSpan[]; readonly cached: boolean } | Error> {
    const scope = readC1CacheScope();
    const key = scope === undefined ? undefined : c1SegmentKey(c1.id, scope, segment);
    const hit = key === undefined ? undefined : c1SegmentCache.get(key);
    if (hit !== undefined) return { spans: hit, cached: true };
    try {
      const detected = await c1.detect(segment);
      if (key !== undefined && readC1CacheScope() === scope) c1SegmentCache.set(key, detected);
      return { spans: detected, cached: false };
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  // #760 — per-service fingerprint cache for the operator deny-list detector.
  const resolveCustomDetector = makeCustomDetectorResolver();
  // #1556 follow-up — field-classification suggestions: schema-only
  // observations and a bounded value sample (`fieldClassificationService.ts`).
  const fieldClassification = createFieldClassificationService({
    datasetOf: (turnId, datasetId) => stores.get(turnId)?.get(datasetId),
    excludedTools: OBSERVATION_EXCLUDED_TOOLS,
    customDetector: () => resolveCustomDetector(deps?.readConfig),
    c1Detector: () =>
      c1Configured() ? (deps?.c1NearMissDetector ?? deps?.c1Detector) : undefined,
    ...(deps?.llmComplete !== undefined ? { llmComplete: deps.llmComplete } : {}),
  });
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

  // #1556 — the operator's non-personal fields, re-read whenever a classifier
  // is built (once per turn store, once per verb call), so a saved setting
  // applies from the next turn without a restart. Rejected entries are logged
  // once per distinct config value.
  let loggedNonPersonalConfig: string | undefined;
  function shapeClassifier(): Classifier {
    const value: unknown = deps?.readConfig?.(NON_PERSONAL_FIELDS_CONFIG_KEY);
    const raw = typeof value === 'string' ? value : undefined;
    const parsed = parseNonPersonalFields(raw);
    if ((raw ?? '') !== (loggedNonPersonalConfig ?? '')) {
      loggedNonPersonalConfig = raw ?? '';
      if (parsed.entries.length > 0 || parsed.rejected.length > 0) {
        console.log(
          `[privacy-guard v4] nonPersonalFields entries=${String(parsed.entries.length)}` +
            (parsed.rejected.length > 0
              ? ` rejected=${JSON.stringify(parsed.rejected)} — use tool:field, *:field or field; __k_ link keys are never allowed`
              : ''),
        );
      }
    }
    return createShapeClassifier({
      // The C0 baseline's IDENTITY types as one-way booster: a column of
      // bare phone numbers or IBANs is all digits/letters and would clear as
      // an `id` handle — and a small dataset's digest inlines every value of
      // a safe column. Uploaded tables now deliver real values into this
      // store, so that column must be masked. Dates and amounts are NOT in
      // the booster: they must stay filterable. A miss never promotes (D4).
      // It also outranks an operator's non-personal rule.
      detector: baselineHasIdentityPii,
      ...(parsed.entries.length > 0 ? { nonPersonal: nonPersonalFieldRule(parsed.entries) } : {}),
    });
  }

  function storeFor(turnId: string): DatasetStore {
    let s = stores.get(turnId);
    if (s === undefined) {
      s = createDatasetStore({
        classify: shapeClassifier(),
        buildDigest,
        turnId,
      });
      stores.set(turnId, s);
    }
    return s;
  }

  /** Book a masked text into the receipt. `verifier` counts one request even
   *  when nothing was masked — the request left the process either way.
   *  The turn's own egress books each distinct value once (#1541): the same
   *  message reaches several of the turn's model calls (screener, main call,
   *  fact extraction), and a value counts as the user's own whenever it
   *  occurs in their text, as earlier context otherwise. */
  function recordMasked(
    turnId: string,
    stage: PrivacyEgressStage,
    origin: PrivacyPromptOrigin,
    spans: ReadonlyArray<{ readonly key: string; readonly info: PromptMaskedSpanInfo }>,
  ): void {
    const receipt = receiptFor(turnId);
    if (stage === 'verifier') {
      receipt.verifierRequests += 1;
      receipt.verifierMaskedSpans.push(...spans.map((s) => s.info));
      return;
    }
    receipt.freeTextScanned = true;
    if (!c1Configured()) receipt.scannedWithoutC1 = true;
    for (const { key, info } of spans) {
      if (origin === 'message') {
        receipt.contextSpans.delete(key);
        if (!receipt.promptSpans.has(key)) receipt.promptSpans.set(key, info);
      } else if (!receipt.promptSpans.has(key) && !receipt.contextSpans.has(key)) {
        receipt.contextSpans.set(key, info);
      }
    }
  }

  interface MaskArgs {
    readonly turnId: string;
    readonly text: string;
    readonly detectors: readonly PromptPiiDetector[];
    readonly degraded: boolean;
    readonly stage: PrivacyEgressStage;
    /** #1541 — whose text this is (see `PrivacyPromptMaskRequest.origin`). */
    readonly origin: PrivacyPromptOrigin;
    readonly preview: boolean;
    /** Refusal judged on the turn's map as it stands when this call's turn
     *  in the queue comes; `undefined` lets the call proceed. */
    readonly precheck?: (map: PseudonymMap | undefined) => PrivacyPromptMaskResult | undefined;
  }

  /**
   * Substitute detected spans through the turn's map and enforce the
   * post-mask invariant. Failure-closed: a residual real span, or the
   * detection pass itself failing, is `blocked` — never a pass-through.
   * `preview` computes the outcome without extending the map or booking
   * anything, so a caller can ask "would this text change?" for free.
   * Calls of one turn run one at a time (see `serialPerTurn`).
   */
  function maskThroughTurnMap(args: MaskArgs): Promise<PrivacyPromptMaskResult> {
    return serialPerTurn(args.turnId, () => maskOnce(args));
  }

  async function maskOnce(args: MaskArgs): Promise<PrivacyPromptMaskResult> {
    const { turnId, text, detectors, degraded, stage, origin, preview } = args;
    const label = stage === 'verifier' ? 'verifierMask' : 'promptMask';
    const refused = args.precheck?.(promptMaskMaps.get(turnId));
    if (refused !== undefined) return refused;
    try {
      const result = await maskPrompt(text, detectors, promptMaskMaps.get(turnId));
      // Post-mask invariant: no detected real value may survive in the
      // wire-bound text outside a surrogate. A hit means substitution failed
      // — block. A term inside the shield's own placeholder is no hit
      // (#1529).
      const residual = findResidualRealValues(result.maskedText, result.map);
      if (residual.length > 0) {
        console.error(
          `[privacy-guard v4] ${label}Blocked turn=${turnId} ` +
            `residual=${String(residual.length)} span(s) survived substitution`,
        );
        return {
          outcome: 'blocked',
          reason: 'residual PII span survived substitution',
        };
      }
      const spanInfos: PromptMaskedSpanInfo[] = result.spans.map((s) => ({
        type: s.type,
        detector: s.detector,
      }));
      if (!preview) {
        promptMaskMaps.set(turnId, result.map);
        recordMasked(
          turnId,
          stage,
          origin,
          result.spans.map((s, i) => ({
            key: result.map.forward.get(s.value) ?? s.value,
            info: spanInfos[i]!,
          })),
        );
        console.log(
          `[privacy-guard v4] ${label} turn=${turnId} ` +
            `spans=${String(spanInfos.length)}${degraded ? ' degraded=c0-only' : ''}`,
        );
      }
      return {
        outcome: 'masked',
        maskedText: result.maskedText,
        spans: spanInfos,
        degraded,
      };
    } catch (err) {
      // Tier 2 — the baseline path itself failed. Never pass unmasked.
      console.error(
        `[privacy-guard v4] ${label}Blocked turn=${turnId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        outcome: 'blocked',
        reason: 'prompt PII detection failed',
      };
    }
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
        promptSpans: new Map(),
        contextSpans: new Map(),
        freeTextScanned: false,
        scannedWithoutC1: false,
        verifierRequests: 0,
        verifierMaskedSpans: [],
      };
      receipts.set(turnId, r);
    }
    return r;
  }

  // #1556 — the receipt names every field an operator rule cleared, record
  // columns and envelope metadata alike. Here, not in `internToolResultV4`,
  // so every intern path is covered.
  function recordOperatorCleared(turnId: string, toolName: string, datasetId: string): void {
    const dataset = stores.get(turnId)?.get(datasetId);
    const cleared = [
      ...(dataset?.schema.fields ?? []),
      ...(dataset?.envelope?.schema.fields ?? []),
    ].filter((f) => f.type === 'label' && f.classification === 'safe-cleartext');
    if (cleared.length === 0) return;
    let entries = operatorClearedFields.get(turnId);
    if (entries === undefined) {
      entries = new Map();
      operatorClearedFields.set(turnId, entries);
    }
    for (const f of cleared) {
      entries.set(`${toolName}\u0000${f.path}`, { toolName, field: f.path });
    }
    console.log(
      `[privacy-guard v4] nonPersonalCleared turn=${turnId} tool=${toolName} ` +
        `fields=${JSON.stringify([...new Set(cleared.map((f) => f.path))])}`,
    );
  }

  /** Intern a raw tool result, update the turn receipt, return the digest
   *  text + datasetId. Shared by `internToolResultV4` and the
   *  `subAgentResultV4` fallback so the receipt accounting lives in one
   *  place. */
  function internAndCount(
    turnId: string,
    toolName: string,
    rawResult: string,
    toolInput?: unknown,
    audience?: PrivacyDigestAudience,
  ): PrivacyToolResultV4Result {
    const store = storeFor(turnId);
    const { digest } = store.internToolResult(toolName, rawResult, toolInput);
    // The receipt counts every field the digest exposes — record columns AND
    // envelope metadata (both reach the model, masked or in clear).
    const metadata = digest.metadata ?? [];
    const exposed = [...digest.fields, ...metadata];
    const maskedFields = exposed.filter(
      (f) => f.classification === 'sensitive-masked',
    ).length;
    recordOperatorCleared(turnId, toolName, digest.datasetId);
    fieldClassification.record(turnId, toolName, digest.datasetId);
    const receipt = receiptFor(turnId);
    receipt.datasetsInterned += 1;
    receipt.fieldsMasked += maskedFields;
    receipt.fieldsCleartext += exposed.length - maskedFields;
    console.log(
      `[privacy-guard v4] intern turn=${turnId} ` +
        `tool=${toolName} datasetId=${digest.datasetId} ` +
        `rows=${String(digest.rowCount)} fields=${String(digest.fields.length)} ` +
        `${metadata.length > 0 ? `metadata=${String(metadata.length)} ` : ''}` +
        `masked=${String(maskedFields)}${digest.truncated ? ' truncated' : ''}`,
    );
    return {
      digestText: digestToToolResultText(digest, audience !== undefined ? { audience } : undefined),
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
        request.toolInput,
        request.audience,
      );
      // Slice 2 — schema-level PII classification. Schema only (field names
      // + types, never a value); cached per tool shape. Never throws; the
      // verdict drives detection only, not masking. Canvas producers are
      // interned above but not classified (see CANVAS_PRODUCER_TOOLS).
      if (piiClassifier !== undefined && !CANVAS_PRODUCER_TOOLS.has(request.toolName)) {
        const dataset = stores.get(request.turnId)?.get(result.datasetId);
        if (dataset !== undefined) {
          // Envelope metadata is classified too (record paths win a name
          // collision) — it used to be, as broadcast columns.
          const metaFields = (dataset.envelope?.schema.fields ?? []).filter(
            (m) => !dataset.schema.fields.some((f) => f.path === m.path),
          );
          const piiPaths = await piiClassifier.classify(
            request.toolName,
            [...dataset.schema.fields, ...metaFields].map((f) => ({
              path: f.path,
              type: f.type,
            })),
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
            for (const m of metaFields) {
              if (piiPaths.has(m.path)) {
                collectIdentityValues(dataset.envelope?.values[m.path], bag);
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

    async recordStructuredPayload(
      request: PrivacyStructuredPayloadRequest,
    ): Promise<void> {
      let list = structuredPayloads.get(request.turnId);
      if (list === undefined) {
        list = [];
        structuredPayloads.set(request.turnId, list);
      }
      list.push({
        toolName: request.toolName,
        serverName: request.serverName,
        bytes: request.bytes,
        hasOutputSchema: request.hasOutputSchema,
      });
      console.log(
        `[privacy-guard v4] structured turn=${request.turnId} ` +
          `tool=${request.toolName} server=${request.serverName} ` +
          `bytes=${String(request.bytes)} ` +
          `outputSchema=${String(request.hasOutputSchema)}`,
      );
    },

    async recordToolError(request: PrivacyToolErrorRequest): Promise<void> {
      let list = toolErrors.get(request.turnId);
      if (list === undefined) {
        list = [];
        toolErrors.set(request.turnId, list);
      }
      // Copy field by field: the entry lands in a receipt that is PII-free by
      // construction, so nothing a caller attached beyond the contract rides
      // along.
      const spans = (request.redactedSpans ?? []).map((s) => ({
        type: s.type,
        detector: s.detector,
      }));
      list.push({
        toolName: request.toolName,
        carrier: request.carrier,
        outcome: request.outcome,
        bytes: request.bytes,
        ...(spans.length > 0 ? { redactedSpans: spans } : {}),
      });
      console.log(
        `[privacy-guard v4] tool-error turn=${request.turnId} ` +
          `tool=${request.toolName} carrier=${request.carrier} ` +
          `outcome=${request.outcome} bytes=${String(request.bytes)} ` +
          `spans=${String(spans.length)}`,
      );
    },

    async runV4Tool(request: PrivacyV4ToolRequest): Promise<PrivacyV4ToolResult> {
      const store = storeFor(request.turnId);
      try {
        if (request.toolName === RENDER_TOOL_SPEC.name) {
          const directive = parseRenderDirective(request.input);
          const rendered = materialize(store, directive, {
            fileExportAvailable: request.fileExportAvailable === true,
          });
          // #1097 — a render of control flow (a tool error, an MCP auth
          // prompt) is a rendered FAILURE, not a result. Flag it so channels
          // can display it as one instead of presenting the model's success
          // prose over an error string.
          const renderIsError = isControlFlowDataset(
            store.get(directive.datasetId),
          );
          renderedAnswers.set(request.turnId, {
            text: rendered.text,
            maskedValues: rendered.maskedValues,
            // Always set — '' when the model wrote none — so the kernel can
            // tell "no prose" (system data only) from a provider that predates
            // the field (fails closed).
            prose: directive.prose?.trim() ? directive.prose : '',
            ...(renderIsError ? { isError: true } : {}),
          });
          console.log(
            `[privacy-guard v4] render turn=${request.turnId} ` +
              `datasetId=${directive.datasetId} rows=${String(rendered.rowCount)} ` +
              `rendered=${String(rendered.renderedRowCount)} format=${directive.format}` +
              `${renderIsError ? ' isError=true' : ''}`,
          );
          // A render of control flow has no query to re-run.
          const renderProvenance = renderIsError
            ? undefined
            : describeRenderProvenance(store, directive, rendered);
          const resultText = buildRenderAckText(rendered, renderProvenance);
          return {
            resultText,
            ...(rendered.structuredTable !== undefined
              ? { canvasSentinel: buildRenderSnapshotSentinel(rendered.structuredTable) }
              : {}),
            ...(renderProvenance !== undefined ? { renderProvenance } : {}),
          };
        }
        const engine = createVerbEngine({
          store,
          classify: shapeClassifier(),
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
        'To answer the user, pick the relevant datasetId (compose the verb',
        'tools first if you must filter / aggregate / join). Include identity /',
        'sensitive-masked columns — the server fills in their real values.',
        RENDER_CONTRACT,
        FILE_EXPORT_EXCEPTION,
        'The sub-agent only ever saw "[masked]" placeholders for the values in',
        'these datasets. A caveat in its notes that it "cannot show" or',
        '"filtered" those VALUES because they were masked does not apply — the',
        'user receives the real values; do not repeat it. Every other',
        'limitation in its notes still applies and MUST reach the user, in',
        'your own words before the data: a request outside its scope (a space,',
        'project, area or period it is not configured for), missing',
        'permissions, or data that does not exist. If the datasets come from',
        'a different scope than the one the user asked about, say so. State',
        'such a limitation as a fact; do not quote the notes verbatim.',
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
      const stage = request.stage ?? 'turn';
      const preview = request.preview === true;
      if (!isPromptMaskEnabled(deps?.readConfig?.(MASK_USER_PROMPT_CONFIG_KEY))) {
        // Policy off: the text goes out as written. A verifier request still
        // left the process, so the receipt counts it.
        if (stage === 'verifier' && !preview) recordMasked(request.turnId, stage, 'message', []);
        return { outcome: 'disabled' };
      }
      const detectors: PromptPiiDetector[] = [createBaselineDetector()];
      // #760 — operator deny-list: literal terms + vetted regex patterns.
      // Same confidence-1, fail-closed path as the baseline.
      const customDetector = resolveCustomDetector(deps?.readConfig);
      if (customDetector) detectors.push(customDetector);
      // Run the C1 detector up-front so its failure cannot take the C0
      // baseline down with it (tier-1 degrade, audited); its spans are
      // memoized into a pass-through detector for the mask pass.
      const c1 = await c1DetectorFor(
        request.turnId,
        request.text,
        'promptMaskDegraded',
      );
      if (c1.detector) detectors.push(c1.detector);
      return maskThroughTurnMap({
        turnId: request.turnId,
        text: request.text,
        detectors,
        degraded: c1.degraded,
        stage,
        origin: request.origin ?? 'message',
        preview,
      });
    },

    // Always on, independent of `mask_user_prompt`: the text carries
    // knowledge-graph evidence the turn's model only saw as a digest.
    // Identity shapes only (dates/amounts stay, as in a v4 digest), plus the
    // values the caller names, plus the turn's known real values.
    async projectVerifierText(
      request: PrivacyVerifierProjectionRequest,
    ): Promise<PrivacyPromptMaskResult> {
      const detectors: PromptPiiDetector[] = [createBaselineIdentityDetector()];
      const customDetector = resolveCustomDetector(deps?.readConfig);
      if (customDetector) detectors.push(customDetector);
      const identityDetector = createIdentityValuesDetector(
        request.identityValues ?? [],
      );
      if (identityDetector) detectors.push(identityDetector);
      const c1 = await c1DetectorFor(
        request.turnId,
        request.text,
        'promptMaskDegraded',
      );
      if (c1.detector) detectors.push(c1.detector);
      return maskThroughTurnMap({
        turnId: request.turnId,
        text: request.text,
        detectors,
        degraded: c1.degraded,
        stage: 'verifier',
        origin: 'message',
        preview: false,
        precheck: (map) => {
          if (!hasSurrogateCollision(request.text, map)) return undefined;
          console.error(
            `[privacy-guard v4] verifierMaskBlocked turn=${request.turnId} ` +
              'reason=surrogate-collision',
          );
          return {
            outcome: 'blocked',
            reason: 'a real value collides with a surrogate minted this turn',
          };
        },
      });
    },

    // Always on, independent of `mask_user_prompt`: that flag is about the
    // user's own words, and a channel replays the answer it delivered — after
    // a `v4_render_answer` turn, real values the turn's model never saw. The
    // detector assembly of `projectVerifierText` (identity shapes only, so
    // dates and amounts stay as in a v4 digest; the operator deny-list; C1
    // with the per-turn cache and degrade latch), minus caller-named values,
    // and booked as the turn's own egress. Through the turn's map, so the
    // answer-side restore covers these spans; failure-closed in `maskOnce`.
    // The recalled prior context arrives here with its stored-turn
    // `segments`: C1 then runs per segment through the process-wide segment
    // cache (only turns not scanned before reach the sidecar); C0 and the
    // deny-list still see the whole text.
    async maskReplayedAnswer(
      request: PrivacyReplayedAnswerRequest,
    ): Promise<PrivacyPromptMaskResult> {
      const detectors: PromptPiiDetector[] = [createBaselineIdentityDetector()];
      const customDetector = resolveCustomDetector(deps?.readConfig);
      if (customDetector) detectors.push(customDetector);
      const c1 = await c1SegmentedDetectorFor(
        request.turnId,
        request.text,
        request.segments,
        'promptMaskDegraded',
      );
      if (c1.detector) detectors.push(c1.detector);
      return maskThroughTurnMap({
        turnId: request.turnId,
        text: request.text,
        detectors,
        degraded: c1.degraded,
        stage: 'turn',
        // #1541 — an earlier answer or recalled context, never the user's
        // message: its spans must not read as "masked in your message".
        origin: 'context',
        preview: false,
      });
    },

    // WP-10 — stored text a background memory job sends outside a turn.
    // Always on, independent of `mask_user_prompt`, with the detector assembly
    // of `maskReplayedAnswer` (identity shapes, the operator deny-list, C1),
    // but through the job run's own surrogate map instead of a turn's, so the
    // job can restore real values in an output a user reads. No receipt: there
    // is no turn. Failure-closed in `createStoredTextScope`.
    openStoredTextScope(request: PrivacyStoredTextScopeRequest): PrivacyStoredTextScope {
      const detectors: PromptPiiDetector[] = [createBaselineIdentityDetector()];
      const customDetector = resolveCustomDetector(deps?.readConfig);
      if (customDetector) detectors.push(customDetector);
      return createStoredTextScope({
        job: request.job,
        detectors,
        ...(request.priority !== undefined ? { priority: request.priority } : {}),
        ...(deps?.c1Detector !== undefined ? { c1Detector: deps.c1Detector } : {}),
      });
    },

    async countUnresolvedSurrogates(
      turnId: string,
      text: string,
      options?: UnresolvedSurrogateCountOptions,
    ): Promise<number> {
      return countResidualSurrogates(text, promptMaskMaps.get(turnId), options);
    },

    // Tool-error redaction. The same detector assembly as `maskUserPrompt`
    // (baseline, operator deny-list, C1 with the per-turn cache and latch),
    // but: the baseline is narrowed to identity types (dates and amounts are
    // the hints a tool error exists to carry), substitution is irreversible
    // (`[masked:<type>]`, the turn's surrogate map is read for the known-value
    // sweep but never extended), and it does NOT consult `mask_user_prompt` —
    // that flag is about the user's own words, and a tool error is no channel
    // anyone consented to send in clear. Failure-closed: a detector failure or
    // a surviving value means `withheld`, never the input text.
    async redactToolErrorText(
      request: PrivacyToolErrorRedactRequest,
    ): Promise<PrivacyToolErrorRedactResult> {
      const detectors: PromptPiiDetector[] = [createToolErrorBaselineDetector()];
      const customDetector = resolveCustomDetector(deps?.readConfig);
      if (customDetector) detectors.push(customDetector);
      const c1Step = await c1DetectorFor(
        request.turnId,
        request.text,
        'toolErrorRedactDegraded',
      );
      if (c1Step.detector) detectors.push(c1Step.detector);
      try {
        const known = promptMaskMaps.get(request.turnId)?.forward.keys() ?? [];
        const result = await redactToolErrorSpans(request.text, detectors, known);
        const residual = findIdentityLeaks(withoutMaskMarkers(result.text), [
          ...result.values,
        ]);
        if (residual.length > 0) {
          console.error(
            `[privacy-guard v4] toolErrorRedactWithheld turn=${request.turnId} ` +
              `tool=${request.toolName} residual=${String(residual.length)} ` +
              'span(s) survived substitution',
          );
          return {
            outcome: 'withheld',
            reason: 'residual PII span survived substitution',
          };
        }
        console.log(
          `[privacy-guard v4] toolErrorRedact turn=${request.turnId} ` +
            `tool=${request.toolName} spans=${String(result.spans.length)}` +
            `${c1Step.degraded ? ' degraded=c0-only' : ''}`,
        );
        return {
          outcome: 'redacted',
          text: result.text,
          spans: result.spans,
          degraded: c1Step.degraded,
        };
      } catch (err) {
        console.error(
          `[privacy-guard v4] toolErrorRedactWithheld turn=${request.turnId} ` +
            `tool=${request.toolName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { outcome: 'withheld', reason: 'tool-error PII detection failed' };
      }
    },

    async restorePromptPseudonyms(turnId: string, text: string): Promise<string> {
      const map = promptMaskMaps.get(turnId);
      if (map === undefined || map.reverse.size === 0) return text;
      return resolvePromptPseudonyms(text, map);
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
      return (text: string): string => resolvePromptPseudonyms(text, snapshot);
    },

    // #1544 — the kernel restores the user's values into tool inputs; an
    // interning-exempt tool can echo them back in a result the model reads in
    // clear. Matched case-insensitively and with whitespace in the value read
    // as any run of spaces, `-` or `_`, so a slug of the value
    // (`/memories/projekt-falkenstein.md`) is caught too. One pass, longest
    // value first, so an inserted surrogate is never rewritten again.
    restoreToolInputValues(turnId: string, text: string): string {
      const map = promptMaskMaps.get(turnId);
      if (map === undefined || map.reverse.size === 0 || text.length === 0) return text;
      return restoreToolInputSurrogates(text, map);
    },

    remaskPromptValues(turnId: string, text: string): string {
      const map = promptMaskMaps.get(turnId);
      if (map === undefined || map.forward.size === 0 || text.length === 0) return text;
      return remaskKnownValues(text, map);
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
        // The classification travels with the column. Dropping it here was why
        // a renderer had no way to tell a shielded column from an ordinary one.
        columns: dataset.schema.fields.map((f) => ({
          path: f.path,
          type: f.type,
          classification: f.classification,
        })),
        rows: dataset.rows as ReadonlyArray<Record<string, unknown>>,
      };
    },

    ...fieldClassification.methods,

    datasetProvenance(turnId, datasetId) {
      return datasetProvenanceOf(stores.get(turnId), datasetId);
    },

    async nameDetectorStatus(): Promise<PrivacyNameDetectorStatus> {
      const base = {
        lastFailureAt: lastC1FailureAt?.toISOString() ?? null,
        promptMasking: isPromptMaskEnabled(deps?.readConfig?.(MASK_USER_PROMPT_CONFIG_KEY)),
      };
      if (!c1Configured()) return { ...base, state: 'unconfigured', source: null };
      if (deps?.probeC1 === undefined) return { ...base, state: 'active', source: null };
      try {
        const probe = await deps.probeC1();
        if (probe.source === null) return { ...base, state: 'unconfigured', source: null };
        return { ...base, state: probe.reachable ? 'active' : 'unreachable', source: probe.source };
      } catch {
        return { ...base, state: 'unreachable', source: null };
      }
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
      // #979 — cached C1 spans carry real PII values; drop them with the
      // rest of the turn's server-side state. The degrade latch goes too, so
      // the next turn gets a fresh attempt at a sidecar that may have
      // recovered. #1562 — read first: the receipt reports a failed C1.
      const c1Failed = c1FailedTurns.has(turnId);
      c1Cache.delete(turnId);
      c1FailedTurns.delete(turnId);
      const accum = receipts.get(turnId);
      receipts.delete(turnId);
      const piiValues = turnPiiValues.get(turnId);
      turnPiiValues.delete(turnId);
      const bypassed = bypassedTools.get(turnId);
      bypassedTools.delete(turnId);
      const clearedByRule = [...(operatorClearedFields.get(turnId)?.values() ?? [])];
      operatorClearedFields.delete(turnId);
      const structured = structuredPayloads.get(turnId);
      structuredPayloads.delete(turnId);
      const errors = toolErrors.get(turnId);
      toolErrors.delete(turnId);
      // No receipt for a turn that touched neither the boundary, a bypass,
      // structured output, prompt masking, a verifier request nor a tool error
      // — there is nothing to report and a zero receipt is just noise in the
      // channel UI.
      const hasInterned = accum !== undefined && accum.datasetsInterned > 0;
      const hasBypassed = bypassed !== undefined && bypassed.length > 0;
      const hasStructured = structured !== undefined && structured.length > 0;
      const promptSpans = accum ? [...accum.promptSpans.values()] : [];
      const contextSpans = accum ? [...accum.contextSpans.values()] : [];
      const hasMaskedPrompt = promptSpans.length > 0;
      const hasMaskedContext = contextSpans.length > 0;
      // #1562 — the C1 state of a turn that masked free text. A failed C1
      // alone is worth a receipt: names in the turn reached the model.
      const nameDetector: PrivacyNameDetectorTurnState | undefined =
        accum?.freeTextScanned !== true && !c1Failed
          ? undefined
          : c1Failed
            ? 'failed'
            : accum?.scannedWithoutC1 === true
              ? 'unconfigured'
              : 'active';
      const hasVerifierEgress = accum !== undefined && accum.verifierRequests > 0;
      const hasToolErrors = errors !== undefined && errors.length > 0;
      if (
        !hasInterned &&
        !hasBypassed &&
        !hasStructured &&
        !hasMaskedPrompt &&
        !hasMaskedContext &&
        nameDetector !== 'failed' &&
        !hasVerifierEgress &&
        !hasToolErrors
      )
        return undefined;
      // identityValuesOnWire — personal-identity values the requester named
      // in their own message text. A transparency notice (the user put a
      // real identity on the wire), NOT a leak of tool data. #1549 — whole
      // words, person-shaped values only (see identityOnWire.ts).
      const identityValuesOnWire =
        turnInput !== undefined && piiValues !== undefined
          ? countIdentityValuesNamed(turnInput, piiValues)
          : 0;
      console.log(
        `[privacy-guard v4] finalize turn=${turnId} ` +
          `datasets=${String(accum?.datasetsInterned ?? 0)} ` +
          `masked=${String(accum?.fieldsMasked ?? 0)} ` +
          `cleartext=${String(accum?.fieldsCleartext ?? 0)} ` +
          `verbs=[${(accum?.verbsExecuted ?? []).join(',')}] ` +
          `bypassed=${String(bypassed?.length ?? 0)} ` +
          `structured=${String(structured?.length ?? 0)} ` +
          `verifierRequests=${String(accum?.verifierRequests ?? 0)} ` +
          `toolErrors=${String(errors?.length ?? 0)} ` +
          `promptSpans=${String(promptSpans.length)} ` +
          `contextSpans=${String(contextSpans.length)} ` +
          `identityOnWire=${String(identityValuesOnWire)}` +
          `${nameDetector !== undefined ? ` c1=${nameDetector}` : ''}`,
      );
      return {
        datasetsInterned: accum?.datasetsInterned ?? 0,
        fieldsMasked: accum?.fieldsMasked ?? 0,
        fieldsCleartext: accum?.fieldsCleartext ?? 0,
        verbsExecuted: accum ? [...accum.verbsExecuted] : [],
        pseudonymProjectionUsed: accum?.pseudonymProjectionUsed ?? false,
        identityValuesOnWire,
        ...(hasBypassed ? { bypassedTools: [...bypassed] } : {}),
        ...(clearedByRule.length > 0 ? { operatorClearedFields: clearedByRule } : {}),
        ...(hasStructured ? { structuredPayloads: [...structured] } : {}),
        ...(hasMaskedPrompt ? { maskedPromptSpans: promptSpans } : {}),
        ...(hasMaskedContext ? { maskedContextSpans: contextSpans } : {}),
        ...(nameDetector !== undefined ? { nameDetector } : {}),
        ...(hasVerifierEgress
          ? {
              verifierEgress: {
                requests: accum.verifierRequests,
                maskedSpans: [...accum.verifierMaskedSpans],
              },
            }
          : {}),
        ...(hasToolErrors ? { toolErrors: [...errors] } : {}),
      };
    },
  };
}
