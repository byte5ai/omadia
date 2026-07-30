/**
 * Epic #470 — parse a JSON artifact's text (plan, analysis, bootstrap_report,
 * ...) into a plain record for readable rendering. Artifact schemas vary by
 * `kind` and aren't rigidly typed client-side, so this stays fully generic:
 * callers render each top-level field by its own JS type rather than a
 * per-kind template. Returns `null` for anything that isn't parseable JSON or
 * isn't a plain object (an array or primitive at the top level) — the caller
 * falls back to showing the raw text verbatim in that case.
 */
export function parseArtifactRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}
