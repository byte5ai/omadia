/**
 * #1093 — one canonicaliser for the `datasets.id` / `dataset_rows.dataset_id`
 * id space, shared by the `query_dataset` tool and the Neon graph so the two
 * layers cannot disagree about which ids exist.
 *
 * Both columns are Postgres `uuid`, and binding a non-uuid string against a
 * `uuid` column raises `22P02` BEFORE the `owner_omadia_user_id` predicate in
 * the same statement is evaluated — so the failure is neither catchable as
 * "not found" nor maskable by the ACL. Callers reach those columns with ids
 * chosen by an LLM (a Privacy-Shield digest hands the model a `ds_<uuid>` from
 * a DIFFERENT id space) or taken from a URL path, hence the check.
 *
 * Accepts every spelling Postgres itself accepts for `uuid` input — upper
 * case, braces, and hyphens omitted or placed differently — and returns the
 * canonical lower-case hyphenated form, so an id that used to resolve before
 * any validation existed still resolves. Anything else is `undefined`:
 * it addresses no row, which is what the caller then reports.
 */
const UUID_HEX_32 = /^[0-9a-f]{32}$/i;

export function normalizeDatasetUuid(raw: string): string | undefined {
  const trimmed = raw.trim();
  const unwrapped =
    trimmed.startsWith('{') && trimmed.endsWith('}')
      ? trimmed.slice(1, -1)
      : trimmed;
  // Postgres allows "omitting some or all hyphens" and "a hyphen after any
  // group of four digits", so strip them all and re-canonicalise rather than
  // enumerating the permitted placements.
  const hex = unwrapped.replace(/-/g, '');
  if (!UUID_HEX_32.test(hex)) return undefined;
  const lower = hex.toLowerCase();
  return [
    lower.slice(0, 8),
    lower.slice(8, 12),
    lower.slice(12, 16),
    lower.slice(16, 20),
    lower.slice(20),
  ].join('-');
}
