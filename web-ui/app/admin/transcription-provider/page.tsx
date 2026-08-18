import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { TranscriptionProviderPanel } from './_components/TranscriptionProviderPanel';

/**
 * `/admin/transcription-provider` — connect + select the `transcription@1`
 * provider (#584). Mirrors the LLM providers page shape (server page,
 * client panel); the provider list, key verdicts and the AVV/EU disclosure
 * all come from `/api/v1/admin/transcription-provider`.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('adminTranscriptionProvider');
  return { title: t('metaTitle') };
}

export default function AdminTranscriptionProviderPage(): React.ReactElement {
  return <TranscriptionProviderPanel />;
}
