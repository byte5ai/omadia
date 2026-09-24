'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

import { signalDesktopUiReady } from '../_lib/desktopShell';

/**
 * Tells the desktop shell that a real screen is standing (OM-71).
 *
 * Mounted once in the root layout. On every ordinary page, hydration of the
 * layout IS the page standing. `/login` and `/setup` are excluded: both render
 * a "Loading login…" shell first and only become a screen once their own
 * provider fetch has settled, so they ping from inside that state change.
 * Renders nothing.
 */
export function DesktopUiReady(): null {
  const pathname = usePathname();
  const selfReporting = pathname === '/login' || pathname === '/setup';

  useEffect(() => {
    if (selfReporting) return;
    signalDesktopUiReady();
  }, [selfReporting]);

  return null;
}
