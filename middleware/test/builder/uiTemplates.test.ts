import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  interpolate,
  resolveExpression,
  renderListCard,
  renderKpiTiles,
  type HtmlFragment,
} from '../../packages/harness-ui-helpers/src/index.js';

function unwrap(frag: HtmlFragment): string {
  return frag.value;
}

describe('interpolate', () => {
  it('resolves a simple ${path}', () => {
    const out = interpolate('${item.title}', { scope: { item: { title: 'Hello' } } });
    assert.equal(out, 'Hello');
  });

  it('html-escapes resolved values (XSS guard)', () => {
    const out = interpolate('${item.title}', {
      scope: { item: { title: '<script>alert(1)</script>' } },
    });
    assert.equal(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('resolves multiple ${path} interpolations in one template', () => {
    const out = interpolate('${item.repo}#${item.number}', {
      scope: { item: { repo: 'byte5/foo', number: 42 } },
    });
    assert.equal(out, 'byte5/foo#42');
  });

  it('passes through literal text between expressions', () => {
    const out = interpolate('PR ${item.id} (${item.state})', {
      scope: { item: { id: 7, state: 'open' } },
    });
    assert.equal(out, 'PR 7 (open)');
  });

  it('resolves nested paths', () => {
    const out = interpolate('${item.repo.full_name}', {
      scope: { item: { repo: { full_name: 'byte5/odoo-bot' } } },
    });
    assert.equal(out, 'byte5/odoo-bot');
  });

  it('returns empty string for missing path segments', () => {
    const out = interpolate('${item.missing.deep}', { scope: { item: {} } });
    assert.equal(out, '');
  });

  it('supports .join("…") on arrays', () => {
    const out = interpolate('${item.labels.join(", ")}', {
      scope: { item: { labels: ['bug', 'urgent'] } },
    });
    assert.equal(out, 'bug, urgent');
  });

  it('supports .toLocaleString() on numbers', () => {
    const out = interpolate('${item.amount.toLocaleString()}', {
      scope: { item: { amount: 1234567 } },
    });
    // Locale-dependent — accept any non-empty digit-bearing string
    assert.ok(/^[\d,. \s]+$/u.test(out), `unexpected localeString: ${out}`);
  });

  it('rejects non-whitelisted function-call syntax silently', () => {
    const out = interpolate('${run(item.id)}', { scope: { item: { id: 1 } } });
    assert.equal(out, '');
  });

  it('rejects bracket-syntax segments silently', () => {
    const out = resolveExpression('item["title"]', { item: { title: 'X' } });
    assert.equal(out, '');
  });

  it('rejects null/undefined intermediates', () => {
    const out = interpolate('${item.x.y}', { scope: { item: { x: null } } });
    assert.equal(out, '');
  });

  it('returns empty for empty template', () => {
    assert.equal(interpolate('', { scope: {} }), '');
  });
});

describe('renderListCard', () => {
  const itemTemplate = {
    title: '${item.title}',
    subtitle: '${item.repo}',
    url: '${item.url}',
  } as const;

  it('renders a list of items with title + subtitle + url', () => {
    const out = unwrap(
      renderListCard({
        items: [
          { title: 'First PR', repo: 'byte5/foo', url: 'https://example.com/1' },
          { title: 'Second PR', repo: 'byte5/bar', url: 'https://example.com/2' },
        ],
        itemTemplate,
      }),
    );
    assert.ok(out.includes('<ul'));
    assert.ok(out.includes('First PR'));
    assert.ok(out.includes('byte5/foo'));
    assert.ok(out.includes('https://example.com/1'));
    assert.ok(out.includes('Second PR'));
  });

  it('renders click-target <a> when url is set', () => {
    const out = unwrap(
      renderListCard({
        items: [{ title: 'X', repo: 'r', url: 'https://example.com' }],
        itemTemplate,
      }),
    );
    assert.ok(out.includes('<a href="https://example.com"'));
    assert.ok(out.includes('rel="noopener noreferrer"'));
  });

  it('renders empty message when items is empty', () => {
    const out = unwrap(
      renderListCard({ items: [], itemTemplate, emptyMessage: 'Nichts da.' }),
    );
    assert.ok(out.includes('Nichts da.'));
    assert.ok(!out.includes('<ul'));
  });

  it('uses default empty message when none provided', () => {
    const out = unwrap(renderListCard({ items: [], itemTemplate }));
    assert.ok(out.includes('Keine Daten.'));
  });

  it('renders error banner when fetchError is set', () => {
    const out = unwrap(
      renderListCard({
        items: [{ title: 'X', repo: 'r' }],
        itemTemplate,
        fetchError: 'connection refused',
      }),
    );
    assert.ok(out.includes('connection refused'));
    assert.ok(out.includes('Daten konnten nicht gelesen werden'));
    assert.ok(!out.includes('<ul'));
  });

  it('html-escapes item values to prevent XSS', () => {
    const out = unwrap(
      renderListCard({
        items: [{ title: '<img src=x onerror=alert(1)>', repo: 'r' }],
        itemTemplate,
      }),
    );
    assert.ok(!out.includes('<img src=x'));
    assert.ok(out.includes('&lt;img'));
  });

  it('handles non-array items gracefully', () => {
    const out = unwrap(
      renderListCard({ items: null as unknown as never[], itemTemplate }),
    );
    assert.ok(out.includes('Keine Daten.'));
  });

  it('auto-unwraps `{ prs: [...] }` wrapper-objects (GitHub-PR-pattern)', () => {
    const out = unwrap(
      renderListCard({
        items: {
          total_count: 1,
          truncated: false,
          prs: [{ title: 'Wrapped PR', repo: 'byte5/foo' }],
        },
        itemTemplate,
      }),
    );
    assert.ok(out.includes('Wrapped PR'));
    assert.ok(out.includes('byte5/foo'));
  });

  it('auto-unwraps preferred keys (items > data > results) when multiple arrays exist', () => {
    const out = unwrap(
      renderListCard({
        items: {
          metadata: [{ title: 'Should NOT render' }],
          items: [{ title: 'Should render' }],
        },
        itemTemplate: { title: 'title' },
      }),
    );
    assert.ok(out.includes('Should render'));
    assert.ok(!out.includes('Should NOT render'));
  });

  it('auto-unwraps falls back to first array-valued property when no preferred key', () => {
    const out = unwrap(
      renderListCard({
        items: { total_count: 2, prs: [{ title: 'X' }, { title: 'Y' }] },
        itemTemplate: { title: 'title' },
      }),
    );
    assert.ok(out.includes('>X<'));
    assert.ok(out.includes('>Y<'));
  });

  it('auto-unwraps prefers array-of-objects over empty metadata-arrays', () => {
    // Live-shape from github-prs plugin's list_all_open_prs:
    // { total_count, returned_count, truncated, applied_query,
    //   org_scope_applied: [],   ← FIRST array, but empty + primitive-typed
    //   prs: [{title, repo, ...}] ← real payload
    // }
    // Without the array-of-objects heuristic, unwrap returned the
    // empty `org_scope_applied` and the dashboard read "Keine Daten".
    const out = unwrap(
      renderListCard({
        items: {
          total_count: 25,
          returned_count: 2,
          truncated: false,
          applied_query: 'is:open is:pr',
          org_scope_applied: [],
          prs: [
            { title: 'First PR', repo: 'byte5/foo' },
            { title: 'Second PR', repo: 'byte5/bar' },
          ],
        },
        itemTemplate: { title: 'title', subtitle: 'repo' },
      }),
    );
    assert.ok(out.includes('First PR'));
    assert.ok(out.includes('byte5/foo'));
    assert.ok(out.includes('Second PR'));
    assert.ok(!out.includes('Keine Daten'));
  });

  it('auto-unwraps prefers array-of-strings only when no array-of-objects exists', () => {
    const out = unwrap(
      renderListCard({
        items: { tags: ['a', 'b'], total: 2 },
        itemTemplate: { title: 'title' },
      }),
    );
    // No array-of-objects → fallback to first array-valued property
    // (tags). Each tag renders as bare item.title → empty (string has
    // no .title property).
    assert.ok(out.includes('<ul'));
  });

  it('auto-promotes bare-identifier item_template values', () => {
    // The agent-frequent mistake: `"title": "title"` instead of
    // `"title": "${item.title}"`. Without auto-promote, every card would
    // render the literal word "title" — caught live in the GitHub-PR-Inbox
    // draft, fixed by the renderer.
    const out = unwrap(
      renderListCard({
        items: [{ title: 'First', repo: 'r1', url: 'https://example.com/a' }],
        itemTemplate: { title: 'title', subtitle: 'repo', url: 'url' },
      }),
    );
    assert.ok(out.includes('First'));
    assert.ok(out.includes('r1'));
    assert.ok(out.includes('https://example.com/a'));
  });

  it('leaves explicit ${item.X}-template values untouched (no double-wrap)', () => {
    const out = unwrap(
      renderListCard({
        items: [{ title: 'Hello' }],
        itemTemplate: { title: '${item.title}' },
      }),
    );
    assert.ok(out.includes('Hello'));
  });

  it('passes through literal text containing non-identifier chars', () => {
    // "PR Inbox" has a space — not a bare identifier. Renders as-is.
    const out = unwrap(
      renderListCard({
        items: [{ x: 1 }],
        itemTemplate: { title: 'PR Inbox' },
      }),
    );
    assert.ok(out.includes('PR Inbox'));
  });
});

describe('renderKpiTiles', () => {
  it('renders 1 tile centred', () => {
    const out = unwrap(renderKpiTiles({ tiles: [{ label: 'Open PRs', value: 7 }] }));
    assert.ok(out.includes('Open PRs'));
    assert.ok(out.includes('>7<'));
    assert.ok(out.includes('flex justify-center'));
  });

  it('renders 2 tiles in 2-column grid', () => {
    const out = unwrap(
      renderKpiTiles({
        tiles: [
          { label: 'A', value: 1 },
          { label: 'B', value: 2 },
        ],
      }),
    );
    assert.ok(out.includes('grid-cols-2'));
  });

  it('renders 4 tiles in responsive grid', () => {
    const out = unwrap(
      renderKpiTiles({
        tiles: [
          { label: 'A', value: 1 },
          { label: 'B', value: 2 },
          { label: 'C', value: 3 },
          { label: 'D', value: 4 },
        ],
      }),
    );
    assert.ok(out.includes('grid-cols-2'));
    assert.ok(out.includes('lg:grid-cols-4'));
  });

  it('renders hint line when provided', () => {
    const out = unwrap(
      renderKpiTiles({
        tiles: [{ label: 'X', value: 42, hint: 'vs. letzte Woche: +12' }],
      }),
    );
    assert.ok(out.includes('vs. letzte Woche: +12'));
  });

  it('renders empty message when tiles is empty', () => {
    const out = unwrap(renderKpiTiles({ tiles: [], emptyMessage: 'Keine KPIs.' }));
    assert.ok(out.includes('Keine KPIs.'));
  });

  it('renders error banner when fetchError is set', () => {
    const out = unwrap(
      renderKpiTiles({
        tiles: [{ label: 'X', value: 1 }],
        fetchError: 'oops',
      }),
    );
    assert.ok(out.includes('oops'));
    assert.ok(out.includes('Daten konnten nicht gelesen werden'));
  });

  it('html-escapes tile values', () => {
    const out = unwrap(
      renderKpiTiles({ tiles: [{ label: 'X', value: '<script>x</script>' }] }),
    );
    assert.ok(!out.includes('<script>x'));
    assert.ok(out.includes('&lt;script&gt;'));
  });
});
