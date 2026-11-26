import type { StoredTurnAttachment } from '@omadia/channel-sdk';

/**
 * Test helper (#1962): the structured uploads a channel adapter would state
 * for a message that also carries the human-readable `[attachments-info]`
 * lines. The kernel no longer parses those lines; tests that still write them
 * for readability derive the adapter's structured field here.
 */
export function statedUploads(message: string): StoredTurnAttachment[] {
  const out: StoredTurnAttachment[] = [];
  for (const line of message.split('\n')) {
    const m = /^-\s+(.+?)\s+\(([^,]+),[^)]*\)[\s·]*storage_key=(\S+)/.exec(line.trim());
    if (m?.[1] && m[2] && m[3]) {
      out.push({ fileName: m[1].trim(), contentType: m[2].trim(), storageKey: m[3].trim() });
    }
  }
  return out;
}
