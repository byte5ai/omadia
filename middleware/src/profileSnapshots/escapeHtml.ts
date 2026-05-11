/**
 * Minimal HTML-escaper for the few places where we interpolate caller-supplied
 * values into the snapshot admin UI's static HTML shell. Kept separate from
 * the renderer module so it's straightforwardly testable and can be reused
 * if more server-rendered admin views land.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}
