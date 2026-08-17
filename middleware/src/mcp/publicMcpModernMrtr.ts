/**
 * MRTR in the 2026-07-28 dialect, for the public MCP endpoint (issue #700).
 *
 * ─── Why there are two dialects at all ──────────────────────────────────────
 *
 * omadia's MRTR (#544) predates the revision that standardised it. It puts a
 * flat ARRAY of fields in `inputRequests` and has the caller retry with a flat
 * `arguments.inputResponses` object. The 2026-07-28 revision instead sends a
 * MAP of whole `elicitation/create` requests and takes the answers back as
 * top-level `inputResponses` params, one `ElicitResult` per key.
 *
 * Both are live. `publicMcpServer` routes a 2025-era request to the v1 serving
 * path, which keeps emitting the array form byte for byte, and a modern request
 * to the v2 path, which uses this module. The choice is made by the protocol
 * era of the connection, never by configuration — see the endpoint README.
 *
 * ─── What this module is NOT allowed to change ──────────────────────────────
 *
 * The TOOL's view. A dispatched tool asks for input by emitting the same
 * `_pendingInputRequest` sentinel it always has, and receives the answers as
 * the same flat `arguments.inputResponses` object it always has. Everything
 * era-specific stops at this file. A tool that works on a 2025 caller works
 * unchanged on a 2026-07-28 one, which is the whole point of putting the
 * translation here rather than in the dispatch layer.
 */

import { inputRequired } from '@modelcontextprotocol/server';

import type { McpInputField } from '@omadia/orchestrator';

import type { ToolEmittedInputRequest } from './publicMcpInputRequired.js';

/**
 * The key the single embedded elicitation is filed under.
 *
 * One request, not one per field: omadia's card IS one form that a human fills
 * in and submits once, and splitting it into N embedded elicitations would ask
 * a conforming client to render N dialogs for what the tool asked as a single
 * question. The key is stable so the retry leg can find the answers again.
 */
export const MODERN_INPUT_REQUEST_KEY = 'omadiaInputRequest';

/** The elicitation schema's own property map, and one entry in it. Derived
 *  from the builder rather than restated, so a change in the SDK's accepted
 *  shape is a compile error here instead of a runtime rejection at the seam. */
type ElicitObjectSchema = Extract<
  Parameters<typeof inputRequired.elicit>[0]['requestedSchema'],
  { type: 'object' }
>;
type ElicitFieldSchema = ElicitObjectSchema['properties'][string];

/**
 * JSON Schema for one field.
 *
 * NOTE — `secret` does not survive into the schema, and that is the spec's
 * limitation rather than a shortcut here. The 2026-07-28 elicitation schema
 * admits exactly four string formats (`email`, `date`, `uri`, `date-time`);
 * there is no `password`, and no other masked-input concept anywhere in the
 * revision. Emitting one anyway would produce a request a conforming client
 * rejects, which trades a missing hint for a broken call.
 *
 * Dropping it silently was the other option and is worse: `secret` is a
 * privacy hint about what a human is about to type on screen. It is therefore
 * carried in the prose instead — see {@link secrecyNotice} — so a modern
 * client's user is told, even though its form widget cannot mask the input.
 */
function fieldSchema(field: McpInputField): ElicitFieldSchema {
  return {
    type: 'string',
    ...(field.label !== undefined ? { title: field.label } : {}),
    ...(field.description !== undefined ? { description: field.description } : {}),
  };
}

/**
 * Server-authored sentence naming the fields the tool marked secret.
 *
 * Deliberately appended to the message rather than mixed into each field's
 * tool-authored `description`: this text is omadia's, not the tool's, and
 * keeping the two apart is what lets a reader tell who is speaking on a
 * surface where the tool's strings are untrusted.
 */
function secrecyNotice(fields: readonly McpInputField[]): string | undefined {
  const secret = fields.filter((field) => field.secret === true);
  if (secret.length === 0) return undefined;
  const names = secret.map((field) => field.label ?? field.name).join(', ');
  return `Sensitive, and this protocol revision cannot ask your client to mask it: ${names}.`;
}

/**
 * Render a tool's input request as the spec's embedded elicitation map.
 *
 * The fields were already validated and clamped by `parseMcpInputRequests`
 * (at most 8, names and labels bounded) before they got here, so this is a
 * projection and not a second validation pass. Deliberately so: two validators
 * for one vocabulary is how the two directions drift apart.
 */
export function toEmbeddedInputRequests(
  request: ToolEmittedInputRequest,
  message: string,
): Record<string, ReturnType<typeof inputRequired.elicit>> {
  const properties: Record<string, ElicitFieldSchema> = {};
  const required: string[] = [];
  for (const field of request.inputRequests) {
    properties[field.name] = fieldSchema(field);
    // Absent `required` means required on omadia's dialect (a server that
    // bothered to block on a field is asking for it); the spec is explicit
    // instead, so the implicit rule is made explicit here rather than lost.
    if (field.required !== false) required.push(field.name);
  }
  const notice = secrecyNotice(request.inputRequests);
  return {
    [MODERN_INPUT_REQUEST_KEY]: inputRequired.elicit({
      message: notice === undefined ? message : `${message} ${notice}`,
      requestedSchema: { type: 'object', properties, required },
    }),
  };
}

/**
 * Flatten the client's `inputResponses` back into the object a tool expects.
 *
 * Returns `undefined` when there is nothing usable — a missing key, or an
 * elicitation the human declined or cancelled. That is NOT an error here: a
 * declined card means the tool never got its answer, so the call proceeds as
 * if the values were never supplied and the tool decides what to do. Turning a
 * decline into a protocol error would make "the user pressed cancel" look like
 * a broken client.
 *
 * The values are the human's, relayed untouched. This endpoint does not read
 * them and must not: they may be the secrets the card asked for.
 */
export function flattenInputResponses(
  responses: unknown,
): Record<string, unknown> | undefined {
  if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) {
    return undefined;
  }
  const entry = (responses as Record<string, unknown>)[MODERN_INPUT_REQUEST_KEY];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const shape = entry as { action?: unknown; content?: unknown };
  if (shape.action !== 'accept') return undefined;
  if (shape.content === null || typeof shape.content !== 'object' || Array.isArray(shape.content)) {
    return undefined;
  }
  const content = shape.content as Record<string, unknown>;
  return Object.keys(content).length > 0 ? content : undefined;
}
