import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import {
  FIELD_CLASSIFICATION_STATUSES,
  type FieldClassificationStatus,
} from '../../_lib/api';
import { PrivacyFieldsView } from './_components/PrivacyFieldsView';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('adminPrivacyFields');
  return { title: t('metaTitle') };
}

const DEFAULT_STATUS: FieldClassificationStatus = 'suggested';

function parseStatus(raw: string | string[] | undefined): FieldClassificationStatus {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (FIELD_CLASSIFICATION_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as FieldClassificationStatus)
    : DEFAULT_STATUS;
}

function parseTool(raw: string | string[] | undefined): string | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? value : null;
}

/**
 * `/admin/privacy-fields` — reads `?status=` / `?tool=` server-side and hands
 * them to the client view; the tabs are plain links, so the URL stays the
 * single source of the filter.
 */
export default async function AdminPrivacyFieldsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; tool?: string | string[] }>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const status = parseStatus(params.status);
  const tool = parseTool(params.tool);
  return <PrivacyFieldsView key={`${status}:${tool ?? ''}`} status={status} tool={tool} />;
}
