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
  'read_attachment',
]);

/**
 * True when a tool's raw result must be handed to the model in clear, i.e.
 * the Privacy Shield must NOT intern it. See {@link INTERN_EXEMPT_TOOLS}.
 */
export function isInternExemptTool(toolName: string): boolean {
  return INTERN_EXEMPT_TOOLS.has(toolName);
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
