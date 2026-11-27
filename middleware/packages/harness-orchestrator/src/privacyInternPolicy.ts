/**
 * Privacy Shield v4 — interning exemption allowlist.
 *
 * The Privacy Shield interns raw tool results to identity-free digests so
 * external business data (Dynamics/Odoo rows, calendar entries, enriched
 * company data, web-search hits) never reaches the LLM wire. That guard is
 * correct for *data-source* tools — but it was being applied indiscriminately
 * to the agent's OWN infrastructure tools too.
 *
 * Symptom (observed in production logs): `memory`, `query_processes`,
 * `run_stored_process`, `write_process`, `edit_process` were all interned.
 * The agent could not read its own memory or its own stored-process
 * definitions — it loaded and *ran* a stored process blind, could not see the
 * baked entity-set name was stale, and only discovered the failure at the
 * downstream `dynamics_query`. It then rediscovered the schema ephemerally and
 * (being equally blind to `write_process`/`edit_process`) could not reliably
 * persist the correction, so the same query failed again next time.
 *
 * Fix: a single, auditable allowlist of tools that are the agent's own
 * scaffolding / self-generated output — provably NOT external data sources.
 * Results from these tools are handed to the model in clear (never interned).
 *
 * SECURITY NOTE — keep this list deliberately narrow. Add a tool here ONLY if
 * its result is the agent's own operational state or self-produced output with
 * no external/PII payload. When in doubt, leave it guarded (interned).
 *
 * Deliberately NOT exempt (still interned — they can carry external/PII data):
 *   - `query_knowledge_graph` — recall of consolidated knowledge that can
 *     include integration-derived PII. Exempting it is a separate, explicit
 *     privacy trade-off (tracked with the memory-overhaul plan), not folded in
 *     here.
 *   - `chat_participants` — roster names/emails (people PII).
 *   - `find_free_slots` / `book_meeting` — calendar data.
 *   - every domain/plugin data tool (`dynamics_*`, `odoo_*`, `enrich_company`,
 *     web search, …).
 *   - `query_dataset` `query_rows` — dataset cells. Only its metadata
 *     operations are exempt ({@link INTERN_EXEMPT_OPERATIONS}).
 *   - `transcribe_recording` — prompt-masked, not exempt
 *     ({@link PROMPT_MASKED_UPLOAD_TOOLS}).
 */
export const INTERN_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  // Agent working memory (Anthropic `memory_20250818`).
  'memory',
  // Stored-process CRUD — query templates + entity-set names are scaffolding,
  // not customer rows. The actual data fetch happens later in `dynamics_query`
  // (still guarded).
  'query_processes',
  'run_stored_process',
  'write_process',
  'edit_process',
  // Agent self-produced UI/meta output — no external payload.
  'suggest_follow_ups',
  'ask_user_choice',
  // #268 — a user-uploaded document the agent was explicitly asked to read.
  // Not a specialist-agent PII source; the user already has this content.
  // That premise holds by construction since #1960 (ADR-0178): the reader
  // serves only keys a channel adapter stated as uploads in THIS conversation,
  // never Office/Diagrams output or another chat's file.
  'read_attachment',
  // #1967 — files the agent produced itself. The result is the artifact's
  // own metadata (`{kind, url, cacheHit, title}` for a diagram; file name,
  // media type, size, row count, renamed sheets and url for an office file),
  // never a cell value or an external payload. Interning it made the shield
  // render the signed URL as an "original data" table next to the image.
  'render_diagram',
  'create_xlsx',
  'create_docx',
]);

/**
 * Exempt tools whose handler still runs on the user's restored values
 * (#1544), like every guarded tool: what they produce goes to the user as a
 * file or an image, so it must carry the real names, not the placeholders
 * the model wrote. Every other exempt tool runs on the model's input as
 * written (memory, stored processes, attachments keep placeholders).
 */
const RESTORED_INPUT_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'render_diagram',
  'create_xlsx',
  'create_docx',
]);

