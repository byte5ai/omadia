/**
 * Epic #470 — small line-based diff for the job log's `Edit` tool-call cards
 * (`old_string`/`new_string` → an inline unified diff). Self-contained
 * classic LCS diff — no external dependency for something this small.
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  text: string;
}

/** Defensive cap on the O(n·m) LCS table; pathologically large inputs fall
 *  back to a plain remove-all/add-all block instead of hanging the tab. */
const MAX_DIFF_CELLS = 4_000_000;

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length > 0 ? oldText.split('\n') : [];
  const b = newText.length > 0 ? newText.split('\n') : [];

  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ type: 'remove', text })),
      ...b.map((text): DiffLine => ({ type: 'add', text })),
    ];
  }

  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    if (!row) continue;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? dpAt(dp, i + 1, j + 1) + 1 : Math.max(dpAt(dp, i + 1, j), dpAt(dp, i, j + 1));
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i] ?? '' });
      i++;
      j++;
    } else if (dpAt(dp, i + 1, j) >= dpAt(dp, i, j + 1)) {
      out.push({ type: 'remove', text: a[i] ?? '' });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] ?? '' });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'remove', text: a[i] ?? '' });
    i++;
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j] ?? '' });
    j++;
  }
  return out;
}

function dpAt(dp: number[][], i: number, j: number): number {
  return dp[i]?.[j] ?? 0;
}
