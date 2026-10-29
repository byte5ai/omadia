/**
 * Canvas protocol constants of the ui-orchestrator — the published service
 * key, wire versions, the default composition model and the fixed canvas-turn
 * directive. Re-exported from `plugin.ts`.
 */

/**
 * Bare service-registry key this plugin publishes under. BARE (no `@N`): the
 * registry looks up by exact string and does not strip a version suffix — the
 * `@1` lives only in the manifest `provides`. A canvas channel's
 * `dispatch_service` must carry this exact bare string.
 */
export const CANVAS_CHAT_AGENT_SERVICE = 'canvasChatAgent';

/** Where the learned plans lived before the store moved to @omadia/fast-path. */
export const LEGACY_PLANS_PATH = 'fastpath/plans.json';

export const CANVAS_PROTOCOL_VERSION = '1.0';
export const OPS_CATALOG_VERSION = '1.0';
// Skeleton composition is a low-stakes structural placeholder, so it ALWAYS
// runs on the cheapest tier — the `class:fast` ref resolves (in createLlmAccessor)
// to the active provider's fast/cheapest model: anthropic→claude-haiku, openai→
// gpt-5.4-mini, mistral→mistral-small. Provider-agnostic: pin a concrete id or a
// bigger class via the `ui_orchestrator_model` config only if the tree-validity
// gate (<95% first-attempt schema-valid) demands it.
export const DEFAULT_COMPOSITION_MODEL = 'class:fast';

/**
 * The canvas protocol directive for a skeleton-path turn. Sent as
 * `ChatTurnInput.fixedSystemHint` — appended UNMASKED to the system prompt —
 * instead of riding in `userMessage`, where its ~2 KB inflated the plan gate,
 * the C1 PII detector, recall and the session log on every canvas turn. MUST
 * stay a compile-time constant (the field's contract): no user text, no model
 * output, no tool data. Everything derived from the request (the skeleton's
 * dataRequirements) stays in the user message's compact [canvas-context].
 */
export const CANVAS_TURN_DIRECTIVE =
  'CANVAS TURN — the user message ends with a [canvas-context] block: a canvas skeleton with ' +
  'those data requirements is already rendered. Work silently: do NOT narrate planning, ' +
  'lookups, memory checks, or tool calls — the canvas is the output channel. Fetch the data, ' +
  'then call the canvas_publish_rows tool for each containerId with rows keyed EXACTLY by the ' +
  'promised fieldKeys. A dataRequirement that describes a SCALAR/KPI block (named single ' +
  'values, e.g. a score block — its fields are individual metrics, not table columns) is ' +
  'filled by passing `fields` ({ fieldKey: value }) INSTEAD of rows. PRIVACY-SHIELD RULE: when ' +
  'a tool returned a datasetId and you only see masked values, pass that `datasetId` to ' +
  'canvas_publish_rows directly INSTEAD of rows — the server resolves the real rows and maps ' +
  'the dataset’s own columns; no reshaping step first, never retype masked data. BATCH RULE: ' +
  'at most 30 rows per call — for larger sets publish batch after batch to the same ' +
  'containerId (calls append), one call at a time, until every row is out; NEVER pack the ' +
  'whole set into one giant call (it gets truncated and dropped). Publish rows: [] when the ' +
  'data set is genuinely empty (never invent rows). On the FIRST publish per container also ' +
  'pass `source` (the exact tool + input you used + fieldKey→attribute map) so the canvas can ' +
  'refresh without you — use the source’s RELATIVE date operators for relative periods ' +
  '(FetchXML next-week, this-year, …), literal values only for ranges the user named ' +
  'explicitly; omit source if not expressible time-safely. All published values are PLAIN ' +
  'TEXT — never markdown (**bold**, `code`, # headings); labels belong in columns, not inline ' +
  'markers. Pass 1–3 `actions` (row context-menu entries) that fit the CURRENT view, in the ' +
  'user’s language — never one that re-opens the current view. If the request is AMBIGUOUS ' +
  '(several plausible records match), call canvas_publish_choice with one option per ' +
  'alternative instead of asking back in prose. The published data renders into the visible ' +
  'canvas — after publishing, reply with ONE short summary sentence only and do NOT repeat ' +
  'the data as text or markdown tables.';
