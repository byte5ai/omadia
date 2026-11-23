/**
 * Spec 2042 §5.10 (S3c) — the result of a tool a plugin registers with
 * `ctx.tools.register` / `registerHandler`.
 *
 * A handler returns text, as it always could, or the same structured result a
 * sub-agent tool returns (`LocalSubAgentToolResult`):
 *
 *  - `output` — the text the calling agent's model receives.
 *  - `limitSignal` — the tool hit a structural limit (row cap, unsupported
 *    operation, truncated page). The kernel appends a short note to `output`
 *    so the model does not take partial data for complete (`limitSignal.ts`).
 *  - `postcondition` — the tool's own output check failed. The kernel records
 *    the issues on the turn's run trace; the verifier raises a
 *    `tool_postcondition` claim for them and drives its correction loop.
 *  - `structured` — data for a caller that reads it (the capability's
 *    result as data, §5.10). Never sent to the model: the model sees
 *    `output`, exactly as on the sub-agent path.
 */
import type { LocalSubAgentToolResult } from './localSubAgentTool.js';
import { appendLimitSignalNote } from './limitSignal.js';

export type NativeToolResult = LocalSubAgentToolResult;

/** What a native tool handler resolves to. */
export type NativeToolOutput = string | NativeToolResult;

/** The kernel's reading of a handler's result. */
export interface NormalizedNativeToolResult {
  /** The model-facing text: `output`, plus the limit note when there is one. */
  readonly text: string;
  readonly postcondition?: { readonly issues: readonly string[] };
  readonly structured?: NativeToolResult['structured'];
}

/** A structured result: an object with a string `output`. */
export function isNativeToolResult(value: unknown): value is NativeToolResult {
  return typeof value === 'object' && value !== null && typeof (value as { output?: unknown }).output === 'string';
}

/**
 * The text a dispatch path hands on for a handler's result: text stays text,
 * a structured result becomes its model-facing text, and anything else — a
 * plugin that breaks the type (an object, a content-block array) — becomes
 * a refusal. Such a value is never passed on: the Privacy Shield masks text
 * only, so a non-string would reach the model unmasked, and turning it into
 * JSON would make it look like a legitimate result.
 */
export function nativeToolDispatchText(raw: unknown, toolName: string): string {
  if (typeof raw === 'string' || isNativeToolResult(raw)) return nativeToolResultText(raw);
  return unreadableToolResultNotice(toolName);
}

/** The refusal for a result that is neither text nor a structured result. */
export function unreadableToolResultNotice(toolName: string): string {
  const name = toolName.replace(/[`\r\n]/g, '');
  return `Error: tool \`${name}\` returned a result that is neither text nor a structured result; it was not passed on.`;
}

/**
 * Reads a handler's result. Tolerant of a plugin that breaks the type: a
 * value that is neither a string nor an object with a string `output` is
 * turned into its JSON text, never thrown on.
 */
export function normalizeNativeToolResult(raw: unknown): NormalizedNativeToolResult {
  if (typeof raw === 'string') return { text: raw };
  if (!isNativeToolResult(raw)) return { text: JSON.stringify(raw) ?? '' };
  const result = raw;
  const issues = result.postcondition?.issues;
  return {
    text: appendLimitSignalNote(result.output, result.limitSignal),
    ...(Array.isArray(issues) && issues.length > 0 ? { postcondition: { issues: issues.map(String) } } : {}),
    ...(result.structured !== undefined ? { structured: result.structured } : {}),
  };
}

/** The model-facing text of a handler's result. */
export function nativeToolResultText(raw: unknown): string {
  return normalizeNativeToolResult(raw).text;
}
