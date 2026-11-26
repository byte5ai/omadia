'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ApiError } from '../../_lib/api';
import {
  getMcpServerHeaders,
  saveMcpServerHeaders,
  type McpServerHeaderInput,
  type McpServerNode,
} from '../../_lib/agentBuilder';
import { apiErrorBodyMessage } from './mcpErrors';

/** Header refusal codes of `PUT …/headers` → `adminMcp.servers.headers.errors.*`. */
const HEADER_ERROR_KEYS: Readonly<Record<string, string>> = {
  header_name_invalid: 'nameInvalid',
  header_name_reserved: 'nameReserved',
  header_name_duplicate: 'nameDuplicate',
  header_value_invalid: 'valueInvalid',
  header_value_required: 'valueRequired',
  header_secret_required: 'secretRequired',
  headers_too_many: 'tooMany',
  secrets_unavailable: 'secretsUnavailable',
};

interface Row {
  readonly id: number;
  name: string;
  secret: boolean;
  /** Plain value, or a NEW secret. Empty on a stored secret means "keep". */
  value: string;
  /** A secret already stored in the Vault for this header. */
  readonly stored: boolean;
}

const inputCls =
  'rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-xs outline-none focus:border-[color:var(--accent)]';

/**
 * #1912 / ADR-0210 — static request headers of an http/sse MCP server (an API
 * key in `x-api-key`, `Authorization: Bearer …`). A header marked secret is
 * sent to the Vault and never shown again; the row keeps only its name.
 */
export function ServerHeadersForm({
  server,
  onSaved,
}: {
  server: McpServerNode;
  /** Called after a save, so the config fields (re-derived) reload. */
  onSaved: () => void;
}): React.ReactElement | null {
  const t = useTranslations('adminMcp.servers.headers');
  const [rows, setRows] = useState<Row[]>([]);
  const [nextId, setNextId] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { headers } = await getMcpServerHeaders(server.id);
      setRows(
        headers.map((h, i) => ({
          id: i,
          name: h.name,
          secret: h.secret,
          value: h.secret ? '' : (h.value ?? ''),
          stored: h.secret && h.secretSet === true,
        })),
      );
      setNextId(headers.length);
    } catch (err) {
      setError(apiErrorBodyMessage(err) ?? (err instanceof Error ? err.message : String(err)));
    }
  }, [server.id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (server.transport === 'stdio') return null;

  const update = (id: number, patch: Partial<Row>): void =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const body: McpServerHeaderInput[] = rows
        .filter((r) => r.name.trim() !== '')
        .map((r) =>
          r.secret && r.value === ''
            ? { name: r.name.trim(), secret: true }
            : { name: r.name.trim(), secret: r.secret, value: r.value },
        );
      await saveMcpServerHeaders(server.id, body);
      setSaved(true);
      await load();
      onSaved();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      const key = code ? HEADER_ERROR_KEYS[code] : undefined;
      setError(
        key
          ? t(`errors.${key}`)
          : (apiErrorBodyMessage(err) ?? (err instanceof Error ? err.message : String(err))),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--card)]/40 p-2.5">
      <div className="text-xs font-medium text-[color:var(--fg-strong)]">{t('title')}</div>
      <div className="text-[11px] text-[color:var(--fg-muted)]">{t('intro')}</div>
      {rows.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={t('name')}
            value={r.name}
            onChange={(e) => update(r.id, { name: e.target.value })}
            placeholder={t('namePlaceholder')}
            className={`${inputCls} w-40 font-mono`}
          />
          <input
            aria-label={t('value')}
            type={r.secret ? 'password' : 'text'}
            autoComplete="off"
            value={r.value}
            onChange={(e) => update(r.id, { value: e.target.value })}
            placeholder={r.secret ? (r.stored ? t('secretStored') : t('secretPlaceholder')) : t('valuePlaceholder')}
            className={`${inputCls} grow`}
          />
          <label className="flex items-center gap-1 text-[10px] text-[color:var(--fg-subtle)]">
            <input
              type="checkbox"
              checked={r.secret}
              // A stored secret is never sent back to the browser, so turning
              // it plain would need a new value; the checkbox stays locked.
              disabled={r.stored}
              onChange={(e) => update(r.id, { secret: e.target.checked })}
            />
            {t('secret')}
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))}
          >
            {t('remove')}
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setRows((prev) => [...prev, { id: nextId, name: '', secret: true, value: '', stored: false }]);
            setNextId(nextId + 1);
          }}
        >
          {t('add')}
        </Button>
        <Button size="sm" busy={busy} onClick={() => void save()}>
          {t('save')}
        </Button>
        {saved ? <span className="text-[11px] text-[color:var(--success)]">{t('saved')}</span> : null}
      </div>
      {error ? <div className="text-xs text-[color:var(--danger)]">{error}</div> : null}
    </div>
  );
}
