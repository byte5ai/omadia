/**
 * Epic #470 W0 — shared pg row → domain coercion helpers.
 *
 * `dev_*` rows come back with snake_case columns; the domain types
 * (`src/devplatform/types.ts`) are camelCase, surface timestamptz as ISO
 * strings, and jsonb as structured objects. These tiny helpers do that
 * coercion and are shared by `devJobStore.ts` and `devRepoStore.ts` so neither
 * has to duplicate them (and so both stay under the 500-line file limit).
 */

/** A raw pg row keyed by column name. */
export type Row = Record<string, unknown>;

/** Non-null text column. */
export const str = (v: unknown): string => v as string;

/** Nullable text column. */
export const strN = (v: unknown): string | null => (v == null ? null : (v as string));

/** Numeric column (BIGINT / NUMERIC arrive as strings from pg) → number; null → 0. */
export const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** Non-null timestamptz → ISO string. */
export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** Nullable timestamptz → ISO string | null. */
export const isoN = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

/** jsonb column → structured object, with a typed fallback when NULL. */
export const asObj = <T>(v: unknown, fallback: T): T => (v == null ? fallback : (v as T));

/** text[] column → string[] (empty array when NULL). */
export const asArr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
