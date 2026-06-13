'use client';

import { useCallback, useEffect, useState } from 'react';
import { Markdown } from '../_components/Markdown';
import { Button } from '@/app/_components/ui/Button';
import { getMemoryBackend, type MemoryBackend } from '../_lib/api';

interface Entry {
  virtualPath: string;
  isDirectory: boolean;
  sizeBytes: number;
}

interface ListResponse {
  path: string;
  entries: Entry[];
}

const ROOT = '/memories';

export default function MemoryPage(): React.ReactElement {
  const [cwd, setCwd] = useState<string>(ROOT);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [listError, setListError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [backend, setBackend] = useState<MemoryBackend | null>(null);

  const loadDir = useCallback(async (path: string): Promise<void> => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await fetch(
        `/bot-api/dev/memory/list?path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) {
        const contentType = res.headers.get('content-type') ?? '';
        const body = await res.text().catch(() => '');
        const looksHtml =
          contentType.includes('text/html') ||
          body.trimStart().toLowerCase().startsWith('<!doctype');
        if (res.status === 500 && looksHtml) {
          setListError(
            'Middleware nicht erreichbar (localhost:3979). Läuft `npm run dev` im middleware-Ordner?',
          );
        } else if (res.status === 404) {
          setListError(
            'Dev-Memory-Endpoint nicht verfügbar. Setze DEV_ENDPOINTS_ENABLED=true in middleware/.env und starte die Middleware neu.',
          );
        } else {
          setListError(
            body && !looksHtml ? body : `List fehlgeschlagen (HTTP ${String(res.status)})`,
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
  }, []);

  const loadFile = useCallback(async (path: string): Promise<void> => {
    setLoadingFile(true);
    setFileError(null);
    try {
      const res = await fetch(
        `/bot-api/dev/memory/file?path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) {
        setFileError(`File fehlgeschlagen (HTTP ${String(res.status)})`);
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
  }, []);

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
                {backend === 'postgres' ? 'Postgres' : 'In-Memory · flüchtig'}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-[color:var(--fg-muted)]">
            Live-Browser des aktiven Memory-Stores
            {backend === 'inmemory'
              ? ' (RAM, beim Neustart leer).'
              : backend === 'postgres'
                ? ' (persistent in Postgres).'
                : '.'}
          </p>
        </div>
        <div className="border-b border-[color:var(--border)] px-3 py-2 text-xs">
          <div className="mb-1 text-[color:var(--fg-muted)]">Pfad</div>
          <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-1">
                {i > 0 && <span className="text-[color:var(--fg-subtle)]">/</span>}
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
          <button
            type="button"
            onClick={() => void loadDir(cwd)}
            className="mt-2 text-[11px] text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
          >
            ↻ neu laden
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {parent !== null && (
            <button
              type="button"
              onClick={() => setCwd(parent)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)]"
            >
              ← ..
            </button>
          )}
          {loadingList && (
            <div className="px-3 py-2 text-xs text-[color:var(--fg-muted)]">lädt…</div>
          )}
          {listError && (
            <div className="border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
              {listError}
            </div>
          )}
          {!loadingList && !listError && entries.length === 0 && (
            <div className="px-3 py-2 text-xs text-[color:var(--fg-muted)]">leer</div>
          )}
          {entries.map((e) => {
            const name = basename(e.virtualPath);
            const activeFile = selected === e.virtualPath;
            return (
              <button
                key={e.virtualPath}
                type="button"
                onClick={() => {
                  if (e.isDirectory) {
                    setCwd(e.virtualPath);
                    setSelected(null);
                  } else {
                    setSelected(e.virtualPath);
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
        {selected === null ? (
          <div className="flex h-full items-center justify-center text-sm text-[color:var(--fg-muted)]">
            Eintrag links wählen…
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-2 text-xs">
              <span className="font-mono text-[color:var(--fg-muted)]">
                {selected}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadFile(selected)}
                  className="px-2 py-0.5"
                >
                  ↻
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
              {loadingFile && (
                <div className="text-xs text-[color:var(--fg-muted)]">lädt…</div>
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
          </>
        )}
      </section>
    </main>
  );
}

function cwdToCrumbs(cwd: string): Array<{ path: string; label: string }> {
  if (cwd === ROOT) return [{ path: ROOT, label: 'memories' }];
  const segments = cwd.replace(/^\/+/, '').split('/');
  const crumbs: Array<{ path: string; label: string }> = [];
  let acc = '';
  for (const seg of segments) {
    acc += `/${seg}`;
    crumbs.push({
      path: acc,
      label: seg === 'memories' ? 'memories' : seg,
    });
  }
  return crumbs;
}

function parentOf(cwd: string): string | null {
  if (cwd === ROOT) return null;
  const idx = cwd.lastIndexOf('/');
  if (idx <= 0) return ROOT;
  return cwd.slice(0, idx) || ROOT;
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
