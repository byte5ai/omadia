import type { NotesStore } from '../notesStore.js';

export interface WeeklyDigestOptions {
  readonly notes: NotesStore;
  readonly signal: AbortSignal;
  readonly log: (...args: unknown[]) => void;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function weeklyDigestJob(
  opts: WeeklyDigestOptions,
): Promise<void> {
  if (opts.signal.aborted) return;
  const all = await opts.notes.list();
  if (opts.signal.aborted) return;
  const recent = all.filter((n) => isWithinLast7Days(n.createdAt));
  opts.log('weekly-digest tick', {
    totalNotes: all.length,
    recentNotes: recent.length,
  });
}

function isWithinLast7Days(iso: string): boolean {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < SEVEN_DAYS_MS;
}
