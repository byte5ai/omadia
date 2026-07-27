/**
 * Attachment text extraction (GitHub issue #268, sub-problem 2).
 *
 * Pure, dependency-light extraction of plain text from user-uploaded
 * attachments so the orchestrator can read .docx / .pdf / .md / .txt /
 * .csv / .json content WITHOUT the user pasting it. Used by both the
 * server-side auto-ingest path and the explicit `read_attachment` tool.
 *
 * The routing decision is contentType-first, then a fileName-extension
 * fallback. Binary formats (.docx, .pdf) are extracted via `mammoth` /
 * `pdf-parse`, imported dynamically so a missing/odd dependency can never
 * crash module load. Images are deliberately NOT text-extracted here — they
 * flow through the existing brand:// / vision path untouched.
 *
 * `pdf-parse` v2+ replaced the v1 callable-default-export API
 * (`pdf(buffer) -> { text }`) with a class-based API
 * (`new PDFParse({ data }).getText() -> { text }`); see the `PDFParse`
 * usage below. The parser must be `destroy()`-ed after use to release the
 * underlying pdf.js worker/canvas resources.
 */

/** Hard cap on extracted text to protect the turn's token budget. */
const MAX_TEXT_CHARS = 20_000;
const TRUNCATION_MARKER = '\n…[truncated]';

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** Anthropic's vision API only accepts these four raster formats via a
 *  base64 image content-block. */
const SUPPORTED_VISION_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Anthropic's documented per-image cap for the *base64-encoded* payload
 *  when calling the direct API (`https://api.anthropic.com`, which is what
 *  `builtinLlmProviders.ts` uses): 10 MB base64-encoded. (Bedrock and Vertex
 *  enforce a stricter 5 MB base64 cap — irrelevant today since this deployment
 *  only talks to the direct API, but worth remembering if that ever changes.)
 *  Oversized images are dropped before the API call rather than risking a
 *  4xx that fails the whole turn. */
const MAX_VISION_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;

/** Size of `rawBytes` once base64-encoded, without actually allocating the
 *  base64 string: base64 emits 4 output chars per 3 input bytes, rounded up
 *  to the next multiple of 4 (padding). */
function base64EncodedLength(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export type VisionEmbedCheck =
  | { ok: true; mediaType: string }
  | { ok: false; reason: string };

/** Lowercased file extension (without the dot), or '' when absent. */
function extOf(fileName: string | undefined): string {
  if (!fileName) return '';
  const idx = fileName.lastIndexOf('.');
  if (idx < 0 || idx === fileName.length - 1) return '';
  return fileName.slice(idx + 1).toLowerCase();
}

function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return '';
  // Strip charset / boundary params: "text/plain; charset=utf-8" → "text/plain".
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/** Collapse 3+ consecutive blank lines to a single blank line and trim. */
function collapseBlankLines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function capText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + TRUNCATION_MARKER;
}

function finalize(text: string): ExtractResult {
  const cleaned = capText(collapseBlankLines(text));
  if (cleaned.length === 0) {
    return { ok: false, reason: 'no extractable text content' };
  }
  return { ok: true, text: cleaned };
}

const PLAIN_TEXT_TYPES = new Set([
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'text/csv',
  'application/json',
  'text/json',
]);
const PLAIN_TEXT_EXTS = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'csv',
  'json',
]);

const DOCX_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_TYPE = 'application/pdf';

/**
 * Guard for the attachment auto-ingest path's image branch (issues #504,
 * #505): decides whether a fetched attachment (Tigris `storage_key` or
 * `url`) can be embedded as an Anthropic vision content-block, as opposed to
 * being silently dropped after fetch. Never throws.
 */
export function checkVisionEmbeddable(
  contentType: string | undefined,
  byteLength: number,
): VisionEmbedCheck {
  const ct = normalizeContentType(contentType);
  if (!SUPPORTED_VISION_IMAGE_TYPES.has(ct)) {
    return {
      ok: false,
      reason: `unsupported image type for vision (contentType=${ct || 'unknown'})`,
    };
  }
  const encodedLength = base64EncodedLength(byteLength);
  if (encodedLength > MAX_VISION_IMAGE_BASE64_BYTES) {
    return {
      ok: false,
      reason: `image too large for vision (${encodedLength} base64-encoded bytes > ${MAX_VISION_IMAGE_BASE64_BYTES} byte cap)`,
    };
  }
  return { ok: true, mediaType: ct };
}

/**
 * Extract plain text from an attachment's bytes. Never throws — any failure
 * (unknown type, corrupt binary, missing extractor) resolves to
 * `{ ok: false, reason }`.
 */
export async function extractAttachmentText(
  bytes: Buffer,
  contentType: string | undefined,
  fileName: string | undefined,
): Promise<ExtractResult> {
  const ct = normalizeContentType(contentType);
  const ext = extOf(fileName);

  // Images: not text-extractable here. The brand:// / vision path handles them.
  if (ct.startsWith('image/')) {
    return {
      ok: false,
      reason: 'image — embed via brand:// / vision, not text-extractable',
    };
  }

  try {
    // 1. Plain-text family (UTF-8 decode).
    if (PLAIN_TEXT_TYPES.has(ct) || PLAIN_TEXT_EXTS.has(ext)) {
      return finalize(bytes.toString('utf8'));
    }

    // 2. .docx via mammoth.
    if (ct === DOCX_TYPE || ext === 'docx') {
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({ buffer: bytes });
      return finalize(result.value ?? '');
    }

    // 3. .pdf via pdf-parse (dynamic import — historically runs debug code on
    //    top-level import, so we only touch it inside the function + guarded).
    //    v2+ API: `new PDFParse({ data }).getText()`, must `destroy()` after.
    if (ct === PDF_TYPE || ext === 'pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        return finalize(result.text ?? '');
      } finally {
        await parser.destroy().catch(() => {
          /* best-effort cleanup — never let it mask the real result/error */
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `extraction failed: ${msg}` };
  }

  return {
    ok: false,
    reason: `unsupported attachment type (contentType=${
      ct || 'unknown'
    }, ext=${ext || 'none'})`,
  };
}
