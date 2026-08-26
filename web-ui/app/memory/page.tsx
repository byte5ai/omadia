'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Markdown } from '../_components/Markdown';
import { Button } from '@/app/_components/ui/Button';
import { getMemoryBackend, type MemoryBackend } from '../_lib/api';

import {
  MemoryContextTree,
  type DirEntry,
} from './_components/MemoryContextTree';
import { PromoteDialog } from './_components/PromoteDialog';
import { PromotionAuditPanel } from './_components/PromotionAuditPanel';
import {
  MEMORY_ROOT,
  agentTierRoot,
  basename,
  contextAxisRoot,
  contextTierRoot,
  cwdToCrumbs,
  formatSize,
  parentOf,
  parseAgentTierPath,
  parseContextPath,
  type MemoryContextRef,
} from './_lib/memoryPaths';

/**
 * Scratch-memory browser with the context dimension from design #870.
 *
 * The store is no longer one flat agent tree: `/memories/contexts/<slug>/…`
 * holds a tree per chat context (team / channel / user), and knowledge only
 * crosses those boundaries through an explicit, audited promote. This page is
 * the operator surface for exactly that — browse a context, promote out of it,
 * read the audit log.
 */

interface Entry {
  virtualPath: string;
  isDirectory: boolean;
  sizeBytes: number;
}

interface ListResponse {
  path: string;
  entries: Entry[];
}

type RightTab = 'file' | 'audit';

function listUrl(path: string): string {
  return `/bot-api/dev/memory/list?path=${encodeURIComponent(path)}`;
}

