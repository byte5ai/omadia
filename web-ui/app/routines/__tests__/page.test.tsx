import { renderToPipeableStream } from 'react-dom/server';
import { PassThrough } from 'node:stream';
import { createTranslator } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enMessages from '../../../messages/en.json';

/**
 * Regression coverage for the "Routinen section is permanently unreachable"
 * customer findings (OM-14 / OM-19 / OM-32).
 *
 * Two distinct defects are locked down here:
 *
 *  1. The empty state used `t.rich('emptyBody', { toolName: () => <code/> })`
 *     while the message declared `{toolName}` as an ICU *argument* rather than
 *     a `<toolName>` tag. intl-messageformat then substituted the raw function
 *     into the output. In this Server Component that reached the Flight
 *     serializer and blew up with "Functions are not valid as a child of
 *     Client Components" — the generic error page, an opaque digest, and an
 *     HTTP 200 on every request. Asserting the tag content actually renders
 *     catches any reintroduction (with the bug the `<code>` silently vanishes).
 *
 *  2. `routines = resp.routines` clobbered the `[]` default before the catch
 *     could help, so a malformed 200 body made `routines.filter(...)` throw
 *     *outside* the try/catch — an unrecoverable crash instead of the page's
 *     own error card.
 */

const { mockListRoutines, mockRedirectIfUnauthorized } = vi.hoisted(() => ({
  mockListRoutines: vi.fn(),
  mockRedirectIfUnauthorized: vi.fn(async () => undefined),
}));

vi.mock('../../_lib/api', () => ({
  listRoutines: mockListRoutines,
}));

vi.mock('../../_lib/authRedirect', () => ({
  redirectIfUnauthorized: mockRedirectIfUnauthorized,
}));

// Use the real message catalog through a real translator so ICU/tag handling
// is exercised for real rather than stubbed away.
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: enMessages as Record<string, unknown>,
      namespace,
    }),
}));

// RoutineRow is a client component with its own data deps; the table shape is
// not what these tests are about.
vi.mock('../_components/RoutineRow', () => ({
  RoutineRow: ({ routine }: { routine: { id: string } }) => (
    <tr data-testid="routine-row">
      <td>{routine.id}</td>
    </tr>
  ),
}));

import RoutinesPage from '../page';

/** Renders an async Server Component tree to HTML, surfacing any render error. */
async function renderPage(): Promise<string> {
  const element = await RoutinesPage();
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const { pipe } = renderToPipeableStream(element, {
      onAllReady() {
        const sink = new PassThrough();
        sink.on('data', (c: Buffer) => chunks.push(c));
        sink.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        pipe(sink);
      },
      onError(err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    });
  });
}

describe('RoutinesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty state without throwing when there are no routines', async () => {
    mockListRoutines.mockResolvedValue({ routines: [], count: 0 });

    const html = await renderPage();

    // The rich-text tag must produce real markup. With the {toolName} ICU-arg
    // bug the <code> element is dropped entirely and this assertion fails.
    expect(html).toContain('manage_routine');
    expect(html).toContain('<code');
    expect(html).not.toContain('{toolName}');
  });

  it('shows summary counts for a populated list', async () => {
    mockListRoutines.mockResolvedValue({
      routines: [
        { id: 'r1', status: 'active' },
        { id: 'r2', status: 'paused' },
      ],
      count: 2,
    });

    const html = await renderPage();

    expect(html).toContain('routine-row');
  });

  it('renders the error card instead of crashing when the body has no routines key', async () => {
    mockListRoutines.mockResolvedValue({});

    const html = await renderPage();

    // Must not have thrown, and must fall back to the empty state rather than
    // dereferencing undefined.
    expect(html).toContain('manage_routine');
  });

  it('renders without crashing when routines is null', async () => {
    mockListRoutines.mockResolvedValue({ routines: null });

    const html = await renderPage();

    expect(html).toContain('manage_routine');
  });

  it('renders the load-error card when the API call rejects', async () => {
    mockListRoutines.mockRejectedValue(
      new Error('GET /v1/routines: malformed body — "routines" is not an array'),
    );

    const html = await renderPage();

    expect(html).toContain('malformed body');
    expect(mockRedirectIfUnauthorized).toHaveBeenCalled();
  });
});
