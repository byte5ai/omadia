// Browser-local persistence for the conversational builder (live feedback 2026-10-30: a reload
// or a closed tab threw away the draft, the transcript and the connector/person picks, so every
// try meant re-sending the prompt and re-connecting). One record per browser profile under a
// versioned key; the page hydrates it on mount and writes on every change. Nothing here is a
// server draft — publish still goes through the versioned workflow path.

const STORAGE_KEY = 'omadia.conductor.chatDraft.v1';

export interface ChatDraftRecord {
  readonly version: 1;
  readonly savedAt: string;
  readonly items: readonly unknown[];
  readonly graph: unknown;
  readonly slug: string;
  readonly name: string;
  readonly connectedActions: Record<string, unknown>;
  readonly pickedPeople: Record<string, unknown>;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // privacy mode / blocked storage — the pane simply works unsaved
  }
}

export function loadChatDraft(): ChatDraftRecord | null {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatDraftRecord> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) return null;
    return {
      version: 1,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
      items: parsed.items,
      graph: parsed.graph ?? null,
      slug: typeof parsed.slug === 'string' ? parsed.slug : '',
      name: typeof parsed.name === 'string' ? parsed.name : '',
      connectedActions: isRecord(parsed.connectedActions) ? parsed.connectedActions : {},
      pickedPeople: isRecord(parsed.pickedPeople) ? parsed.pickedPeople : {},
    };
  } catch {
    return null; // corrupt record → start fresh rather than crash the page
  }
}

export function saveChatDraft(record: Omit<ChatDraftRecord, 'version' | 'savedAt'>): void {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...record }));
  } catch {
    /* quota exceeded or blocked — keep working unsaved */
  }
}

export function clearChatDraft(): void {
  storage()?.removeItem(STORAGE_KEY);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
