import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import EmbeddingProviderPage from '../page';

/**
 * Coverage for /admin/embedding-provider:
 *   - renders the live state (active provider, model, gate, corpus),
 *   - refuses to switch until the destructive-discard confirmation is ticked,
 *   - renders the post-migration gate reason as in-progress INFORMATION rather
 *     than as an error — `vector-columns-migrated` arrives WITH
 *     `vectorWritesAllowed: true` and means "the corpus is being re-earned".
 */

const { mockGetEmbeddingProvider, mockSwitchEmbeddingProvider } = vi.hoisted(() => ({
  mockGetEmbeddingProvider: vi.fn(),
  mockSwitchEmbeddingProvider: vi.fn(),
}));

vi.mock('../../../_lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public body = '',
    ) {
      super(message);
    }
  },
  getEmbeddingProvider: mockGetEmbeddingProvider,
  switchEmbeddingProvider: mockSwitchEmbeddingProvider,
}));

const OLLAMA = '@omadia/embeddings';
const OPENAI = '@omadia/embedding-adapter-openai';

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    providers: [
      {
        pluginId: OLLAMA,
        label: 'Embeddings (Ollama)',
        active: true,
        registryStatus: 'active',
        modelId: 'nomic-embed-text',
        dimensions: 768,
        preview: null,
      },
      {
        pluginId: OPENAI,
        label: 'Embeddings (OpenAI-compatible)',
        active: false,
        registryStatus: 'inactive',
        modelId: 'text-embedding-3-small',
        dimensions: 1536,
        preview: { widthChange: true, vectorsToDiscard: 1234 },
      },
    ],
    activeProviderId: OLLAMA,
    activeModel: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
    capabilityPublished: true,
    corpus: { modelId: 'ollama:nomic-embed-text', dimensions: 768, clearPending: false },
    columns: [
      {
        table: 'graph_nodes',
        column: 'embedding',
        declaredDimensions: 768,
        storedVectors: 1234,
      },
    ],
    columnDimensions: 768,
    storedVectorTotal: 1234,
    gate: {
      vectorWritesAllowed: true,
      status: 'match',
      activeModelId: 'ollama:nomic-embed-text (768d)',
    },
    autoMigrateVectorColumns: true,
    knowledgeGraphInstalled: true,
    graphAvailable: true,
    corpusError: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockGetEmbeddingProvider.mockResolvedValue(baseState());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<EmbeddingProviderPage />', () => {
  it('renders the active provider, its model and the live gate verdict', async () => {
    renderWithIntl(<EmbeddingProviderPage />);

    expect(await screen.findByText(OLLAMA)).toBeTruthy();
    // Twice on purpose: the model the ACTIVE provider reports, and the model
    // the stored corpus was recorded with. Divergence between the two is the
    // whole reason this page exists.
    expect(screen.getAllByText('ollama:nomic-embed-text')).toHaveLength(2);
    expect(screen.getAllByText('768d').length).toBeGreaterThan(0);
    // Gate verdict, read live rather than captured at boot.
    expect(screen.getByText('match')).toBeTruthy();
    expect(screen.getByText('allowed')).toBeTruthy();
    // Governed column + stored corpus size.
    expect(screen.getByText(/graph_nodes\.embedding/)).toBeTruthy();
  });

  it('keeps the switch disabled until the discard confirmation is ticked', async () => {
    const user = userEvent.setup();
    renderWithIntl(<EmbeddingProviderPage />);

    const button = await screen.findByRole('button', { name: 'Switch provider' });
    // No target selected yet.
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('radio', { name: /OpenAI-compatible/ }));

    // Target selected, but the destructive cost has not been acknowledged.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // The cost is stated plainly: how many vectors, and that it costs money.
    expect(
      screen.getByText('1,234 stored vectors will be discarded and re-embedded.'),
    ).toBeTruthy();
    expect(
      screen.getByText(/Against a paid API that costs real money/),
    ).toBeTruthy();
    // …and the width change is called out on the option itself.
    expect(screen.getByText('changes the column width (768d → 1536d)')).toBeTruthy();

    await user.click(screen.getByRole('checkbox'));
    expect((button as HTMLButtonElement).disabled).toBe(false);

    mockSwitchEmbeddingProvider.mockResolvedValue({
      ...baseState(),
      ok: true,
      switchedTo: OPENAI,
    });
    await user.click(button);

    await waitFor(() =>
      expect(mockSwitchEmbeddingProvider).toHaveBeenCalledWith(OPENAI, true),
    );
  });

  it('never calls the switch endpoint without a confirmation', async () => {
    const user = userEvent.setup();
    renderWithIntl(<EmbeddingProviderPage />);

    await user.click(await screen.findByRole('radio', { name: /OpenAI-compatible/ }));
    await user.click(screen.getByRole('button', { name: 'Switch provider' }));

    expect(mockSwitchEmbeddingProvider).not.toHaveBeenCalled();
  });

  it('renders vector-columns-migrated as in-progress information, not as an error', async () => {
    mockGetEmbeddingProvider.mockResolvedValue(
      baseState({
        gate: {
          // Arrives WITH writes allowed. Rendering it red would tell the
          // operator something is broken when nothing is.
          vectorWritesAllowed: true,
          status: 'column-migrated',
          reason: 'vector-columns-migrated',
          activeModelId: 'openai:text-embedding-3-small (1536d)',
          detail:
            'graph_nodes.embedding vector(768)→vector(1536) were rewritten at runtime',
        },
      }),
    );

    renderWithIntl(<EmbeddingProviderPage />);

    const note = await screen.findByText(/This is not an error/);
    expect(note).toBeTruthy();
    expect(screen.getByText('allowed')).toBeTruthy();
    // The panel is toned as information (accent), never as danger.
    const panel = note.closest('section');
    expect(panel?.className).toContain('--accent');
    expect(panel?.className).not.toContain('--danger');
  });

  it('surfaces provider drift, in amber, when the registry and the verdict disagree', async () => {
    // Reachable without anything failing: an adapter swapped through the
    // generic plugin-install UI does NOT re-run the dimension gate, so the
    // graph keeps running under a verdict about a model nobody is using. Both
    // numbers were already on this page — only the disagreement was silent.
    mockGetEmbeddingProvider.mockResolvedValue(
      baseState({
        providerDrift: {
          activeModelId: 'ollama:nomic-embed-text',
          gateModelId: 'openai:text-embedding-3-small',
        },
      }),
    );

    renderWithIntl(<EmbeddingProviderPage />);

    const banner = await screen.findByText('Provider drift');
    const panel = banner.closest('section');
    // Amber, not red: nothing is broken, but it needs re-gating.
    expect(panel?.className).toContain('--warning');
    expect(panel?.className).not.toContain('--danger');
    expect(
      screen.getByText(/openai:text-embedding-3-small/),
    ).toBeTruthy();
  });

  it('says nothing about drift when the two agree', async () => {
    renderWithIntl(<EmbeddingProviderPage />);

    await screen.findByText(OLLAMA);
    expect(screen.queryByText('Provider drift')).toBeNull();
  });

  it('renders a blocked gate as an error', async () => {
    mockGetEmbeddingProvider.mockResolvedValue(
      baseState({
        gate: {
          vectorWritesAllowed: false,
          status: 'blocked',
          reason: 'column-width-mismatch',
          activeModelId: 'openai:text-embedding-3-small (1536d)',
        },
      }),
    );

    renderWithIntl(<EmbeddingProviderPage />);

    // 'blocked' is both the outcome and the write-state label here, so key
    // off the reason, which is unique.
    const reason = await screen.findByText('column-width-mismatch');
    const panel = reason.closest('section');
    expect(panel?.className).toContain('--danger');
    expect(panel?.className).not.toContain('--accent');
  });
});
