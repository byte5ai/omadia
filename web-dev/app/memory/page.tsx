'use client';

import { useCallback, useEffect, useState } from 'react';
import { Markdown } from '../_components/Markdown';

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
    void loadDir(cwd);
  }, [cwd, loadDir]);

  useEffect(() => {
    if (selected) void loadFile(selected);
  }, [selected, loadFile]);

  const crumbs = cwdToCrumbs(cwd);
  const parent = parentOf(cwd);
  const isMarkdown = selected?.endsWith('.md') ?? false;

  return (
    <main className="flex h-full">
      <aside className="flex w-80 min-w-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="border-b border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800">
          <div className="mb-1 text-neutral-500">Pfad</div>
          <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-1">
                {i > 0 && <span className="text-neutral-400">/</span>}
                <button
                  type="button"
                  onClick={() => setCwd(c.path)}
                  className="rounded px-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void loadDir(cwd)}
            className="mt-2 text-[11px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ↻ neu laden
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {parent !== null && (
            <button
              type="button"
              onClick={() => setCwd(parent)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              ← ..
            </button>
          )}
          {loadingList && (
            <div className="px-3 py-2 text-xs text-neutral-500">lädt…</div>
          )}
          {listError && (
            <div className="border-l-2 border-red-400 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {listError}
            </div>
          )}
          {!loadingList && !listError && entries.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">leer</div>
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
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs transition',
                  activeFile
                    ? 'bg-neutral-100 dark:bg-neutral-800'
                    : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
                ].join(' ')}
              >
                <span>{e.isDirectory ? '📁' : '📄'}</span>
                <span className="truncate">{name}</span>
                {!e.isDirectory && (
                  <span className="ml-auto text-[10px] text-neutral-400">
                    {formatSize(e.sizeBytes)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-neutral-50 dark:bg-neutral-950">
        {selected === null ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Datei links wählen…
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
              <span className="font-mono text-neutral-600 dark:text-neutral-400">
                {selected}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void loadFile(selected)}
                  className="rounded border border-neutral-300 px-2 py-0.5 hover:border-neutral-400 dark:border-neutral-700"
                >
                  ↻
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
              {loadingFile && (
                <div className="text-xs text-neutral-500">lädt…</div>
              )}
              {fileError && (
                <div className="border-l-2 border-red-400 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  {fileError}
                </div>
              )}
              {!loadingFile && !fileError && isMarkdown && (
                <Markdown source={content} />
              )}
              {!loadingFile && !fileError && !isMarkdown && (
                <pre className="whitespace-pre-wrap font-mono text-xs text-neutral-800 dark:text-neutral-200">
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
