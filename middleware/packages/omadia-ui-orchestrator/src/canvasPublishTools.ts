import {
  PRIVACY_REDACT_SERVICE_NAME,
  type NativeToolSpec,
  type PluginContext,
  type PrivacyGuardService,
} from '@omadia/plugin-api';
import { turnContext } from '@omadia/orchestrator';

import {
  CANVAS_CHOICE_TOOL,
  CANVAS_LUMEN_TOOL,
  CANVAS_PUBLISH_TOOL,
  handleCanvasPublishChoice,
  handleCanvasPublishLumen,
  handleCanvasPublishRows,
} from './canvasPublishHandlers.js';
import { withDefaultColumnLabels } from './datasetColumnLabels.js';
import { type ProvenanceStash } from './datasetRecipe.js';

/**
 * Registration of the canvas producer tools in the orchestrator tool loop:
 * the model-facing specs plus the per-turn privacy-shield dataset resolvers
 * wired into the handlers (`canvasPublishHandlers.ts`).
 */

/** Dispose handles of the registered producer tools — each is undefined
 *  when the context has no tools accessor. */
export interface CanvasPublishToolDisposers {
  disposeTool: (() => void) | undefined;
  disposeChoiceTool: (() => void) | undefined;
  disposeLumenTool: (() => void) | undefined;
}

