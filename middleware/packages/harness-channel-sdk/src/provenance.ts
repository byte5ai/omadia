/**
 * AI-Act Art. 50 — machine-readable provenance marking for the two public
 * egress paths whose ENVELOPE omadia controls end to end: the public chat API
 * (`POST /api/public/v1/chat`) and the public MCP server. Issue #647.
 *
 * These two differ from the messenger connectors (Teams, Slack, Telegram,
 * WhatsApp): their wire formats carry no provenance slot, so those channels get
 * the in-text disclosure instead (epic #642, sub-issues #643/#644). Here we own
 * a real metadata slot, so we set a machine-readable marker IN ADDITION to
 * whatever the answer text carries.
 *
 * Deliberately self-contained and envelope-only: it does NOT depend on the
 * channel-agnostic disclosure carrier (#643) or the per-turn resolution in the
 * orchestrator (#644), both of which land separately — which is what makes #647
 * parallelizable, as the epic states. The marker asserts exactly one thing a
 * caller may rely on — the response is served by an omadia AI system — and
 * nothing it may not: it does NOT name the model (that rides the `done` event's
 * existing `model` field, and the persisted RunTrace extension is #650), and on
 * the MCP path it is an envelope-level Art. 50 §1 disclosure ("you are
 * interfacing an AI system"), not a per-byte claim about the provenance of an
 * individual tool result's data.
 */

/**
 * Response header set at envelope-open on both AI paths.
 *
 * Set BEFORE any turn work runs, which is what makes it survive the in-band
 * error path: on the chat API the stream is already a committed 200 by the time
 * an orchestrator `{type:'error'}` event or a mid-turn throw happens, so a
 * header set at `flushHeaders()` time is present regardless of how the turn
 * ends. Uses the conventional `X-` prefix already carried on this route
 * (`X-Accel-Buffering`); a header value is a plain string, never JSON.
 */
export const AI_PROVENANCE_HEADER = 'X-AI-Generated';
export const AI_PROVENANCE_HEADER_VALUE = 'true';

/**
 * The structured marker carried in a rich per-turn / per-call slot: the chat
 * API's NDJSON `done` event, and the MCP result's `_meta`. Additive and
 * optional by contract — an existing client that does not know the field ignores
 * it, which is exactly what keeps the NDJSON framing and the JSON-RPC result
 * envelope backward-compatible.
 */
export interface EnvelopeProvenance {
  /**
   * The response was produced by an AI system (AI-Act Art. 50). Typed as the
   * literal `true` rather than `boolean` so the marker can only ever ASSERT
   * provenance — there is no `aiGenerated: false` state on these paths.
   */
  readonly aiGenerated: true;
}

/**
 * The single shared marker value, so the two egress paths cannot drift. Frozen
 * so neither path can mutate a value the other also hands out.
 */
export const ENVELOPE_PROVENANCE: EnvelopeProvenance = Object.freeze({ aiGenerated: true });

/**
 * `_meta` key under which the MCP `tools/call` result carries
 * {@link ENVELOPE_PROVENANCE}. Namespaced with a reverse-DNS-ish label before
 * the `/`, per the MCP `_meta` key-naming rule, so it can never collide with the
 * SDK's own `modelcontextprotocol.io/…` reserved keys.
 */
export const AI_PROVENANCE_META_KEY = 'omadia.ai/provenance';
