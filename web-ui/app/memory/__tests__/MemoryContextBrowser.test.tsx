import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import MemoryPage from '../page';

/**
 * The memory context browser reads the OPERATOR endpoint (epic #860, wave W2a).
 *
 * Why this file exists: the panel used to fetch `/bot-api/dev/memory/{list,file}`
 * — `packages/harness-memory/src/devMemoryRouter.ts`, which the memory plugin
 * mounts only when `dev_memory_endpoints_enabled` resolves truthy, and which the
 * kernel forbids in production. The browser was therefore dead exactly where an
 * operator needs it, and it explained itself with "set DEV_ENDPOINTS_ENABLED",
 * advice no production operator can act on.
 *
 * These tests assert the things a behavioural test on top of a fetch stub cannot:
 * the URL that actually goes out, the SCOPE of the paths it may name, and that
 * the endpoint's auth answers reach the operator as words rather than as a bare
 * status code.
 *
 * The api module is mocked with `importOriginal`, so the URL builders under test
 * are the REAL ones — a stubbed builder would assert nothing about the wire.
 *
 * Pollution guard: every test installs its own fetch stub in `beforeEach`;
 * nothing is shared at module level.
 */

const AGENT = 'de.byte5.agent.hr';
const CHANNEL_KEY = 'teams~19-chan-thread-tacv2-c3d4e5f6';
const CONTEXTS_ROOT = '/memories/contexts';
const CHANNEL_ROOT = `${CONTEXTS_ROOT}/${AGENT}/channel/${CHANNEL_KEY}`;

const LIST_PATH = '/bot-api/v1/operator/memory/contexts/list';
const FILE_PATH = '/bot-api/v1/operator/memory/contexts/file';

const {
  MockApiError,
  mockGetMemoryBackend,
  mockListMemoryContextLabels,
  mockListMemoryPromotions,
} = vi.hoisted(() => ({
  MockApiError: class MockApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public body = '',
    ) {
      super(message);
    }
  },
  mockGetMemoryBackend: vi.fn(),
  mockListMemoryContextLabels: vi.fn(),
  mockListMemoryPromotions: vi.fn(),
}));

vi.mock('@/app/_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/_lib/api')>();
  return {
    ...actual,
    ApiError: MockApiError,
    getMemoryBackend: mockGetMemoryBackend,
    listMemoryContextLabels: mockListMemoryContextLabels,
    listMemoryPromotions: mockListMemoryPromotions,
  };
});

/** Directory fixture: path → child names, `+` prefix marks a file. */
const STORE: Record<string, string[]> = {
  [CONTEXTS_ROOT]: [AGENT],
  [`${CONTEXTS_ROOT}/${AGENT}`]: ['team', 'channel', 'user'],
  [`${CONTEXTS_ROOT}/${AGENT}/team`]: [],
  [`${CONTEXTS_ROOT}/${AGENT}/channel`]: [CHANNEL_KEY],
  [`${CONTEXTS_ROOT}/${AGENT}/user`]: [],
  [CHANNEL_ROOT]: ['+vacation-policy.md'],
};

function listBody(path: string, children: string[]): string {
  return JSON.stringify({
    path,
    // The real endpoint includes the listed directory itself.
    entries: [
      { virtualPath: path, isDirectory: true, sizeBytes: 0 },
      ...children.map((name) => ({
        virtualPath: `${path}/${name.replace(/^\+/, '')}`,
        isDirectory: !name.startsWith('+'),
        sizeBytes: name.startsWith('+') ? 128 : 0,
      })),
    ],
  });
}

type FetchStub = ReturnType<typeof vi.fn>;

/** Serve the fixture; `status` (when given) overrides every answer. */
function installFetch(status?: number): FetchStub {
  const stub = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (status !== undefined) {
      return Promise.resolve(new Response('denied', { status }));
    }
    if (url.pathname === FILE_PATH) {
      return Promise.resolve(new Response('# Vacation policy\n', { status: 200 }));
    }
    const path = url.searchParams.get('path') ?? '';
    const children = STORE[path];
    if (children === undefined) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    return Promise.resolve(
      new Response(listBody(path, children), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

function requestedUrls(stub: FetchStub): URL[] {
  return stub.mock.calls.map(
    (call) => new URL(String(call[0]), 'http://localhost'),
  );
}

describe('memory context browser — operator endpoint', () => {
  beforeEach(() => {
    mockGetMemoryBackend.mockResolvedValue({ current: 'postgres' });
    mockListMemoryContextLabels.mockRejectedValue(new MockApiError(404, 'nope'));
    mockListMemoryPromotions.mockResolvedValue({ entries: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('lists through the operator endpoint and never through the dev one', async () => {
    const stub = installFetch();
    renderWithIntl(<MemoryPage />);

    await screen.findByRole('button', { name: AGENT });

    const urls = requestedUrls(stub);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.pathname === LIST_PATH)).toBe(true);
    // The dev router is unauthenticated and unmounted in production; a
    // regression back to it would make this whole panel dead there again.
    expect(urls.some((u) => u.pathname.startsWith('/bot-api/dev/'))).toBe(false);
  });

  it('never names a path outside /memories/contexts', async () => {
    const stub = installFetch();
    renderWithIntl(<MemoryPage />);

    await screen.findByRole('button', { name: AGENT });

    const paths = requestedUrls(stub).map((u) => u.searchParams.get('path'));
    expect(paths.length).toBeGreaterThan(0);
    // The endpoint rejects anything else with a bare 400. The agent tier
    // (/memories/orchestrators) is the path this page used to walk on boot.
    for (const path of paths) {
      expect(path).toMatch(/^\/memories\/contexts(\/|$)/);
    }
  });

  it('previews a context file through the operator file endpoint', async () => {
    const stub = installFetch();
    const user = userEvent.setup();
    renderWithIntl(<MemoryPage />);

    await user.click(
      await screen.findByRole('button', { name: new RegExp(CHANNEL_KEY, 'i') }),
    );
    await user.click(
      await screen.findByRole('button', { name: /vacation-policy\.md/ }),
    );

    expect(await screen.findByText('Vacation policy')).toBeInTheDocument();
    const fileCalls = requestedUrls(stub).filter(
      (u) => u.pathname === FILE_PATH,
    );
    expect(fileCalls).toHaveLength(1);
    expect(fileCalls[0]?.searchParams.get('path')).toBe(
      `${CHANNEL_ROOT}/vacation-policy.md`,
    );
  });

  it('renders an unauthenticated state when the endpoint answers 401', async () => {
    installFetch(401);
    renderWithIntl(<MemoryPage />);

    // The endpoint is requireAuth-gated, so 401 is an ordinary answer here.
    // Before the switch this read "Listing failed (HTTP 401)", which tells an
    // operator nothing about how to recover.
    expect(await screen.findByText(/not signed in/i)).toBeInTheDocument();
    expect(screen.queryByText(/listing failed/i)).not.toBeInTheDocument();
  });

  it('renders a forbidden state when the endpoint answers 403', async () => {
    installFetch(403);
    renderWithIntl(<MemoryPage />);

    expect(
      await screen.findByText(/requires operator rights/i),
    ).toBeInTheDocument();
  });

  it('shows the tree error rather than an empty tree when the session is stale', async () => {
    installFetch(401);
    renderWithIntl(<MemoryPage />);

    // "No agent memory yet" for an unreachable store would let an operator
    // conclude the context trees do not exist.
    await waitFor(() => {
      expect(
        screen.getByText(/context tree could not be loaded/i),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/no agent memory yet/i)).not.toBeInTheDocument();
  });
});
