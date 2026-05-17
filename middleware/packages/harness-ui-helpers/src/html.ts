declare const _htmlFragmentBrand: unique symbol;

export interface HtmlFragment {
  readonly __brand: typeof _htmlFragmentBrand;
  readonly value: string;
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: unknown): string {
  if (input === null || input === undefined) return '';
  const str = typeof input === 'string' ? input : String(input);
  return str.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/** Mark a string as pre-escaped HTML that html`` should NOT re-escape. */
export function safe(value: string): HtmlFragment {
  return { value } as HtmlFragment;
}

function isFragment(value: unknown): value is HtmlFragment {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { value?: unknown }).value === 'string' &&
    Object.keys(value as Record<string, unknown>).length === 1
  );
}

/**
 * Tagged template literal that produces an HtmlFragment. All interpolations
 * are HTML-escaped by default; wrap in `safe()` to opt out (e.g. for nested
 * fragments produced by other html`` calls).
 *
 * Arrays of fragments/strings are joined without separators — convenient
 * for mapping over data.
 */
export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): HtmlFragment {
  const out: string[] = [];
  for (let i = 0; i < strings.length; i += 1) {
    out.push(strings[i] ?? '');
    if (i < values.length) {
      out.push(renderValue(values[i]));
    }
  }
  return safe(out.join(''));
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (isFragment(value)) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(value);
}