/** Model-facing spec of {@link CANVAS_PUBLISH_TOOL}. */
function canvasPublishToolSpec(): NativeToolSpec {
  return {
    name: CANVAS_PUBLISH_TOOL,
    description:
      'Publish fetched data for an Omadia UI canvas container. Use ONLY when the user ' +
      'message carries a [canvas-context] block: call it for each containerId from its ' +
      'dataRequirements. THREE shapes — pick by what you hold: ' +
      '(1) TABULAR containers (a row per record) → pass `rows` keyed EXACTLY by the promised ' +
      'fieldKeys; large sets go out in batches of at most 30 rows per call (repeated calls ' +
      'for the same containerId APPEND — one call at a time until every row is out; a single ' +
      'oversized call risks being truncated and dropped). (2) SCALAR/KPI containers (named ' +
      'single values, e.g. a score block) → pass `fields` as a { fieldKey: value } object ' +
      'instead of rows. (3) PRIVACY-SHIELD datasets (a tool returned a datasetId and you only ' +
      'see masked values) → pass that `datasetId` directly INSTEAD of rows; the server ' +
      'resolves the real rows and maps the dataset’s own columns into the canvas — no ' +
      'reshaping step needed. NEVER retype masked rows and never wrap the id into `rows`. ' +
      'The data renders directly into the already-visible canvas — do not repeat it as text ' +
      'afterwards. If the tool returns an Error result, do NOT claim success — say briefly ' +
      'what failed.',
    input_schema: {
      type: 'object',
      properties: {
        containerId: {
          type: 'string',
          description: 'containerId from the [canvas-context] dataRequirements',
        },
        rows: {
          type: 'array',
          items: { type: 'object' },
          description:
            'TABULAR containers: one object per row, AT MOST 30 rows per call (more rows → ' +
            'follow-up calls to the same containerId, they append); keys = the promised ' +
            'fieldKeys (optional rowKey/id for stable row identity). MAY be empty ([]) when ' +
            'the fetched data set is genuinely empty — the table then shows its empty state; ' +
            'never invent rows. For a CHART container, each row carries { label: string, ' +
            'value: number } — one row per data point. Use `fields` instead for scalar/KPI ' +
            'containers.',
        },
        fields: {
          type: 'object',
          description:
            'SCALAR/KPI containers ONLY: a flat { fieldKey: value } object of named single ' +
            'values (e.g. a score block: { "seo": 82, "mobile": 90 }). Keys = the promised ' +
            'fieldKeys; values are plain scalars (string/number/boolean). Use INSTEAD of ' +
            '`rows` — never both. The values fill the container’s cards in place.',
        },
        datasetId: {
          type: 'string',
          description:
            'PRIVACY-SHIELD datasets ONLY: the dataset id (ds_…) a tool returned THIS turn. ' +
            'Use INSTEAD of rows/fields — the server resolves the real (unmasked) rows into ' +
            'the canvas; you never see them. Publish it directly — its own column paths are ' +
            'mapped onto the table, no v4_select/v4_sort shaping first.',
        },
        prose: {
          type: 'string',
          description: 'one short human sentence describing the published data',
        },
        source: {
          type: 'object',
          description:
            'REFRESH RECIPE (pass on the FIRST publish per container): the exact tool + ' +
            'input you just used to fetch this data, plus the fieldKey→attribute map you ' +
            'applied — the canvas then refreshes deterministically without you. TIME RULE: ' +
            'express relative periods with the data source’s RELATIVE operators (FetchXML ' +
            '`next-week`, `this-year`, `last-x-days`, …), NEVER literal dates computed from ' +
            'today — a refresh next month must pull the then-current window. Explicit ranges ' +
            'the user named (e.g. 2025 vs 2026) stay literal. If the query cannot be ' +
            'expressed time-safely, OMIT source.',
          properties: {
            tool: { type: 'string', description: 'tool name to replay (e.g. dynamics_fetchxml)' },
            input: { type: 'object', description: 'the EXACT input object you called it with' },
            itemsPath: {
              type: 'string',
              description: 'dot-path to the record array in the tool output (default: first array)',
            },
            map: {
              type: 'object',
              description: 'fieldKey → attribute name in each result record',
            },
            rowKey: { type: 'string', description: 'attribute carrying a stable row id' },
          },
          required: ['tool', 'map'],
        },
        chartType: {
          type: 'string',
          enum: ['bar', 'line', 'pie'],
          description:
            'when publishing to a CHART container: the chart kind that fits the fetched data ' +
            '(time series → line, category comparison → bar, share-of-whole → pie). Overrides ' +
            'the skeleton’s guess — YOU have seen the data, the skeleton hasn’t.',
        },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'stable action id' },
              label: { type: 'string', description: 'menu entry, in the user’s language' },
              prompt: {
                type: 'string',
                description: 'beam text the click pre-fills (the row context is attached automatically)',
              },
              variant: {
                type: 'object',
                description:
                  'OPTIONAL, only when this table has a refresh recipe (a datasetId publish or a ' +
                  '`source`) and the action is the SAME query with a small change — the click then ' +
                  'runs without you. { patch, heading? }: patch.filter = [{ field, datePart: ' +
                  '"year"|"month"|"day", eq: <int> }] or [{ field, eq: <scalar> }] (replaces the ' +
                  'clause on that field, or adds a datePart clause on a column the table shows); ' +
                  'patch.domain = [{ field, op?, value }] (swaps the VALUE of a condition the query ' +
                  'already has — never adds one); patch.limit = 1–100. heading = the new view title ' +
                  '(plain text). Never a tool/model change. Example "Geburtstage im November": ' +
                  '{ "patch": { "filter": [{ "field": "birthday", "datePart": "month", "eq": 11 }] }, ' +
                  '"heading": "Geburtstage im November" }. Omit when the action needs a different query.',
              },
            },
            required: ['label'],
          },
          description:
            '1–4 row context-menu entries that fit the CURRENT view and data (e.g. in a detail ' +
            'view: actions on the detail rows). NEVER an action that re-opens the view the user ' +
            'is already in. Omit to keep the client’s generic fallback.',
        },
      },
      required: ['containerId'],
    },
  };
}

/** Model-facing spec of {@link CANVAS_CHOICE_TOOL}. */
function canvasChoiceToolSpec(): NativeToolSpec {
  return {
    name: CANVAS_CHOICE_TOOL,
    description:
      'Render a clickable choice on the Omadia UI canvas when the user request is AMBIGUOUS ' +
      '(several plausible records/interpretations match). Use ONLY when the user message ' +
      'carries a [canvas-context] block. Call it INSTEAD of asking back in prose; the pick ' +
      'arrives as the next turn. One option per alternative, values must be stable keys.',
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'the disambiguation question, in the user’s language',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: 'stable key (e.g. record id)' },
              label: { type: 'string', description: 'human-readable alternative' },
            },
            required: ['value', 'label'],
          },
          description: 'the alternatives (at least two)',
        },
        containerId: {
          type: 'string',
          description: 'optional canvas container to render into; defaults to the page root',
        },
        prose: {
          type: 'string',
          description: 'one short human sentence accompanying the question',
        },
      },
      required: ['question', 'options'],
    },
  };
}