/**
 * ADR-0197 — exemptions per tool OPERATION. A tool that both lists metadata
 * and reads rows is exempt only for the metadata operations; the row reads
 * stay interned. `field` names the input property that carries the
 * operation. An input without a matching operation is not exempt.
 */
export const INTERN_EXEMPT_OPERATIONS: ReadonlyMap<
  string,
  { readonly field: string; readonly operations: ReadonlySet<string> }
> = new Map([
  // #1866 — the user's own dataset names, file names and column names/types.
  // `get_schema` returns no sample value (`QueryDatasetTool`); `query_rows`
  // reads cells and stays interned.
  [
    'query_dataset',
    { field: 'query', operations: new Set(['list_datasets', 'get_schema']) },
  ],
]);

/**
 * True when a tool's raw result must be handed to the model in clear, i.e.
 * the Privacy Shield must NOT intern it. See {@link INTERN_EXEMPT_TOOLS}.
 * Tool-level only; a dispatch seam that has the call's input asks
 * {@link isInternExemptCall}, which also knows per-operation exemptions.
 */
export function isInternExemptTool(toolName: string): boolean {
  return INTERN_EXEMPT_TOOLS.has(toolName);
}

/**
 * #1768 / ADR 0241 — field-level interning exemption.
 *
 * Some kernel tools return the agent's own operational state (ids, names,
 * schedules, status, timestamps) mixed with text a user typed in (a routine's
 * prompt, the error a run recorded). Interning the whole result blinds the
 * agent to state it must act on (find a routine by name, confirm a pause);
 * exempting it whole would hand user-entered free text to the model as
 * trusted state. A tool listed here gets a MODEL COPY: its JSON result with
 * the listed keys removed at every depth, handed over in clear like an
 * exempt tool's. Everything not listed is operational state by the tool's
 * own contract. A result that is not a JSON object is not projected: it falls
 * through to normal interning (fail closed).
 *
 * Keep this map as narrow as {@link INTERN_EXEMPT_TOOLS}: only kernel tools
 * whose result shape the kernel itself writes.
 */
/** #2339 — the kernel's trigger tools (`middleware/src/triggers/triggerTools.ts`). */
const TRIGGER_TOOL_NAMES = ['on_event', 'wake_at', 'wake_every', 'list_triggers', 'cancel_trigger'] as const;
const TRIGGER_WITHHELD_FIELDS: readonly string[] = ['purpose', 'lastOutcome', 'pausedBecause', 'label'];

export const INTERN_FIELD_EXEMPT_TOOLS: ReadonlyMap<string, readonly string[]> = new Map([
  // The user's own routines: `prompt` and `lastRunError` are free text; the
  // `_pendingRoutineList` sidecar repeats prompts and is read from the raw
  // result by the smart-card path, never by the model.
  ['manage_routine', ['prompt', 'lastRunError', '_pendingRoutineList']],
  // #2339 — the agent's own triggers (`triggerTools.ts`): id, kind, times with
  // their zone, state, runs and cost are kernel state the model must confirm
  // to the person ("fires at 11:48"). The purpose the model wrote (run on the
  // restored input, so it may carry real names), the last outcome and pause
  // reason (may quote a failed tool's error) and an operator's target label
  // are withheld.
  ...TRIGGER_TOOL_NAMES.map((name): [string, readonly string[]] => [name, TRIGGER_WITHHELD_FIELDS]),
]);

/** True when a tool's result reaches the model as a projected clear copy. */
export function hasInternFieldExemption(toolName: string): boolean {
  return INTERN_FIELD_EXEMPT_TOOLS.has(toolName);
}

/**
 * The model copy of a field-exempt tool's result: its JSON with the withheld
 * keys removed at every depth, or undefined when the tool has no field
 * exemption or its result is not a JSON object or array (then it is
 * interned as usual).
 */
