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

  it('exposes the scroll container as a focusable group with an i18n aria-label', () => {
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
