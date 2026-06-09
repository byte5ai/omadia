import { z } from 'zod';

import { extractAttachmentText } from '../attachmentExtract.js';

export const READ_ATTACHMENT_TOOL_NAME = 'read_attachment';

/**
 * Byte source for user-uploaded attachments. Implemented kernel-side over
 * the shared S3/Tigris bucket (the same store the brand:// logo flow and
 * Teams uploads use). Injected into the Orchestrator so harness-orchestrator
 * never imports @aws-sdk directly.
 */
export interface AttachmentReader {
  /**
   * Resolve bytes by the persisted storage key (Teams uploads). Returns
   * `undefined` when the store is unconfigured or the key is unknown.
   */
  readByStorageKey(
    storageKey: string,
  ): Promise<
    { bytes: Buffer; contentType?: string; fileName?: string } | undefined
  >;
  /**
   * Resolve bytes by URL (channels that hand back a fetchable URL rather than
   * a storage key). Returns `undefined` on fetch failure.
   */
  readByUrl(
    url: string,
  ): Promise<{ bytes: Buffer; contentType?: string } | undefined>;
}

const ReadAttachmentInputSchema = z.object({
  storage_key: z.string().min(1).max(1024),
});

export const readAttachmentToolSpec = {
  name: READ_ATTACHMENT_TOOL_NAME,
  description:
    'Liest den TEXT-Inhalt eines vom User in DIESEM oder einem früheren Turn hochgeladenen Dokuments (.docx, .pdf, .md, .txt, .csv, .json) über seinen `storage_key`. ' +
    'Die `storage_key`-Werte stehen im `[attachments-info]`-Block am Ende der User-Nachricht. ' +
    'In der Regel ist der Dokumentinhalt bereits automatisch als `[attachment-content: …]`-Block in die Nachricht eingebettet — nutze dieses Tool nur, wenn der Inhalt fehlt, abgeschnitten wurde, oder du eine Datei aus einem früheren Turn erneut lesen willst. ' +
    'Bilder sind NICHT text-extrahierbar (die werden separat als Vision-Input behandelt).',
  input_schema: {
    type: 'object' as const,
    properties: {
      storage_key: {
        type: 'string',
        description:
          'Der `storage_key` der Datei aus dem `[attachments-info]`-Block (z.B. `uploads/2026/abc123.docx`).',
      },
    },
    required: ['storage_key'],
  },
};

/**
 * Orchestrator-side handler for `read_attachment`. Resolves the attachment's
 * bytes via the injected {@link AttachmentReader}, extracts plain text, and
 * returns it (or a clear, model-readable error string). Never throws.
 */
export class ReadAttachmentTool {
  constructor(private readonly reader: AttachmentReader) {}

  async handle(input: unknown): Promise<string> {
    const parsed = ReadAttachmentInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid read_attachment input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    const key = parsed.data.storage_key;
    try {
      const found = await this.reader.readByStorageKey(key);
      if (!found) {
        return `Error: attachment \`${key}\` not found (storage unconfigured or key unknown).`;
      }
      const result = await extractAttachmentText(
        found.bytes,
        found.contentType,
        found.fileName,
      );
      if (!result.ok) {
        return `Error: could not read attachment \`${key}\` — ${result.reason}.`;
      }
      return result.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: failed to read attachment \`${key}\` — ${msg}.`;
    }
  }
}
