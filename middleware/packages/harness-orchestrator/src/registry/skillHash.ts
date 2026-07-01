import { createHash } from 'node:crypto';

/**
 * Deterministic content identity for a skill: sha256 (hex) over its
 * canonicalized frontmatter + body.
 *
 * Used for re-import dedup / convergence (#391) and re-version-on-change
 * (#397): two skills with identical content hash to the same value regardless
 * of frontmatter key order, so re-imports and edits converge instead of
 * duplicating. The canonical form sorts object keys recursively, so
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same hash.
 */
export function computeSkillHash(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const payload = `fm=${canonicalize(frontmatter)}\nbody=${body}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Stable JSON-ish serialization with recursively sorted object keys. Arrays
 * keep their order (order is meaningful); objects do not.
 *
 * This mirrors `JSON.stringify` exactly for the shapes it can encode, because
 * frontmatter is persisted to the jsonb column via `JSON.stringify`: an
 * `undefined`-valued object key is dropped (not coerced to null), and an
 * `undefined` array element becomes `null`. Mirroring keeps the hashed bytes
 * identical to the stored bytes, so the hash a fresh upsert computes always
 * equals the one a read-modify-write recomputes from the round-tripped row.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // Only reached as an array element for undefined/function/symbol, which
    // JSON.stringify renders as null.
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined) // JSON.stringify drops undefined-valued keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${entries.join(',')}}`;
}
