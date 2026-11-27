/**
 * #1920 / ADR-0207 / ADR-0272 — binary MCP content on its way to a model.
 *
 * `renderToolResult` turns every binary block (image, audio, blob resource)
 * into a text placeholder: base64 never reaches a model as text. For an image
 * that is not the end of it. A successful call's eligible images are recorded
 * into a per-dispatch capture (a dedicated AsyncLocalStorage, like
 * `mcpStructuredCapture`), and the orchestrator attaches them to the
 * `tool_result` as provider image blocks — but only when no shield masks the
 * server's results (operator bypass in force, or no privacy guard). Under a
 * guard the capture is dropped: the shield cannot check an image's contents.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Image types every provider adapter accepts in a tool result. */
const MODEL_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Decoded bytes per image: Anthropic's 5 MB base64 limit, decoded. */
export const MCP_MODEL_IMAGE_MAX_BYTES = 3_750_000;

/** Images per call that may reach the model; further ones stay placeholders. */
export const MCP_MODEL_IMAGE_MAX_COUNT = 4;

/** Decoded bytes of all images one provider request may carry. Images of
 *  earlier iterations are turned back into text first (`stripModelImages`),
 *  so this bounds every request, not just one batch. */
export const MCP_MODEL_IMAGE_REQUEST_MAX_BYTES = 8_000_000;

/** One image a tool returned that may be shown to the model. */
export interface McpModelImage {
  readonly mediaType: string;
  /** Base64, as the server sent it (whitespace removed). */
  readonly data: string;
  /** The placeholder `renderToolResult` wrote for it. */
  readonly placeholder: string;
  /** Decoded size. */
  readonly bytes: number;
}

/** What is left for images in one provider request. */
export interface ModelImageBudget {
  bytesLeft: number;
  countLeft: number;
}

export function newModelImageBudget(): ModelImageBudget {
  return { bytesLeft: MCP_MODEL_IMAGE_REQUEST_MAX_BYTES, countLeft: MCP_MODEL_IMAGE_MAX_COUNT };
}

/** Bytes a base64 string decodes to (padding-aware, no decode). */
export function base64Bytes(data: string): number {
  const clean = data.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

const NOT_SHOWN = ' — not shown to the model]';
const ATTACHED = ' — attached as an image]';

/**
 * #1920 — the placeholder for a binary MCP content block, or undefined for a
 * block that is not binary. Covers `image` and `audio` blocks and a
 * `resource` whose content is a `blob`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function binaryBlockPlaceholder(block: any): string | undefined {
  const kind: string | undefined =
    block?.type === 'image' || block?.type === 'audio'
      ? block.type
      : block?.type === 'resource' && typeof block.resource?.blob === 'string'
        ? 'binary resource'
        : undefined;
  if (kind === undefined) return undefined;
  const data: unknown = kind === 'binary resource' ? block.resource.blob : block.data;
  const mime: unknown = kind === 'binary resource' ? block.resource.mimeType : block.mimeType;
  const size = typeof data === 'string' ? `${String(base64Bytes(data))} bytes` : 'unknown size';
  const type = typeof mime === 'string' && mime.length > 0 ? mime.slice(0, 100) : 'unknown type';
  return `[${kind}: ${type}, ${size}${NOT_SHOWN}`;
}

/** The images of a successful result that a model may be shown. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function modelImagesOf(res: any): McpModelImage[] {
  if (res === null || typeof res !== 'object' || res.isError === true) return [];
  const content: unknown = res.content;
  if (!Array.isArray(content)) return [];
  const images: McpModelImage[] = [];
  for (const block of content) {
    if (images.length >= MCP_MODEL_IMAGE_MAX_COUNT) break;
    if (block?.type !== 'image' || typeof block.data !== 'string') continue;
    if (typeof block.mimeType !== 'string' || !MODEL_IMAGE_MEDIA_TYPES.has(block.mimeType)) continue;
    const data = block.data.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    const bytes = base64Bytes(data);
    if (bytes === 0 || bytes > MCP_MODEL_IMAGE_MAX_BYTES) continue;
    const placeholder = binaryBlockPlaceholder(block);
    if (placeholder === undefined) continue;
    images.push({ mediaType: block.mimeType, data, placeholder, bytes });
  }
  return images;
}

interface McpImageCapture {
  readonly images: McpModelImage[];
}

const captureStorage = new AsyncLocalStorage<McpImageCapture>();

/** Run `fn` and collect the model-eligible images MCP calls produced in it. */
export async function captureMcpImages<T>(
  fn: () => Promise<T>,
): Promise<{ readonly value: T; readonly images: readonly McpModelImage[] }> {
  const capture: McpImageCapture = { images: [] };
  const value = await captureStorage.run(capture, fn);
  return { value, images: capture.images };
}

/** Called by `McpManager` for a successful result. Outside a capture nothing
 *  happens. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function recordMcpImages(res: any): void {
  const capture = captureStorage.getStore();
  if (capture === undefined) return;
  const room = MCP_MODEL_IMAGE_MAX_COUNT - capture.images.length;
  if (room <= 0) return;
  capture.images.push(...modelImagesOf(res).slice(0, room));
}

/** A `tool_result` block as the tool loop builds it. */
interface ToolResultBlock {
  readonly type: string;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

/**
 * The `tool_result` with its images attached: text first (each attached
 * image's placeholder now says so), then one provider image block per image.
 * An image is attached only while `budget` has room and only when its
 * placeholder is still in the text (the result cap may have cut it).
 * Unchanged without images, for an error result, or for non-text content.
 */
export function withModelImages<B extends ToolResultBlock>(
  block: B,
  images: readonly McpModelImage[] | undefined,
  budget: ModelImageBudget,
): B {
  if (images === undefined || images.length === 0) return block;
  if (block.type !== 'tool_result' || block['is_error'] === true) return block;
  if (typeof block.content !== 'string') return block;
  let text = block.content;
  const attached: McpModelImage[] = [];
  for (const image of images) {
    if (budget.countLeft <= 0 || image.bytes > budget.bytesLeft) continue;
    if (!text.includes(image.placeholder)) continue;
    text = text.replace(image.placeholder, image.placeholder.replace(NOT_SHOWN, ATTACHED));
    budget.countLeft -= 1;
    budget.bytesLeft -= image.bytes;
    attached.push(image);
  }
  if (attached.length === 0) return block;
  return {
    ...block,
    content: [
      { type: 'text', text },
      ...attached.map((image) => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      })),
    ],
  };
}

/**
 * Turns the image parts of earlier `tool_result` blocks back into their text,
 * so an image is sent with the request right after its call and not again on
 * every later iteration. Replaces message entries; their objects stay as
 * they were.
 */
export function stripModelImages(messages: Array<{ role: string; content: unknown }>): void {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    let changed = false;
    const content = (message.content as unknown[]).map((part) => {
      const block = part as { type?: unknown; content?: unknown };
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) return part;
      const parts = block.content as Array<{ type?: unknown; text?: unknown }>;
      if (!parts.some((p) => p.type === 'image')) return part;
      changed = true;
      const text = parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => String(p.text).replaceAll(ATTACHED, ' — shown to the model in an earlier step]'))
        .join('\n');
      return { ...block, content: text };
    });
    if (changed) messages[i] = { ...message, content };
  }
}
