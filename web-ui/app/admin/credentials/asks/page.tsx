import { AskInboxView } from '../_components/AskInboxView';

/**
 * Admin → Credentials → Asks (#2320, ADR-0102). The owner's ask inbox and the
 * signed-in user's own asks. The owner notice in chat (#2319) links here as
 * `/admin/credentials/asks?ask=<id>`; that ask is highlighted.
 */

export const dynamic = 'force-dynamic';

/** An ask id is an opaque server id; anything else is ignored. */
const ASK_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export default async function AdminCredentialAsksPage({
  searchParams,
}: {
  searchParams: Promise<{ ask?: string | string[] }>;
}): Promise<React.ReactElement> {
  const raw = (await searchParams).ask;
  const ask = typeof raw === 'string' && ASK_ID_RE.test(raw) ? raw : null;
  return <AskInboxView focusAskId={ask} />;
}