export default function MemoryPage(): React.ReactElement {
  const t = useTranslations('memory');
  const [cwd, setCwd] = useState<string>(MEMORY_ROOT);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [listError, setListError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [backend, setBackend] = useState<MemoryBackend | null>(null);
  const [tab, setTab] = useState<RightTab>('file');
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [teamKeys, setTeamKeys] = useState<readonly string[]>([]);
  const [promoteNotice, setPromoteNotice] = useState<string | null>(null);
  const [auditToken, setAuditToken] = useState(0);

  const loadDir = useCallback(async (path: string): Promise<void> => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await fetch(listUrl(path));
      if (!res.ok) {
        const contentType = res.headers.get('content-type') ?? '';
        const body = await res.text().catch(() => '');
        const looksHtml =
          contentType.includes('text/html') ||
          body.trimStart().toLowerCase().startsWith('<!doctype');
        if (res.status === 500 && looksHtml) {
          // #667 — same misdiagnosis as the chat path: a 500 means something
          // answered, so "middleware unreachable" (on a hardcoded dev host) is
          // an assertion this code never checked.
          setListError(t('errorUpstreamErrorPage'));
        } else if (res.status === 404) {
          setListError(t('errorDevEndpointUnavailable'));
        } else {
          setListError(
            body && !looksHtml
              ? body
              : t('errorListFailed', { status: String(res.status) }),
          );
        }
        setEntries([]);
        return;
      }
      const data = (await res.json()) as ListResponse;
      // Exclude the "self" entry (the listed directory itself) and sort:
      // directories first, then files, each alphabetically.
      const visible = data.entries
        .filter((e) => e.virtualPath !== path)
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.virtualPath.localeCompare(b.virtualPath);
        });
      setEntries(visible);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoadingList(false);
    }
  }, [t]);

  /** Raw directory listing for the context tree — throws instead of rendering
   *  an error, so the tree can treat a missing branch as "empty". */
  const listDir = useCallback(async (path: string): Promise<DirEntry[]> => {
    const res = await fetch(listUrl(path));
    if (!res.ok) throw new Error(`list ${path}: ${String(res.status)}`);
    const data = (await res.json()) as ListResponse;
    return data.entries;
  }, []);

  const loadFile = useCallback(async (path: string): Promise<void> => {
    setLoadingFile(true);
    setFileError(null);
    try {
      const res = await fetch(
        `/bot-api/dev/memory/file?path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) {
        setFileError(t('errorFileFailed', { status: String(res.status) }));
        setContent('');
        return;
      }
      const text = await res.text();
      setContent(text);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
      setContent('');
    } finally {
      setLoadingFile(false);
    }
  }, [t]);

  useEffect(() => {
    // Best-effort backend badge — needs an authed session; the dev memory
    // browser itself runs unauthenticated, so swallow failures and just
    // omit the badge.
    void getMemoryBackend()
      .then((s) => setBackend(s.current))
      .catch(() => setBackend(null));
  }, []);

  useEffect(() => {
    // Load-on-change: loadDir marks the list 'loading' (one intended render)
    // before fetching the directory — not a cascading-render anti-pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDir(cwd);
  }, [cwd, loadDir]);

  useEffect(() => {
    // Load-on-selection: loadFile marks the file 'loading' (one intended
    // render) before fetching — not a cascading-render anti-pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selected) void loadFile(selected);
  }, [selected, loadFile]);

  const crumbs = cwdToCrumbs(cwd);
  const parent = parentOf(cwd);
  const isMarkdown = selected?.endsWith('.md') ?? false;

  const cwdContext = useMemo(() => parseContextPath(cwd), [cwd]);
  const selectedContext = useMemo(
    () => (selected === null ? null : parseContextPath(selected)),
    [selected],
  );
  const activeAgentTier = useMemo(() => parseAgentTierPath(cwd), [cwd]);
  const activeContext: MemoryContextRef | null = cwdContext;
  // Whose audit log the tab shows: the file in hand wins over the folder.
  const auditAgentSlug =
    selectedContext?.agentSlug ?? cwdContext?.agentSlug ?? activeAgentTier;
  const canPromote =
    selectedContext !== null && selectedContext.relPath.length > 0;

  const navigateTo = useCallback((path: string): void => {
    setCwd(path);
    setSelected(null);
    setTab('file');
    setPromoteNotice(null);
  }, []);

  const openPromote = useCallback(async (): Promise<void> => {
    if (selectedContext === null) return;
    // Team targets need a key; offer whatever team trees this agent already
    // has, but never require one of them — a brand-new team is legitimate.
    const root = contextAxisRoot(selectedContext.agentSlug, 'team');
    const found = await listDir(root).catch(() => [] as DirEntry[]);
    setTeamKeys(
      found
        .filter((e) => e.isDirectory && e.virtualPath !== root)
        .map((e) => basename(e.virtualPath))
        .sort((a, b) => a.localeCompare(b)),
    );
    setPromoteOpen(true);
  }, [listDir, selectedContext]);

  return (
    <main className="flex h-full">
      <aside className="flex w-80 min-w-0 flex-col border-r border-[color:var(--border)] bg-[color:var(--bg-elevated)]">
        <div className="border-b border-[color:var(--border)] px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[color:var(--fg)]">
              Memory
            </span>
            {backend !== null && (
              <span
                className={[
                  'rounded px-2 py-0.5 text-[10px] font-medium',
                  backend === 'postgres'
                    ? 'bg-[color:var(--success)]/10 text-[color:var(--success)]'
                    : 'bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
                ].join(' ')}
              >
                {backend === 'postgres' ? 'Postgres' : t('backendInMemory')}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-[color:var(--fg-muted)]">
            {backend === 'inmemory'
              ? t('descriptionInMemory')
              : backend === 'postgres'
                ? t('descriptionPostgres')
                : t('description')}
          </p>
        </div>

        <MemoryContextTree
          listDir={listDir}
          activeAgentTier={activeAgentTier}
          activeContext={activeContext}
          onSelectAgentTier={(slug) => { navigateTo(agentTierRoot(slug)); }}
          onSelectContext={(ref) => { navigateTo(contextTierRoot(ref)); }}
        />

        <div className="border-b border-[color:var(--border)] px-3 py-2 text-xs">
          <div className="mb-1 text-[color:var(--fg-muted)]">
            {t('pathLabel')}
          </div>
          <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-1">
                {i > 0 && <span className="text-[color:var(--fg-subtle)]">/</span>}
                {/* eslint-disable-next-line no-restricted-syntax -- inline breadcrumb path link, not a text CTA */}
                <button
                  type="button"
                  onClick={() => setCwd(c.path)}
                  className="rounded px-1 hover:bg-[color:var(--bg-soft)]"
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>
          {/* eslint-disable-next-line no-restricted-syntax -- inline low-emphasis text link (no fill/border/padding), not a CTA */}
          <button
            type="button"
            onClick={() => void loadDir(cwd)}
            className="mt-2 text-[11px] text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
          >
            {t('reload')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {parent !== null && (
            // eslint-disable-next-line no-restricted-syntax -- full-width file-browser navigation row, not a text CTA
            <button
              type="button"
              onClick={() => setCwd(parent)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)]"
            >
              ← ..
            </button>
          )}
          {loadingList && (
            <div className="px-3 py-2 text-xs text-[color:var(--fg-muted)]">
              {t('loading')}
            </div>
          )}
          {listError && (
            <div className="border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
              {listError}
            </div>
          )}
          {!loadingList && !listError && entries.length === 0 && (
            <div className="px-3 py-2 text-xs text-[color:var(--fg-muted)]">
              {t('empty')}
            </div>
          )}
          {entries.map((e) => {
            const name = basename(e.virtualPath);
            const activeFile = selected === e.virtualPath;
            return (
              // eslint-disable-next-line no-restricted-syntax -- file-browser selection row with active-state styling, not a text CTA
              <button
                key={e.virtualPath}
                type="button"
                onClick={() => {
                  if (e.isDirectory) {
                    setCwd(e.virtualPath);
                    setSelected(null);
                  } else {
                    setSelected(e.virtualPath);
                    setTab('file');
                  }
                }}
                className={[
                  'flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs transition',
                  activeFile
                    ? 'bg-[color:var(--bg-soft)]'
                    : 'hover:bg-[color:var(--bg-soft)]',
                ].join(' ')}
              >
                <span>{e.isDirectory ? '📁' : '📄'}</span>
                <span className="truncate">{name}</span>
                {!e.isDirectory && (
                  <span className="ml-auto text-[10px] text-[color:var(--fg-subtle)]">
                    {formatSize(e.sizeBytes)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-[color:var(--bg-soft)]">
        <div className="flex items-center gap-3 border-b border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-2 text-xs">
          <div className="flex items-center gap-1" role="tablist">
            {(['file', 'audit'] as const).map((id) => (
              // eslint-disable-next-line no-restricted-syntax -- tab control, not a text CTA
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => { setTab(id); }}
                className={[
                  'rounded px-2 py-1',
                  tab === id
                    ? 'bg-[color:var(--bg-soft)] text-[color:var(--fg-strong)]'
                    : 'text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)]',
                ].join(' ')}
              >
                {t(`tab.${id}`)}
              </button>
            ))}
          </div>
          {tab === 'file' && selected !== null && (
            <>
              <span className="truncate font-mono text-[color:var(--fg-muted)]">
                {selected}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {canPromote && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void openPromote()}
                    className="px-2 py-0.5"
                  >
                    {t('promote.openButton')}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadFile(selected)}
                  className="px-2 py-0.5"
                >
                  ↻
                </Button>
              </div>
            </>
          )}
        </div>

        {promoteNotice !== null && (
          <p className="border-b border-[color:var(--success)]/40 bg-[color:var(--success)]/5 px-4 py-2 text-xs text-[color:var(--success)]">
            {promoteNotice}
          </p>
        )}

        {tab === 'audit' ? (
          <PromotionAuditPanel
            agentSlug={auditAgentSlug}
            reloadToken={auditToken}
          />
        ) : selected === null ? (
          <div className="flex h-full items-center justify-center text-sm text-[color:var(--fg-muted)]">
            {t('selectEntry')}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
            {loadingFile && (
              <div className="text-xs text-[color:var(--fg-muted)]">
                {t('loading')}
              </div>
            )}
            {fileError && (
              <div className="border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
                {fileError}
              </div>
            )}
            {!loadingFile && !fileError && isMarkdown && (
              <Markdown source={content} />
            )}
            {!loadingFile && !fileError && !isMarkdown && (
              <pre className="whitespace-pre-wrap font-mono text-xs text-[color:var(--fg)]">
                {content}
              </pre>
            )}
          </div>
        )}
      </section>

      {promoteOpen && selectedContext !== null && (
        <PromoteDialog
          source={selectedContext}
          teamKeys={teamKeys}
          onClose={() => { setPromoteOpen(false); }}
          onPromoted={(receipt) => {
            setPromoteOpen(false);
            setPromoteNotice(t('promote.success', { path: receipt.targetPath }));
            setAuditToken((n) => n + 1);
            void loadDir(cwd);
          }}
        />
      )}
    </main>
  );
}
