import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { MarkdownTable } from '../MarkdownTable';

/**
 * MarkdownTable wraps the GFM `<table>` in a focusable scroll container.
 * Asserts the wrapper contract: container class, accessibility attrs from
 * the i18n key, and that the inner table receives the className passed by
 * the react-markdown override slot.
 */
describe('<MarkdownTable />', () => {
  it('wraps children in a .md-table-wrap div with the inner table', () => {
    const { container } = renderWithIntl(
      <MarkdownTable>
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );
    const wrap = container.querySelector('div.md-table-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap?.querySelector('table')).not.toBeNull();
  });

  it('omits the scroll-region affordance when the table fits its container', () => {
    // jsdom reports 0 for all scroll/client dims, so the wrapper never
    // overflows: no tab stop, no group role, no aria-label (WCAG 2.1.1).
    const { container } = renderWithIntl(
      <MarkdownTable>
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );
    const wrap = container.querySelector('div.md-table-wrap');
    expect(wrap?.getAttribute('role')).toBeNull();
    expect(wrap?.getAttribute('tabindex')).toBeNull();
    expect(wrap?.getAttribute('aria-label')).toBeNull();
  });

  it('exposes a focusable group with an i18n aria-label when the table overflows', () => {
    // Force horizontal overflow: scrollWidth > clientWidth at mount.
    const proto = window.HTMLElement.prototype;
    const sw = Object.getOwnPropertyDescriptor(proto, 'scrollWidth');
    const cw = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    Object.defineProperty(proto, 'scrollWidth', { configurable: true, value: 200 });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, value: 100 });
    try {
      const { container } = renderWithIntl(
        <MarkdownTable>
          <tbody>
            <tr>
              <td>cell</td>
            </tr>
          </tbody>
        </MarkdownTable>,
      );
      const wrap = container.querySelector('div.md-table-wrap');
      expect(wrap?.getAttribute('role')).toBe('group');
      expect(wrap?.getAttribute('tabindex')).toBe('0');
      expect(wrap?.getAttribute('aria-label')).toBe('Scrollable table');
    } finally {
      if (sw) Object.defineProperty(proto, 'scrollWidth', sw);
      else delete (proto as { scrollWidth?: unknown }).scrollWidth;
      if (cw) Object.defineProperty(proto, 'clientWidth', cw);
      else delete (proto as { clientWidth?: unknown }).clientWidth;
    }
  });

  it('forwards className to the inner <table>', () => {
    const { container } = renderWithIntl(
      <MarkdownTable className="custom-class">
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );
    const table = container.querySelector('table');
    expect(table?.className).toBe('custom-class');
  });
});
