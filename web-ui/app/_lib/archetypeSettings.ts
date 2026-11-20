import { ApiError } from './api';
import type { ArchetypeText } from './archetypes';

/**
 * #2066 — per-agent settings of an agent's archetype (spec 2043 §7): for a
 * facilitator its default methods and reminder policy. The fields come from
 * the archetype plugin's manifest; the kernel validates and stores the values
 * (`GET/PUT /v1/operator/agents/:slug/archetype-settings`). A field that is
 * not set uses the plugin's instance setting.
 */

export type ArchetypeSettingValue = string | number[];

export interface ArchetypeSettingField {
  readonly key: string;
  readonly type: 'enum' | 'number_list';
  readonly label: ArchetypeText;
  readonly help: ArchetypeText | null;
  readonly options: readonly { readonly value: string; readonly label: ArchetypeText }[] | null;
  readonly max_items: number | null;
}

export interface ArchetypeSettings {
  readonly archetype: string;
  readonly fields: readonly ArchetypeSettingField[];
  readonly values: Readonly<Record<string, ArchetypeSettingValue>>;
}

export interface ArchetypeSettingIssue {
  readonly key: string;
  readonly message: string;
}

function botApi(path: string): string {
  return typeof window !== 'undefined'
    ? `/bot-api${path}`
    : `${process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979'}/api${path}`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(botApi(path), {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    cache: 'no-store',
    credentials: 'include',
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} failed: ${res.status}`, text);
  return JSON.parse(text) as T;
}

const settingsPath = (slug: string): string =>
  `/v1/operator/agents/${encodeURIComponent(slug)}/archetype-settings`;

export function getArchetypeSettings(slug: string): Promise<ArchetypeSettings> {
  return call<ArchetypeSettings>(settingsPath(slug));
}

/** `null` (or an empty list) clears a field: the instance setting applies again. */
export function saveArchetypeSettings(
  slug: string,
  settings: Readonly<Record<string, ArchetypeSettingValue | null>>,
): Promise<ArchetypeSettings> {
  return call<ArchetypeSettings>(settingsPath(slug), {
    method: 'PUT',
    body: JSON.stringify({ settings }),
  });
}

/** The findings of a 422 `invalid_archetype_settings`, else `null`. */
export function parseArchetypeSettingIssues(err: unknown): ArchetypeSettingIssue[] | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  try {
    const body = JSON.parse(err.body) as { error?: unknown; issues?: unknown };
    if (body.error !== 'invalid_archetype_settings' || !Array.isArray(body.issues)) return null;
    return body.issues.filter(
      (i): i is ArchetypeSettingIssue =>
        typeof i === 'object' && i !== null && typeof (i as ArchetypeSettingIssue).key === 'string',
    );
  } catch {
    return null;
  }
}

/** "24, 2" → [24, 2]; `undefined` when an entry is not a positive number. */
export function parseNumberListInput(raw: string): number[] | undefined {
  const parts = raw
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const values = parts.map((p) => Number(p.replace(',', '.')));
  return values.every((v) => Number.isFinite(v) && v > 0) ? values : undefined;
}
