'use client';

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

/**
 * Shared "flying window" mechanics for the chat-side visualization panes
 * (KG-walk on the right, Plan-DAG on the left). Owns the open/maximize state,
 * the draggable header + resizable corner, the live canvas measurement, and the
 * computed `style`. The two panes differ only in their content + anchor side,
 * so everything geometric lives here to keep each pane focused and well under
 * the file-size budget.
 */

export interface FloatingWindowGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatingWindowOptions {
  /** Which viewport corner the window anchors to on first open. */
  anchor: 'left' | 'right';
  defaultW?: number;
  defaultH?: number;
  minW?: number;
  minH?: number;
  /** px gap kept from each viewport edge. */
  margin?: number;
}

export interface FloatingWindowApi {
  open: boolean;
  maximized: boolean;
  geom: FloatingWindowGeom | null;
  canvas: { w: number; h: number };
  openWindow: () => void;
  close: () => void;
  toggleMaximized: () => void;
  setCanvasRef: (el: HTMLDivElement | null) => void;
  headerHandlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  };
  resizeHandlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  };
  /** CSS box for the `<section>`. Reads `null` until geometry is seeded. */
  style: CSSProperties | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function useFloatingWindow(
  opts: FloatingWindowOptions,
): FloatingWindowApi {
  const {
    anchor,
    defaultW = 560,
    defaultH = 640,
    minW = 360,
    minH = 360,
    margin = 16,
  } = opts;

  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [geom, setGeom] = useState<FloatingWindowGeom | null>(null);
  const [canvas, setCanvas] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  const roRef = useRef<ResizeObserver | null>(null);

  const defaultGeom = useCallback((): FloatingWindowGeom => {
    if (typeof window === 'undefined') {
      return { x: 0, y: 0, w: defaultW, h: defaultH };
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(defaultW, vw - margin * 2);
    const h = Math.min(defaultH, vh - margin * 2);
    const x =
      anchor === 'left'
        ? margin
        : Math.max(margin, vw - w - margin);
    return { x, y: Math.max(margin, vh - h - margin), w, h };
  }, [anchor, defaultW, defaultH, margin]);

  const openWindow = useCallback(() => {
    setGeom((prev) => prev ?? defaultGeom());
    setOpen(true);
  }, [defaultGeom]);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const toggleMaximized = useCallback(() => {
    setMaximized((m) => !m);
  }, []);

  const setCanvasRef = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!el) {
      setCanvas({ w: 0, h: 0 });
      return;
    }
    const measure = (): void => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setCanvas((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
  }, []);

  // --- Drag (header) ------------------------------------------------------
  const dragState = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const onHeaderPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (maximized || !geom) return;
      if ((e.target as HTMLElement).closest('button')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: geom.x,
        originY: geom.y,
      };
    },
    [maximized, geom],
  );

  const onHeaderPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const st = dragState.current;
      if (!st) return;
      setGeom((prev) => {
        if (!prev) return prev;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const nextX = clamp(
          st.originX + (e.clientX - st.startX),
          margin,
          Math.max(margin, vw - prev.w - margin),
        );
        const nextY = clamp(
          st.originY + (e.clientY - st.startY),
          margin,
          Math.max(margin, vh - prev.h - margin),
        );
        return { ...prev, x: nextX, y: nextY };
      });
    },
    [margin],
  );

  const onHeaderPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      dragState.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  // --- Resize (corner handle) ---------------------------------------------
  const resizeState = useRef<{
    startX: number;
    startY: number;
    originW: number;
    originH: number;
  } | null>(null);

  const onResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (maximized || !geom) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      resizeState.current = {
        startX: e.clientX,
        startY: e.clientY,
        originW: geom.w,
        originH: geom.h,
      };
    },
    [maximized, geom],
  );

  const onResizePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const st = resizeState.current;
      if (!st) return;
      setGeom((prev) => {
        if (!prev) return prev;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const maxW = vw - prev.x - margin;
        const maxH = vh - prev.y - margin;
        const nextW = clamp(st.originW + (e.clientX - st.startX), minW, maxW);
        const nextH = clamp(st.originH + (e.clientY - st.startY), minH, maxH);
        return { ...prev, w: nextW, h: nextH };
      });
    },
    [margin, minW, minH],
  );

  const onResizePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      resizeState.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const style: CSSProperties | null = maximized
    ? { left: '5vw', top: '7.5vh', width: '90vw', height: '85vh' }
    : geom
      ? {
          left: geom.x,
          top: geom.y,
          width: geom.w,
          height: geom.h,
          maxWidth: `calc(100vw - ${String(margin * 2)}px)`,
          maxHeight: `calc(100vh - ${String(margin * 2)}px)`,
        }
      : null;

  return {
    open,
    maximized,
    geom,
    canvas,
    openWindow,
    close,
    toggleMaximized,
    setCanvasRef,
    headerHandlers: {
      onPointerDown: onHeaderPointerDown,
      onPointerMove: onHeaderPointerMove,
      onPointerUp: onHeaderPointerUp,
    },
    resizeHandlers: {
      onPointerDown: onResizePointerDown,
      onPointerMove: onResizePointerMove,
      onPointerUp: onResizePointerUp,
    },
    style,
  };
}
