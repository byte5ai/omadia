import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import DangerZonePage from '../../admin/danger-zone/page';
import MemoryPage from '../page';

/**
 * Operator surface for the chat-context memory ACL (design #870 §6/§7).
 *
 * The fetch stub answers the OPERATOR endpoint
 * (`/bot-api/v1/operator/memory/contexts/{list,file}`) and nothing else, so a
 * regression back to the dev endpoint fails here as a 404-shaped store miss
 * rather than passing silently. `MemoryContextBrowser.test.tsx` asserts the URL
 * itself; this file exercises the behaviour on top of it.
 *
 * What these tests pin down:
 *   - the memory browser has a CONTEXT dimension, derived from the store's own
 *     `/memories/contexts/<slug>/<axis>/<ctxKey>` layout — not from a registry,
 *     so it can never claim a context tree that does not exist,
 *   - a context key renders as a readable label (KG display name when one
 *     resolves, the verbatim `channelType~safeKey` context key otherwise)
 *     while still
 *     addressing the raw key,
 *   - "Promote…" is offered ONLY for a file inside a context tree, refuses to
 *     submit without a reason, and posts source/target/mode/reason exactly as
 *     the promote service expects,
 *   - the audit tab reads the promotions log for the agent in hand,
 *   - the Danger-Zone selector now documents the context-key semantics, because
 *     the user/team/channel axes gained a scratch footprint.
 *
 * Pollution guard: every test builds its own store fixture and its own fetch
 * stub in `beforeEach`; nothing is shared at module level.
 */

const AGENT = 'de.byte5.agent.hr';
const TEAM_KEY = 'teams~19-abc-thread-tacv2-a1b2c3d4';
const CHANNEL_KEY = 'teams~19-chan-thread-tacv2-c3d4e5f6';
const CHANNEL_ROOT = `/memories/contexts/${AGENT}/channel/${CHANNEL_KEY}`;

// Hoisted with the mocks: the factory below runs while the module graph is
// still being imported, so plain module-level consts would be in the TDZ.
const { LIST_ENDPOINT, FILE_ENDPOINT } = vi.hoisted(() => ({
  LIST_ENDPOINT: '/bot-api/v1/operator/memory/contexts/list',
  FILE_ENDPOINT: '/bot-api/v1/operator/memory/contexts/file',
}));

const {
  MockApiError,
  mockGetMemoryBackend,
  mockListMemoryContextLabels,
  mockListMemoryPromotions,
  mockPromoteMemory,
  mockPreviewMemoryPurge,
  mockPurgeMemory,
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
  mockPromoteMemory: vi.fn(),
  mockPreviewMemoryPurge: vi.fn(),
  mockPurgeMemory: vi.fn(),
}));

vi.mock('@/app/_lib/api', () => ({
  ApiError: MockApiError,
  getMemoryBackend: mockGetMemoryBackend,
  listMemoryContextLabels: mockListMemoryContextLabels,
  listMemoryPromotions: mockListMemoryPromotions,
  promoteMemory: mockPromoteMemory,
  previewMemoryPurge: mockPreviewMemoryPurge,
  purgeMemory: mockPurgeMemory,
  operatorMemoryContextsListUrl: (path: string) =>
    `${LIST_ENDPOINT}?path=${encodeURIComponent(path)}`,
  operatorMemoryContextsFileUrl: (path: string) =>
    `${FILE_ENDPOINT}?path=${encodeURIComponent(path)}`,
}));

/**
 * Directory fixture: path → child names, `+` prefix marks a file.
 *
 * Deliberately contexts-only. `/memories/orchestrators` is NOT in here because
 * the operator endpoint cannot serve it, and a fixture that answered it would
 * hide a page that still asks.
 */
function buildStore(): Record<string, string[]> {
  return {
    '/memories/contexts': [AGENT],
    // The stray file is the one thing in a context tree that is NOT promotable:
    // it sits above any tier, so it names no source context.
    [`/memories/contexts/${AGENT}`]: ['team', 'channel', 'user', '+notes.md'],
    [`/memories/contexts/${AGENT}/team`]: [TEAM_KEY],
    [`/memories/contexts/${AGENT}/channel`]: [CHANNEL_KEY],
    [`/memories/contexts/${AGENT}/user`]: [],
    [`/memories/contexts/${AGENT}/team/${TEAM_KEY}`]: [],
    [CHANNEL_ROOT]: ['+vacation-policy.md'],
  };
}

