'use client';

import { createContext, useContext, useEffect } from 'react';

/**
 * #1889 — lets a panel of the agent detail tabs report unsaved input, so the
 * tab host can ask before it unmounts the panel (only the active panel is
 * mounted; leaving it throws its local state away).
 *
 * `null` outside a tab host: a panel mounted on its own reports to nobody.
 */
export type ReportUnsaved = (dirty: boolean) => void;

export const UnsavedChangesContext = createContext<ReportUnsaved | null>(null);

/** Report this panel's dirty flag to the enclosing tab host while mounted. */
export function useReportUnsaved(dirty: boolean): void {
  const report = useContext(UnsavedChangesContext);
  useEffect(() => {
    if (report === null) return undefined;
    report(dirty);
    return () => report(false);
  }, [report, dirty]);
}
