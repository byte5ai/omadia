import { redirect } from 'next/navigation';

/**
 * Legacy route (#1397). This page used to render the cross-plugin settings
 * catalog, which by then held only the LLM provider API keys — the same keys
 * Admin → LLM access → "API keys" edits through the same PATCH, translated and
 * with a key test. Two forms for one value is one too many, so the path now
 * redirects there; bookmarks and deep links keep working.
 */
export default function AdminSettingsRedirect(): never {
  redirect('/admin/providers');
}