export function fieldExemptModelCopy(toolName: string, result: string): string | undefined {
  const withheld = INTERN_FIELD_EXEMPT_TOOLS.get(toolName);
  if (withheld === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const drop = new Set(withheld);
  const project = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(project);
    if (typeof v !== 'object' || v === null) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !drop.has(k))
        .map(([k, inner]) => [k, project(inner)]),
    );
  };
  return JSON.stringify(project(parsed));
}

/**
 * True when this call's result reaches the model in clear: the tool is
 * exempt as a whole, or the operation its input names is exempt
 * ({@link INTERN_EXEMPT_OPERATIONS}).
 */
export function isInternExemptCall(toolName: string, input: unknown): boolean {
  if (INTERN_EXEMPT_TOOLS.has(toolName)) return true;
  const rule = INTERN_EXEMPT_OPERATIONS.get(toolName);
  if (rule === undefined || typeof input !== 'object' || input === null) return false;
  const operation = (input as Record<string, unknown>)[rule.field];
  return typeof operation === 'string' && rule.operations.has(operation);
}

/**
 * True when the tool's handler gets the input exactly as the model wrote it
 * (placeholders kept) instead of the user's restored values. Only exempt
 * tools whose output stays inside the agent's own state qualify; see
 * {@link RESTORED_INPUT_EXEMPT_TOOLS}.
 */
export function runsOnModelInput(toolName: string): boolean {
  return INTERN_EXEMPT_TOOLS.has(toolName) && !RESTORED_INPUT_EXEMPT_TOOLS.has(toolName);
}

/**
 * ADR-0198 — tools whose result is text of the user's own upload and reaches
 * the model through prompt masking (PII spans replaced by the turn's
 * surrogates, the rest readable) instead of being interned to a digest.
 * Maps the tool to the input field that names the upload's storage key.
 */
export const PROMPT_MASKED_UPLOAD_TOOLS: ReadonlyMap<string, string> = new Map([
  // #1985 — a transcript of a recording the user uploaded in this turn.
  ['transcribe_recording', 'storage_key'],
]);

/**
 * True when this call's result is prompt-masked rather than interned: the
 * tool is in {@link PROMPT_MASKED_UPLOAD_TOOLS} AND the storage key it read
 * is one of the uploads of the current turn (`turnUploadKeys`, from the
 * adapter-stated `storedAttachments`, ADR-0178). A key from anywhere else — an earlier
 * chat, another user's file — stays interned (#1960).
 */
export function isPromptMaskedUploadCall(
  toolName: string,
  input: unknown,
  turnUploadKeys: ReadonlySet<string> | undefined,
): boolean {
  const field = PROMPT_MASKED_UPLOAD_TOOLS.get(toolName);
  if (field === undefined || turnUploadKeys === undefined) return false;
  if (typeof input !== 'object' || input === null) return false;
  const key = (input as Record<string, unknown>)[field];
  return typeof key === 'string' && turnUploadKeys.has(key);
}

/**
 * What a model gets in place of a tool result the Privacy Shield could not
 * intern (`internToolResultV4` threw). Every seam that interns fails closed —
 * the orchestrator's dispatch, `LocalSubAgent`, `ToolDispatchService` and the
 * MCP input-card replay: the raw result never reaches the model, on a
 * verifier re-entry's replay neither (`toolReplayLedger.ts`).
 *
 * Kernel-authored and PII-free (it names only the tool), with the `Error:`
 * prefix the tool-result assembly reads to mark the block as an error. The
 * handler did run, so the notice says so and asks the model not to call the
 * tool again for the result: a repeat of a write would run the write again.
 * `query_dataset` keeps its own notice — it reads a dataset page, and a retry
 * is the right move there (`Orchestrator.dispatchToolDeadlined`).
 */
export function internFailedNotice(toolName: string): string {
  return (
    `Error: tool \`${toolName}\` ran, but the privacy boundary could not process its result, ` +
    'so the result was withheld. Do not call the tool again to get it; tell the user that its ' +
    'result is temporarily unavailable.'
  );
}
