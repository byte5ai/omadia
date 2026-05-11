export type { PluginContext } from '@omadia/plugin-api';

export interface NoteRecord {
  readonly id: string;
  readonly title: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export interface AddNoteResult {
  readonly noteId: string;
  readonly createdAt: string;
  /** OB-29-2 — number of PluginEntity nodes the extractor produced and the
   *  KG ingested. 0 when ctx.knowledgeGraph is unavailable, no entities
   *  matched, or ingest failed (best-effort). */
  readonly kgInsertedEntities: number;
}
