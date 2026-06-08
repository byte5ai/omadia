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
 */

/** Hard cap on extracted text to protect the turn's token budget. */
const MAX_TEXT_CHARS = 20_000;
const TRUNCATION_MARKER = '\n…[truncated]';

export type ExtractResult =
  | { ok: true; text: string }
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
    if (ct === PDF_TYPE || ext === 'pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      const result = await pdfParse(bytes);
      return finalize(result.text ?? '');
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
