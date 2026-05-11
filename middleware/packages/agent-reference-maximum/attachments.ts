import type { NativeToolAttachment } from '@omadia/plugin-api';

import type { NoteRecord } from './types.js';

const PREVIEW_MAX = 200;

export function buildNoteCardAttachment(
  record: NoteRecord,
): NativeToolAttachment {
  const bodyPreview =
    record.body.length > PREVIEW_MAX
      ? `${record.body.slice(0, PREVIEW_MAX - 3)}...`
      : record.body;
  return {
    kind: 'note-card',
    payload: {
      noteId: record.id,
      title: record.title,
      bodyPreview,
      createdAt: record.createdAt,
    },
  };
}
