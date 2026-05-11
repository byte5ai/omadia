'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Globe } from 'lucide-react';

import { cn } from '../../_lib/cn';

interface AdminUiCtx {
  open: boolean;
  toggle: () => void;
  panelId: string;
}

const Ctx = createContext<AdminUiCtx | null>(null);

export function AdminUiProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const value: AdminUiCtx = {
    open,
    toggle: () => setOpen((v) => !v),
    panelId: 'plugin-admin-ui',
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useAdminUi(): AdminUiCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useAdminUi must be used inside <AdminUiProvider>');
  }
  return ctx;
}

export function AdminUiToggle(): React.ReactElement {
  const { open, toggle, panelId } = useAdminUi();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      aria-controls={panelId}
      className={cn(
        'inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-2',
        'text-[12px] font-semibold uppercase tracking-[0.18em]',
        'border transition-colors',
        open
          ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-white hover:bg-[color:var(--accent)]/90'
          : 'border-[color:var(--rule-strong)] bg-[color:var(--paper)] text-[color:var(--ink)] hover:bg-[color:var(--bg-soft)]',
      )}
    >
      <Globe className="size-3.5" aria-hidden />
      Admin-UI
    </button>
  );
}

/**
 * Wraps the article's normal sections. While the Admin-UI toggle is **off**
 * (default), it transparently renders the children — no DOM wrapper, so
 * the parent's `space-y-*` keeps working. While **on**, it replaces the
 * entire main column with the plugin-bundled admin iframe.
 */
export function AdminUiArticleSwap({
  iframeSrc,
  pluginName,
  children,
}: {
  iframeSrc: string | null;
  pluginName: string;
  children: React.ReactNode;
}): React.ReactElement {
  const { open, panelId } = useAdminUi();
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [open]);

  if (!iframeSrc || !open) return <>{children}</>;

  return (
    <section id={panelId} ref={ref} className="scroll-mt-10">
      <header className="mb-4 flex items-center gap-3 border-b border-[color:var(--divider)] pb-2">
        <span className="font-mono-num text-[12px] font-semibold text-[color:var(--accent)]">
          VI
        </span>
        <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-muted)]">
          <Globe className="size-4" aria-hidden />
          Admin
        </span>
        <span className="h-px flex-1 bg-[color:var(--divider)]" />
        <span className="font-mono-num text-[11px] text-[color:var(--fg-subtle)]">
          {iframeSrc}
        </span>
      </header>
      <iframe
        src={iframeSrc}
        title={`${pluginName} Admin UI`}
        className="h-[1000px] w-full rounded border border-[color:var(--rule)] bg-[color:var(--bg)]"
        loading="lazy"
      />
    </section>
  );
}
