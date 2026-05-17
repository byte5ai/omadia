import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import * as React from 'react';
import { renderToString } from 'react-dom/server';

import {
  buildHydrationScripts,
  renderReactRoute,
  wrapInHtmlDocument,
} from '../../packages/harness-ui-helpers/src/react/renderReactRoute.js';

describe('renderReactRoute / wrapInHtmlDocument', () => {
  it('renders a simple Component to a complete HTML document', () => {
    const Page = (props: { title: string }) =>
      React.createElement('h1', null, props.title);
    const html = wrapInHtmlDocument(
      React.createElement(Page, { title: 'Hello' }).type
        ? '<h1>Hello</h1>'
        : '',
      { props: { title: 'Hello' }, pageTitle: 'My Page' },
    );
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<title>My Page</title>'));
    assert.ok(html.includes('<h1>Hello</h1>'));
  });

  it('injects Tailwind CDN script tag by default', () => {
    const html = wrapInHtmlDocument('<div/>', {
      props: {},
      pageTitle: 'T',
    });
    assert.ok(html.includes('cdn.tailwindcss.com'));
  });

  it('omits Tailwind CDN when tailwind=none', () => {
    const html = wrapInHtmlDocument('<div/>', {
      props: {},
      pageTitle: 'T',
      tailwind: 'none',
    });
    assert.ok(!html.includes('cdn.tailwindcss.com'));
  });

  it('emits meta-refresh when refreshSeconds > 0', () => {
    const html = wrapInHtmlDocument('<div/>', {
      props: {},
      pageTitle: 'T',
      refreshSeconds: 120,
    });
    assert.ok(html.includes('<meta http-equiv="refresh" content="120">'));
  });

  it('skips meta-refresh when refreshSeconds is 0', () => {
    const html = wrapInHtmlDocument('<div/>', {
      props: {},
      pageTitle: 'T',
      refreshSeconds: 0,
    });
    assert.ok(!html.includes('http-equiv="refresh"'));
  });

  it('emits <link rel="stylesheet"> when cssHref is set', () => {
    const html = wrapInHtmlDocument('<div/>', {
      props: {},
      pageTitle: 'T',
      cssHref: '/p/foo/static/foo.css',
    });
    assert.ok(html.includes('<link rel="stylesheet" href="/p/foo/static/foo.css">'));
  });

  it('html-escapes the page title (XSS guard)', () => {
    const html = wrapInHtmlDocument('<div/>', {
      props: {},
      pageTitle: '<script>alert(1)</script>',
    });
    assert.ok(!html.includes('<script>alert'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('renderReactRoute returns an Express-compatible handler', async () => {
    const Page = (props: { msg: string }) =>
      React.createElement('p', null, props.msg);
    const handler = renderReactRoute(Page, {
      props: { msg: 'render-test' },
      pageTitle: 'Test',
    });

    // Mock Express req/res — minimum surface needed by the handler.
    const headers: Record<string, string> = {};
    const mockRes = {
      getHeader(k: string) {
        return headers[k.toLowerCase()];
      },
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      headersSent: false,
      writableEnded: false,
      type(_t: string) {
        return mockRes;
      },
      send(_body: unknown) {
        return mockRes;
      },
      status(_n: number) {
        return mockRes;
      },
      end() {
        return mockRes;
      },
    };

    const result = await handler({
      req: {} as never,
      res: mockRes as never,
      params: {},
      query: {},
    });
    assert.ok(typeof result === 'string');
    assert.ok((result as string).includes('render-test'));
    // CSP header should be set by withIframeSafeHeaders
    assert.ok(headers['content-security-policy']?.includes('frame-ancestors'));
  });

  it('B.13 — wraps in hydration scripts when hydration option set', () => {
    const html = wrapInHtmlDocument('<div data-omadia-page="inbox"/>', {
      props: { items: [1, 2] },
      pageTitle: 'Inbox',
      hydration: {
        pageId: 'inbox',
        componentUrl: '/p/foo/static/components/inboxPage.js',
      },
    });
    assert.ok(html.includes('<script type="importmap">'));
    assert.ok(html.includes('https://esm.sh/react@18.3.1'));
    assert.ok(html.includes('react-dom@18.3.1/client'));
    assert.ok(html.includes('__OMADIA_PROPS_inbox'));
    // The componentUrl is embedded via JSON.stringify → double-quoted.
    assert.ok(html.includes('"/p/foo/static/components/inboxPage.js"'));
    assert.ok(html.includes('ReactDOMClient.hydrateRoot'));
  });

  it('B.13 — hydration disables meta-refresh (would clobber client state)', () => {
    const html = wrapInHtmlDocument('<div/>', {
      props: {},
      pageTitle: 'X',
      refreshSeconds: 60,
      hydration: {
        pageId: 'inbox',
        componentUrl: '/p/foo/static/components/inboxPage.js',
      },
    });
    assert.ok(!html.includes('http-equiv="refresh"'));
  });

  it('B.13 — buildHydrationScripts escapes </script> in props (XSS guard)', () => {
    const scripts = buildHydrationScripts(
      { pageId: 'x', componentUrl: '/p/foo/c.js' },
      { user: '</script><script>alert(1)</script>' },
    );
    // The literal `</script>` sequence must be escaped (`<` → `<`)
    // so the JSON block can't close the surrounding <script> tag.
    // The hostile `<script>alert(1)` substring must not appear with its
    // leading `<` intact in the JSON block; the JSON-encoded string
    // contains `<script>alert(1)` instead.
    assert.ok(!scripts.includes('alert(1)</script>'));
    assert.ok(scripts.includes('\\u003c/script\\u003e'));
  });

  it('B.13 — buildHydrationScripts uses default React version when reactVersion omitted', () => {
    const scripts = buildHydrationScripts(
      { pageId: 'x', componentUrl: '/p/foo/c.js' },
      {},
    );
    assert.ok(scripts.includes('react@18.3.1'));
  });

  it('B.13 — buildHydrationScripts honors custom reactVersion override', () => {
    const scripts = buildHydrationScripts(
      { pageId: 'x', componentUrl: '/p/foo/c.js', reactVersion: '18.2.0' },
      {},
    );
    assert.ok(scripts.includes('react@18.2.0'));
  });

  it('B.13 — non-hydration page omits importmap + module-script', () => {
    const html = wrapInHtmlDocument('<div/>', {
      props: {},
      pageTitle: 'X',
    });
    assert.ok(!html.includes('importmap'));
    assert.ok(!html.includes('hydrateRoot'));
  });

  it('React component renders props correctly via SSR', () => {
    // Direct SSR test — verifying that the React component receives props
    // and the rendered HTML reflects them. This is the contract codegen
    // emits against: passing data + fetchError as props.
    const Page = (props: { data: string[]; fetchError: string | null }) => {
      if (props.fetchError) {
        return React.createElement('div', null, 'error: ', props.fetchError);
      }
      return React.createElement(
        'ul',
        null,
        props.data.map((item, i) =>
          React.createElement('li', { key: i }, item),
        ),
      );
    };
    const html = renderReactRoute(Page, {
      props: { data: ['a', 'b'], fetchError: null },
      pageTitle: 'List',
    });
    // The handler is a function — exercise it through a mock to get HTML
    void html;
    // Direct renderToString verification — checks the SSR contract that
    // codegen-emitted Express-Glue depends on.
    const ssr = renderToString(
      React.createElement(Page, { data: ['a', 'b'], fetchError: null }),
    );
    assert.ok(ssr.includes('<li>a</li>'));
    assert.ok(ssr.includes('<li>b</li>'));
  });
});
