import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from '../Markdown';

/**
 * Privacy Shield v4 — the violet highlight of boundary-protected values.
 * `highlightTerms` are the real values the server resolved that the LLM
 * never saw; every occurrence is wrapped in a violet `<span>`.
 */
describe('<Markdown /> — Privacy Shield v4 highlight', () => {
  it('wraps a highlightTerm occurrence in a violet span', () => {
    const { container } = render(
      <Markdown
        source={'| Name | Days |\n| --- | --- |\n| Marvin Vomberg | 24 |'}
        highlightTerms={['Marvin Vomberg']}
      />,
    );
    const hit = container.querySelector('span.bg-violet-100');
    expect(hit).not.toBeNull();
    expect(hit?.textContent).toBe('Marvin Vomberg');
  });

  it('does not highlight anything when no terms are given', () => {
    const { container } = render(
      <Markdown source={'Marvin Vomberg steht hier.'} />,
    );
    expect(container.querySelector('span.bg-violet-100')).toBeNull();
    expect(container.textContent).toContain('Marvin Vomberg steht hier.');
  });

  it('highlights every occurrence and leaves surrounding text intact', () => {
    const { container } = render(
      <Markdown
        source={'Anna Rüsche und Anna Rüsche, aber nicht Bob.'}
        highlightTerms={['Anna Rüsche']}
      />,
    );
    expect(container.querySelectorAll('span.bg-violet-100').length).toBe(2);
    expect(container.textContent).toContain('aber nicht Bob.');
  });

  it('ignores empty / whitespace-only terms', () => {
    const { container } = render(
      <Markdown source={'Some answer text.'} highlightTerms={['', '  ']} />,
    );
    expect(container.querySelector('span.bg-violet-100')).toBeNull();
  });
});
