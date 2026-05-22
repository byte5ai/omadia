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
  PrivacyRenderedAnswer,
  PrivacySubAgentResultV4Request,
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
import { assertNoIdentityOnWire } from './v4/onTheWire.js';

/** Per-turn counters drained into the user-facing `PrivacyReceipt`. */
interface V4ReceiptAccum {
  datasetsInterned: number;
  fieldsMasked: number;
  fieldsCleartext: number;
  readonly verbsExecuted: string[];
  pseudonymProjectionUsed: boolean;
  /** Identity values that reached the wire because the user named them
   *  (soft breach — recorded, not blocked). A Set so repeat guard calls
   *  within the turn dedupe; the receipt reports `.size`. */
  readonly identityOnWire: Set<string>;
}

/** Min length of a masked string value worth scanning for on the wire.
 *  Shorter values substring-match too freely to be reliable needles. */
const MIN_WIRE_NEEDLE_LEN = 3;

/** Collect the identity-bearing string(s) of one masked field VALUE into
 *  `out`. Only the value itself is taken — a plain string, or the display
 *  label of an Odoo many2one `[id,"name"]` tuple. Nested objects / general
 *  arrays are deliberately NOT walked: their string leaves are mostly
 *  structural (model names like `hr.employee`, type tags, field labels), not
 *  identity values, and sweeping them in turned legitimate tool parameters
 *  into spurious leak hits. */
function collectMaskedNeedle(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_WIRE_NEEDLE_LEN) out.add(value);
    return;
  }
  // Odoo many2one: [id, "Display Name"] — the label is the identity value.
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'string' &&
    value[1].length >= MIN_WIRE_NEEDLE_LEN
  ) {
    out.add(value[1]);
  }
}

/** Pull the data-plane surfaces out of an LLM-bound payload: the content of
 *  every `tool_result` block. That is the only path interned tool data takes
 *  to the LLM. The human's typed text, the system prompt, and the model's own
 *  `tool_use` inputs are all excluded — none is a data-plane leak surface,
 *  and a `tool_use` input legitimately carries model names and filter values
 *  the model composed itself. */
function dataPlaneSurfaces(payload: unknown): unknown[] {
  const surfaces: unknown[] = [];
  if (payload === null || typeof payload !== 'object') return surfaces;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return surfaces;
  for (const msg of messages) {
    if (msg === null || typeof msg !== 'object') continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'tool_result'
      ) {
        surfaces.push((block as { content?: unknown }).content);
      }
    }
  }
  return surfaces;
}

/** Concatenate every piece of text the human authored in an LLM-bound
 *  payload — plain-string user messages and `text` blocks in user messages.
 *  `tool_result` blocks (also user-role, but data-plane) are excluded. A
 *  masked value that appears in here was supplied BY the user, so its
 *  presence on the wire is not a data-plane leak — the wire guard drops it
 *  from its needle set. */
function userAuthoredText(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return '';
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg === null || typeof msg !== 'object') continue;
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      parts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (
          block !== null &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          parts.push((block as { text: string }).text);
        }
      }
    }
  }
  return parts.join('\n');
}

export function createPrivacyGuardService(): PrivacyGuardService {
  // One turn-scoped Dataset Store per turn, minted lazily on the first
  // `internToolResultV4` and dropped by `finalizeTurn`.
  const stores = new Map<string, DatasetStore>();
  // Per-turn stash for the server-materialized final answer produced by a
  // `v4_render_answer` call — the rendered text plus the masked values it
  // resolved behind the boundary.
  const renderedAnswers = new Map<string, PrivacyRenderedAnswer>();
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
        identityOnWire: new Set<string>(),
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
      return internAndCount(
        request.turnId,
        request.toolName,
        request.rawResult,
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
        'server fills in their real values. The sub-agent only ever saw',
        '"[masked]"; do NOT repeat any "cannot show" / "filtered" caveat from',
        'its notes — the user receives the real values.',
      ].join('\n');
      return {
        resultText:
          `${header}\n\n--- sub-agent notes ---\n${request.narration}\n\n` +
          `--- datasets (${String(digests.length)}) ---\n${digests.join('\n')}`,
      };
    },

    assertWireCleanV4(turnId: string, payload: unknown): void {
      const store = stores.get(turnId);
      if (store === undefined) return;
      // Every real `sensitive-masked` value interned this turn — across the
      // originally interned datasets AND every verb-derived one.
      const needles = new Set<string>();
      for (const ds of store.allDatasets()) {
        const maskedPaths = ds.schema.fields
          .filter((f) => f.classification === 'sensitive-masked')
          .map((f) => f.path);
        if (maskedPaths.length === 0) continue;
        for (const row of ds.rows) {
          for (const path of maskedPaths) {
            collectMaskedNeedle(row[path], needles);
          }
        }
      }
      if (needles.size === 0) return;
      // Two tiers. A masked value the user themselves named in the request is
      // not a hard leak — they already know it, and the LLM legitimately
      // echoes it downstream (e.g. into an Odoo name filter). It is recorded
      // as a soft breach (surfaced in the receipt) but does NOT block. A
      // masked value the user did NOT provide is a hard leak — fail closed.
      const userText = userAuthoredText(payload);
      const receipt = receiptFor(turnId);
      const leakNeedles: string[] = [];
      for (const needle of needles) {
        if (userText.includes(needle)) {
          receipt.identityOnWire.add(needle);
        } else {
          leakNeedles.push(needle);
        }
      }
      if (leakNeedles.length === 0) return;
      try {
        assertNoIdentityOnWire(dataPlaneSurfaces(payload), leakNeedles);
      } catch (err) {
        console.error(
          `[privacy-guard v4] WIRE GUARD turn=${turnId} — blocking the ` +
            `LLM call: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    },

    async takeRenderedAnswerV4(
      turnId: string,
    ): Promise<PrivacyRenderedAnswer | undefined> {
      const answer = renderedAnswers.get(turnId);
      renderedAnswers.delete(turnId);
      return answer;
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
          `verbs=[${accum.verbsExecuted.join(',')}] ` +
          `identityOnWire=${String(accum.identityOnWire.size)}`,
      );
      return {
        datasetsInterned: accum.datasetsInterned,
        fieldsMasked: accum.fieldsMasked,
        fieldsCleartext: accum.fieldsCleartext,
        verbsExecuted: [...accum.verbsExecuted],
        pseudonymProjectionUsed: accum.pseudonymProjectionUsed,
        identityValuesOnWire: accum.identityOnWire.size,
      };
    },
  };
}
