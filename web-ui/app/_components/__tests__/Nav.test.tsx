import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { Nav } from '../Nav';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

/**
 * Regression guard for OM-20/40 — "the PLUGINS and ADMIN dropdowns never open".
 *
 * The reported symptom is at least partly a hover/click race: the dropdown used
 * a single boolean, opened it on `mouseenter` and *toggled* it on `click`. A
 * pointer necessarily enters the button before it clicks it, so by the time the
 * click handler ran the menu was already open and the toggle CLOSED it — the
 * menu flashed shut exactly when the user tried to open it.
 *
 * The fix is a three-state mode (`closed` | `hover` | `pinned`) so hover and
 * click can no longer fight over one flag. These tests pin that contract down.
 */
function openerFor(label: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(label, 'i') });
}

/** The dropdown's own container — hover lives on the wrapper, not the button. */
function wrapperOf(button: HTMLElement): HTMLElement {
  const wrapper = button.parentElement;
  if (!wrapper) throw new Error('dropdown button has no wrapper element');
  return wrapper;
}

function menuVisible(): boolean {
  return screen.queryByRole('menu') !== null;
}

describe('<Nav /> cluster dropdown', () => {
  it('opens on hover', () => {
    renderWithIntl(<Nav />);
    const button = openerFor('plugins');
    expect(menuVisible()).toBe(false);

    fireEvent.mouseEnter(wrapperOf(button));
    expect(menuVisible()).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('stays open when the hovered menu is clicked (click pins, never closes)', () => {
    renderWithIntl(<Nav />);
    const button = openerFor('plugins');

    fireEvent.mouseEnter(wrapperOf(button));
    fireEvent.click(button);

    // The bug: the click observed `open === true` and toggled it back off.
    expect(menuVisible()).toBe(true);
  });

  it('closes on a second click once pinned', () => {
    renderWithIntl(<Nav />);
    const button = openerFor('plugins');

    fireEvent.mouseEnter(wrapperOf(button));
    fireEvent.click(button);
    fireEvent.click(button);

    expect(menuVisible()).toBe(false);
  });

  it('keeps a pinned menu open when the pointer leaves', () => {
    renderWithIntl(<Nav />);
    const button = openerFor('plugins');
    const wrapper = wrapperOf(button);

    fireEvent.mouseEnter(wrapper);
    fireEvent.click(button);
    fireEvent.mouseLeave(wrapper);

    expect(menuVisible()).toBe(true);
  });

  it('closes a hover-opened menu when the pointer leaves', () => {
    vi.useFakeTimers();
    try {
      renderWithIntl(<Nav />);
      const button = openerFor('plugins');
      const wrapper = wrapperOf(button);

      fireEvent.mouseEnter(wrapper);
      fireEvent.mouseLeave(wrapper);

      // A short grace period keeps diagonal cursor travel toward the menu from
      // closing it, so the menu is still up immediately after mouseleave.
      expect(menuVisible()).toBe(true);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(menuVisible()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on Escape', () => {
    renderWithIntl(<Nav />);
    const button = openerFor('plugins');

    fireEvent.mouseEnter(wrapperOf(button));
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(menuVisible()).toBe(false);
  });

  it('closes on an outside mousedown', () => {
    renderWithIntl(<Nav />);
    const button = openerFor('admin');

    fireEvent.mouseEnter(wrapperOf(button));
    fireEvent.click(button);
    fireEvent.mouseDown(document.body);

    expect(menuVisible()).toBe(false);
  });

  it('closes when a child link is clicked', () => {
    renderWithIntl(<Nav />);
    const button = openerFor('plugins');

    fireEvent.mouseEnter(wrapperOf(button));
    fireEvent.click(button);

    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(0);
    fireEvent.click(items[0]!);

    expect(menuVisible()).toBe(false);
  });

  // OM-80 (#998) — LLM access holds the orchestrator↔provider assignment
  // without which no agent runs, yet it had no menu entry. It must be the first
  // child of the ADMIN cluster.
  it('admin cluster lists LLM access first, linking to /admin/providers', () => {
    renderWithIntl(<Nav />);
    const button = openerFor('admin');
    fireEvent.mouseEnter(wrapperOf(button));

    const link = screen.getByRole('menuitem', { name: /llm access/i });
    expect(link.getAttribute('href')).toBe('/admin/providers');

    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toBe(link);
  });

  it('opens on keyboard focus and on Enter (no pointer involved)', () => {
    renderWithIntl(<Nav />);
    const button = openerFor('admin');

    fireEvent.focus(button);
    expect(menuVisible()).toBe(true);

    // Enter on a <button> dispatches a click — which pins the already-open menu
    // rather than closing it.
    fireEvent.click(button);
    expect(menuVisible()).toBe(true);
  });
});