function installFetch(store: Record<string, string[]>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.searchParams.get('path') ?? '';
      if (url.pathname === FILE_ENDPOINT) {
        return Promise.resolve(
          new Response('# Vacation policy\n', { status: 200 }),
        );
      }
      const children = store[path];
      if (children === undefined) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      // The real endpoint includes the listed directory itself; keep it so the
      // "self" filter stays exercised.
      const entries = [
        { virtualPath: path, isDirectory: true, sizeBytes: 0 },
        ...children.map((name) => ({
          virtualPath: `${path}/${name.replace(/^\+/, '')}`,
          isDirectory: !name.startsWith('+'),
          sizeBytes: name.startsWith('+') ? 128 : 0,
        })),
      ];
      return Promise.resolve(
        new Response(JSON.stringify({ path, entries }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

/** Walk from the tree to a selected file inside the channel context. */
async function selectContextFile(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  // Deliberately NOT anchored on the agent node: once the browser has walked
  // into the agent tier, the slug also appears as a breadcrumb button.
  const channelContext = await screen.findByRole('button', {
    name: /teams~19-chan-thread-tacv2-c3d4e5f6/i,
  });
  await user.click(channelContext);
  const file = await screen.findByRole('button', { name: /vacation-policy\.md/ });
  await user.click(file);
}

describe('memory browser — context dimension', () => {
  beforeEach(() => {
    mockGetMemoryBackend.mockResolvedValue({ current: 'inmemory' });
    mockListMemoryContextLabels.mockRejectedValue(new MockApiError(404, 'nope'));
    mockListMemoryPromotions.mockResolvedValue({ entries: [] });
    mockPromoteMemory.mockReset();
    installFetch(buildStore());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders one branch per context axis and no agent-tier node', async () => {
    renderWithIntl(<MemoryPage />);

    await screen.findByRole('button', { name: AGENT });
    // The agent tier lies outside `/memories/contexts`, which is the only
    // subtree the operator endpoint can read — a node that always errors is
    // worse than an absent one.
    expect(
      screen.queryByRole('button', { name: /agent tier/i }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText('Teams (1)')).toBeInTheDocument();
    expect(await screen.findByText('Channels (1)')).toBeInTheDocument();
    // The empty axis is still shown — "no user context" is information.
    expect(await screen.findByText('Users (0)')).toBeInTheDocument();
  });

  it('falls back to the VERBATIM context key when no display name resolves', async () => {
    renderWithIntl(<MemoryPage />);

    const label = await screen.findByRole('button', {
      name: /teams~19-abc-thread-tacv2-a1b2c3d4/i,
    });
    // The raw key stays addressable via the physical path in the tooltip.
    expect(label).toHaveAttribute(
      'title',
      `/memories/contexts/${AGENT}/team/${TEAM_KEY}`,
    );
  });

  it('uses the KG display name for a context when one resolves', async () => {
    mockListMemoryContextLabels.mockResolvedValue({
      contexts: [{ axis: 'team', ctxKey: TEAM_KEY, displayName: 'byte5 GmbH' }],
    });
    renderWithIntl(<MemoryPage />);

    expect(
      await screen.findByRole('button', { name: 'byte5 GmbH' }),
    ).toBeInTheDocument();
  });

  it('browses into a context tier when its node is selected', async () => {
    const user = userEvent.setup();
    renderWithIntl(<MemoryPage />);

    const channelContext = await screen.findByRole('button', {
      name: /teams~19-chan-thread-tacv2-c3d4e5f6/i,
    });
    await user.click(channelContext);

    expect(
      await screen.findByRole('button', { name: /vacation-policy\.md/ }),
    ).toBeInTheDocument();
  });
});

describe('memory browser — promote', () => {
  beforeEach(() => {
    mockGetMemoryBackend.mockResolvedValue({ current: 'inmemory' });
    mockListMemoryContextLabels.mockRejectedValue(new MockApiError(404, 'nope'));
    mockListMemoryPromotions.mockResolvedValue({ entries: [] });
    mockPromoteMemory.mockReset();
    installFetch(buildStore());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('offers Promote only for a file inside a context tree', async () => {
    const user = userEvent.setup();
    renderWithIntl(<MemoryPage />);

    // A file ABOVE any tier (directly under the agent's contexts root) names no
    // source context, so promoting it would have nothing to promote out of.
    // Walked to via "..", which also pins that going up stays in scope.
    await user.click(
      await screen.findByRole('button', {
        name: /teams~19-chan-thread-tacv2-c3d4e5f6/i,
      }),
    );
    await user.click(await screen.findByRole('button', { name: '← ..' }));
    await user.click(await screen.findByRole('button', { name: '← ..' }));
    await user.click(await screen.findByRole('button', { name: /notes\.md/ }));
    expect(
      screen.queryByRole('button', { name: /promote…/i }),
    ).not.toBeInTheDocument();

    await selectContextFile(user);
    expect(
      await screen.findByRole('button', { name: /promote…/i }),
    ).toBeInTheDocument();
  });

  it('refuses to submit without a reason', async () => {
    const user = userEvent.setup();
    renderWithIntl(<MemoryPage />);
    await selectContextFile(user);
    await user.click(await screen.findByRole('button', { name: /promote…/i }));

    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Promote' });
    expect(submit).toBeDisabled();

    await user.type(
      within(dialog).getByRole('textbox', { name: /reason/i }),
      'Policy applies to the whole team',
    );
    expect(submit).toBeEnabled();
  });

  it('posts source, target, mode and reason, then reports the target path', async () => {
    mockPromoteMemory.mockResolvedValue({
      ts: '2026-08-25T10:00:00.000Z',
      agentSlug: AGENT,
      actor: 'operator@byte5.de',
      mode: 'copy',
      sourcePath: `${CHANNEL_ROOT}/vacation-policy.md`,
      targetPath: `/memories/contexts/${AGENT}/team/${TEAM_KEY}/vacation-policy.md`,
      reason: 'Policy applies to the whole team',
      bytes: 128,
    });
    const user = userEvent.setup();
    renderWithIntl(<MemoryPage />);
    await selectContextFile(user);
    await user.click(await screen.findByRole('button', { name: /promote…/i }));

    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByRole('textbox', { name: /reason/i }),
      'Policy applies to the whole team',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Promote' }));

    await waitFor(() => {
      expect(mockPromoteMemory).toHaveBeenCalledTimes(1);
    });
    expect(mockPromoteMemory).toHaveBeenCalledWith(AGENT, {
      source: {
        axis: 'channel',
        ctxKey: CHANNEL_KEY,
        path: 'vacation-policy.md',
      },
      // Channel sources default to the team tier, pre-filled with the agent's
      // existing team key — the natural channel→team promotion.
      target: { tier: 'team', ctxKey: TEAM_KEY },
      mode: 'copy',
      reason: 'Policy applies to the whole team',
    });
    expect(
      await screen.findByText(
        `Promoted to /memories/contexts/${AGENT}/team/${TEAM_KEY}/vacation-policy.md.`,
      ),
    ).toBeInTheDocument();
  });

  it('surfaces a 403 from the promote route as an authorization error', async () => {
    mockPromoteMemory.mockRejectedValue(new MockApiError(403, 'forbidden'));
    const user = userEvent.setup();
    renderWithIntl(<MemoryPage />);
    await selectContextFile(user);
    await user.click(await screen.findByRole('button', { name: /promote…/i }));

    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByRole('textbox', { name: /reason/i }),
      'because',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Promote' }));

    expect(
      await within(dialog).findByText(/requires operator rights/i),
    ).toBeInTheDocument();
  });
});

describe('memory browser — audit tab', () => {
  beforeEach(() => {
    mockGetMemoryBackend.mockResolvedValue({ current: 'inmemory' });
    mockListMemoryContextLabels.mockRejectedValue(new MockApiError(404, 'nope'));
    installFetch(buildStore());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reads the promotion log of the agent whose context is open', async () => {
    mockListMemoryPromotions.mockResolvedValue({
      entries: [
        {
          ts: '2026-08-25T10:00:00.000Z',
          agentSlug: AGENT,
          actor: 'operator@byte5.de',
          mode: 'move',
          sourcePath: `${CHANNEL_ROOT}/vacation-policy.md`,
          targetPath: `/memories/orchestrators/${AGENT}/vacation-policy.md`,
          reason: 'Applies company-wide',
          bytes: 128,
        },
      ],
    });
    const user = userEvent.setup();
    renderWithIntl(<MemoryPage />);
    await selectContextFile(user);

    await user.click(screen.getByRole('tab', { name: 'Audit' }));

    await waitFor(() => {
      expect(mockListMemoryPromotions).toHaveBeenCalledWith(AGENT, {
        limit: 100,
      });
    });
    expect(await screen.findByText('Applies company-wide')).toBeInTheDocument();
    expect(screen.getByText('operator@byte5.de')).toBeInTheDocument();
  });

  it('explains a middleware without the audit endpoint instead of a raw 404', async () => {
    mockListMemoryPromotions.mockRejectedValue(new MockApiError(404, 'nope'));
    const user = userEvent.setup();
    renderWithIntl(<MemoryPage />);
    await selectContextFile(user);

    await user.click(screen.getByRole('tab', { name: 'Audit' }));

    expect(
      await screen.findByText(/audit endpoint is not available/i),
    ).toBeInTheDocument();
  });
});

describe('danger zone — context-key selector semantics', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('tells the operator the channel-type half is mandatory', async () => {
    // The backend refuses a `~`-less selector with 400 invalid_selector, so the
    // copy must not invite a bare native id. Before the fix it did exactly
    // that, and the bare id it invited silently matched nothing while the
    // response reported the scratch trees as affected.
    const user = userEvent.setup();
    renderWithIntl(<DangerZonePage />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: /axis/i }),
      'channel',
    );

    expect(screen.getByText(/always `channelType~id`/i)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('telegram~-1001234567890 (never a bare id)'),
    ).toBeInTheDocument();
  });
});
