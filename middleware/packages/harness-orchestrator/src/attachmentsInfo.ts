/**
 * Parser for the `[attachments-info]` block appended to the user message by
 * the Teams channel adapter (GitHub issue #268, sub-problem 2).
 *
 * The Teams adapter persists each uploaded file to the shared S3/Tigris
 * bucket and appends a human-readable manifest to the END of the user
 * message. This module turns that manifest back into structured candidates
 * the orchestrator's auto-ingest path can fetch + extract.
 *
 * Exact format produced by teamsBot.ts (we only PARSE it):
 *
 *   [attachments-info] <N> Datei(en) in diesem Turn hochgeladen + persistiert:
 *   - <fileName> (<contentType>, <sizeKb> KB) · storage_key=<storageKey>
 *   - <fileName> (<contentType>, <sizeKb> KB) · storage_key=<storageKey> · signed_url=<signedUrl>
 *
 * The field separator is ` · ` (U+00B7 middle dot, space-padded). The
 * parser is deliberately tolerant: a malformed line is skipped rather than
 * aborting the whole block.
 */

export interface ParsedAttachmentInfo {
  fileName: string;
  contentType: string;
  storageKey: string;
  signedUrl?: string;
}

const HEADER_RE = /^\[attachments-info\]/m;

// Per-file line. Captures:
//   1: fileName, 2: contentType, 3: rest (storage_key=… [· signed_url=…])
// `[\s·]*` after the closing paren tolerates the ` · ` separator and
// any whitespace variance.
const LINE_RE =
  /^-\s+(.+?)\s+\(([^,]+),\s*[^)]*\)[\s·]*storage_key=(\S+?)(?:[\s·]+signed_url=(\S+))?\s*$/;

/**
 * Parse the `[attachments-info]` block out of a user message. Returns `[]`
 * when no block is present or no per-file line parses. Never throws.
 */
export function parseAttachmentsInfo(
  userMessage: string,
): ParsedAttachmentInfo[] {
  if (typeof userMessage !== 'string' || userMessage.length === 0) return [];
  const headerMatch = HEADER_RE.exec(userMessage);
  if (!headerMatch) return [];

  // Only scan lines AFTER the header line — the manifest is always appended
  // at the end, so this avoids accidentally matching message body text.
  const fromHeader = userMessage.slice(headerMatch.index);
  const lines = fromHeader.split('\n');

  const out: ParsedAttachmentInfo[] = [];
  for (const line of lines) {
    const m = LINE_RE.exec(line.trim());
    if (!m) continue;
    const [, fileName, contentType, storageKey, signedUrl] = m;
    if (!fileName || !storageKey) continue;
    const entry: ParsedAttachmentInfo = {
      fileName: fileName.trim(),
      contentType: (contentType ?? '').trim(),
      storageKey: storageKey.trim(),
    };
    if (signedUrl) entry.signedUrl = signedUrl.trim();
    out.push(entry);
  }
  return out;
}