/** Model-facing spec of {@link CANVAS_LUMEN_TOOL}. */
function canvasLumenToolSpec(): NativeToolSpec {
  return {
    name: CANVAS_LUMEN_TOOL,
    description:
      'Render an interactive LUMEN (Live Interactivity, omadia-canvas-protocol/1.1) on the canvas: ' +
      'a small live mini-app — a game, an animated/interactive visualization, a tool — that runs ' +
      'Tier-1-fast on the client (up to 60fps, no per-frame server round-trip) as DECLARATIVE DATA ' +
      'run by a shipped deterministic interpreter (no arbitrary code). PREFER authoring a custom ' +
      '`lumen` tailored to the user’s request (see its schema for the grammar + example); the host ' +
      'validates it (whitelist + bounds + determinism) and returns an error for you to fix if it is ' +
      'malformed, so author freely. To visualise the user’s REAL data (e.g. Dynamics records): if you ' +
      'can SEE the rows you fetched, pass them as `data` (an array of row objects) — the server builds ' +
      'an interactive tappable data Lumen for you; if the values are MASKED/shielded, pass the ' +
      '`datasetId` instead and the server resolves them. Use `variant` only for a quick canned demo. ' +
      'The element renders directly into the canvas — do not also describe it as a static table.',
    input_schema: {
      type: 'object',
      properties: {
        lumen: {
          type: 'object',
          description:
            'A complete Lumen you AUTHOR for the request (preferred). Shape: { "type":"lumen","id":string, ' +
            '"state":{<key>:<leaf>}, "transitions":{<name>:<LX>}, "view":<LX>, "events":[<binding>], "cadence"?:"reactive"|{"tick":<=60} }. ' +
            'LEAF: {"type":"int"|"number",min?,max?,"init":n} | {"type":"bool","init":b} | {"type":"string","maxLength":k,"init":s} | {"type":"enum","values":[..],"init":s} | {"type":"list","of":<leaf>,"maxLen":k,"init":[]} | {"type":"grid","w":W,"h":H,"of":<leaf>} | {"type":"record","fields":{..},"init":{}}. ' +
            'A transition returns a NEW state via {"set":{"<path>":<LX>}}. BINDING: {"on":"tap"|"key"|"tick"|"longPress"|"drag"|"swipe","key"?:s,"rate"?:<=60,"run":"<transitionName>"}. ' +
            'LX NODES: {"lit":v} {"state":"path"} {"event":"field"} {"var":"name"} {"let":{"n":expr},"in":expr} ; ' +
            'arithmetic {"+":[a,b]} "-" "*" "/" "mod" ; compare {">":[a,b]} ">=" "<" "<=" "==" "!=" ; {"and":[..]} {"or":[..]} {"not":x} ; ' +
            '{"if":c,"then":a,"else":b} ; {"match":x,"cases":[{"when":w,"then":t}],"else":e} ; {"record":{k:expr}} {"list":[expr]} {"get":expr,"key":expr} ; ' +
            '{"call":name,"args":[..]} name∈ map,filter,fold,range,len,min,max,clamp,abs,floor,ceil,round,sqrt,sign,pow,concat,slice,contains,indexOf,keys,values,upper,lower,pad,fmt,random,now (map/filter body reads {"var":"it"}/{"var":"idx"}; fold also {"var":"acc"}). NO loops/recursion/eval. ' +
            'VIEW returns a primitive/scene tree. A scene: {"record":{"type":{"lit":"scene"},"width":{"lit":W},"height":{"lit":H},"draw":{"list":[<node>...]}}}, ' +
            'node {"record":{"kind":{"lit":"rect"},"x":..,"y":..,"w":..,"h":..,"fill"?:<token>,"id"?:<lit>}} | "circle"(cx,cy,r) | "line"(x1,y1,x2,y2,stroke) | "text"(x,y,text) | "path"(points) | "group"(children). ' +
            'Colours are THEME TOKENS only: accent, accent.glow, surface, surface-raised, surface-sunken, text, text-muted, success, warning, danger. ' +
            'EXAMPLE (tap counter): {"type":"lumen","id":"counter","state":{"n":{"type":"int","min":0,"init":0}},"transitions":{"inc":{"set":{"n":{"+":[{"state":"n"},{"lit":1}]}}}},"view":{"record":{"type":{"lit":"scene"},"width":{"lit":220},"height":{"lit":80},"draw":{"list":[{"record":{"kind":{"lit":"text"},"x":{"lit":14},"y":{"lit":46},"text":{"call":"concat","args":[{"lit":"taps "},{"call":"fmt","args":[{"state":"n"}]}]},"fill":{"lit":"text"},"id":{"lit":"label"}}}]}}},"events":[{"on":"tap","run":"inc"}]}',
        },
        data: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Build a Lumen from data you ALREADY HOLD: an array of row objects you fetched this turn (e.g. Dynamics records you can see). The server builds an interactive, tappable data Lumen from them — no LX authoring needed. Prefer this for "visualise my data" requests when the rows are visible to you. AT MOST 20 rows are shown.',
        },
        datasetId: {
          type: 'string',
          description:
            'Build a Lumen from REAL but PRIVACY-SHIELDED data: a dataset id (ds_…) a data tool returned THIS turn whose values are masked to you. The server resolves the real rows server-side and builds the Lumen — you never see the unmasked values. Use this (NOT `data`) only when the rows you got are masked/shielded.',
        },
        labelField: {
          type: 'string',
          description: 'with datasetId: which field is the row label (defaults to the first text field).',
        },
        valueField: {
          type: 'string',
          description: 'with datasetId: which field is the numeric value (defaults to the first numeric field).',
        },
        variant: {
          type: 'string',
          enum: ['arcade', 'map', 'defrag'],
          description:
            'Quick canned demo if you are NOT authoring a custom `lumen` or binding a `datasetId`: arcade (game), map (interactive selection + zoom), defrag (tick animation).',
        },
        title: {
          type: 'string',
          description: 'optional heading shown above the Lumen, in the user’s language',
        },
      },
    },
  };
}

