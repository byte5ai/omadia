import { act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import enMessages from '../../../../../messages/en.json';
import { AgentDetailTabs, parseAgentDetailTab } from '../_components/AgentDetailTabs';

/**
 * A deep link with `?tab=` used to break hydration: the server rendered the
 * default tab, the client read the tab from `window.location` while
 * hydrating and rendered another one. The page now reads `?tab=` on the
 * server and passes it as `initialTab`, so both render the same markup.
 */

function Tabs(props: { readonly initialTab?: ReturnType<typeof parseAgentDetailTab> }): React.ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Europe/Berlin">
      <AgentDetailTabs
        {...(props.initialTab ? { initialTab: props.initialTab } : {})}
        panels={{
          identity: () => <p data-testid="panel-identity">identity</p>,
          model: () => <p data-testid="panel-model">model</p>,
          teams: () => <p data-testid="panel-teams">teams</p>,
        }}
      />
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});

async function hydrate(serverTab: ReturnType<typeof parseAgentDetailTab> | undefined, url: string) {
  const html = renderToString(<Tabs {...(serverTab ? { initialTab: serverTab } : {})} />);
  window.history.replaceState(null, '', url);
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  const recoverable = vi.fn();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await act(async () => {
    hydrateRoot(container, <Tabs {...(serverTab ? { initialTab: serverTab } : {})} />, { onRecoverableError: recoverable });
  });
  const hydrationErrors = consoleError.mock.calls.filter((c) => /hydrat/i.test(String(c[0])));
  consoleError.mockRestore();
  return { container, recoverable, hydrationErrors };
}

describe('AgentDetailTabs hydration with ?tab=', () => {
  it('renders the tab it was given while hydrating, not the one in window.location', async () => {
    // What the server rendered is the only thing the first client render may
    // depend on. The URL is read on the server by the page.
    const { container, recoverable, hydrationErrors } = await hydrate(undefined, '/operator/agents/hr?tab=model');
    expect(recoverable).not.toHaveBeenCalled();
    expect(hydrationErrors).toEqual([]);
    expect(container.querySelector('[aria-selected="true"]')?.id).toBe('agent-detail-tab-identity');
  });

  it.each(['teams', 'model', 'identity', 'nope'])('?tab=%s hydrates without a mismatch', async (raw) => {
    const initialTab = parseAgentDetailTab(raw);
    // Server: the page parsed `?tab=` and rendered with it.
    const html = renderToString(<Tabs initialTab={initialTab} />);
    // Client: the same URL is in the address bar while hydrating.
    window.history.replaceState(null, '', `/operator/agents/hr?tab=${raw}`);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      hydrateRoot(container, <Tabs initialTab={initialTab} />, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.filter((c) => /hydrat/i.test(String(c[0])))).toEqual([]);
    consoleError.mockRestore();
    const expected = raw === 'nope' ? 'identity' : raw;
    expect(container.querySelector(`[data-testid="panel-${expected}"]`)).not.toBeNull();
    expect(container.querySelector('[aria-selected="true"]')?.id).toBe(`agent-detail-tab-${expected}`);
  });
});

// The page is a server component: what it calls must not live in a
// 'use client' module, or Next refuses the call at request time (the first
// version of this fix crashed the page that way; the unit tests above could
// not see it).
describe('the page reads ?tab= with a server-callable parser', () => {
  const dir = join(process.cwd(), 'app/operator/agents/[slug]');
  it('imports parseAgentDetailTab from a module without "use client"', () => {
    const page = readFileSync(join(dir, 'page.tsx'), 'utf-8');
    const match = /import \{[^}]*parseAgentDetailTab[^}]*\} from '\.\/_components\/([^']+)'/.exec(page);
    expect(match?.[1]).toBe('agentDetailTab');
    const parser = readFileSync(join(dir, '_components/agentDetailTab.ts'), 'utf-8');
    expect(parser).not.toMatch(/^\s*['"]use client['"]/m);
  });
});