/** Register the three producer tools and log whether they landed. The
 *  `publishProvenance` stash receives the dataset provenance of datasetId
 *  publishes (read inside the turn, consumed by synthesis). */
export function registerCanvasPublishTools(
  ctx: PluginContext,
  toolsAccessor: PluginContext['tools'] | undefined,
  publishProvenance: ProvenanceStash,
): CanvasPublishToolDisposers {
  const disposeTool: (() => void) | undefined = toolsAccessor?.register(
    canvasPublishToolSpec(),
    // Privacy Shield v4: datasetId publishes resolve the real rows server-side
    // within the current turn. The provider is resolved LAZILY per call (same
    // reasoning as the office plugin): activation order is not guaranteed, and
    // narrow test contexts have no services accessor at all.
    (input) =>
      handleCanvasPublishRows(input, (datasetId) => {
        const turnId = turnContext.current()?.turnId;
        const privacy = (
          ctx.services as PluginContext['services'] | undefined
        )?.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);
        if (turnId === undefined || privacy?.resolveDatasetForRender === undefined) {
          return 'unavailable';
        }
        const resolved = privacy.resolveDatasetForRender(turnId, datasetId);
        if (resolved === undefined) return undefined;
        // provenance is turn-scoped: read it NOW (inside the turn), the
        // synthesis layer consumes it when the publish is composed
        const provenance = privacy.datasetProvenance?.(turnId, datasetId);
        publishProvenance.put(datasetId, provenance);
        return withDefaultColumnLabels(resolved, provenance);
      }),
  );
  const disposeChoiceTool: (() => void) | undefined = toolsAccessor?.register(
    canvasChoiceToolSpec(),
    handleCanvasPublishChoice,
  );
  const disposeLumenTool: (() => void) | undefined = toolsAccessor?.register(
    canvasLumenToolSpec(),
    (input) =>
      handleCanvasPublishLumen(input, (datasetId) => {
        const turnId = turnContext.current()?.turnId;
        const privacy = (
          ctx.services as PluginContext['services'] | undefined
        )?.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);
        if (turnId === undefined || privacy?.resolveDatasetForRender === undefined) {
          return 'unavailable';
        }
        return privacy.resolveDatasetForRender(turnId, datasetId);
      }),
  );
  ctx.log(
    `[omadia-ui-orchestrator] producer tools ${CANVAS_PUBLISH_TOOL}+${CANVAS_CHOICE_TOOL}+${CANVAS_LUMEN_TOOL} ${
      disposeTool ? 'registered' : 'NOT registered (no tools accessor in this context)'
    }`,
  );
  return { disposeTool, disposeChoiceTool, disposeLumenTool };
}
