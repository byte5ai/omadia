import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolves to the mock below — the page and this file must throw the SAME
// class, or `err instanceof ApiError` in `errorCodeOf` silently never matches
// and every mapped error would fall through to the raw-message branch.
import { ApiError } from '../../../_lib/api';
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

const {
  mockGetEmbeddingProvider,
  mockSwitchEmbeddingProvider,
  mockGetLocalEmbeddingModel,
  mockStartLocalEmbeddingModelFetch,
  mockReactivateEmbeddingProvider,
} = vi.hoisted(() => ({
  mockGetEmbeddingProvider: vi.fn(),
  mockSwitchEmbeddingProvider: vi.fn(),
  mockGetLocalEmbeddingModel: vi.fn(),
  mockStartLocalEmbeddingModelFetch: vi.fn(),
  mockReactivateEmbeddingProvider: vi.fn(),
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
  getLocalEmbeddingModel: mockGetLocalEmbeddingModel,
  startLocalEmbeddingModelFetch: mockStartLocalEmbeddingModelFetch,
  reactivateEmbeddingProvider: mockReactivateEmbeddingProvider,
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

/** The default for every existing case: no keyless adapter active, which is
 *  what a keyed deployment looks like and must render nothing. */
beforeEach(() => {
  mockGetLocalEmbeddingModel.mockResolvedValue(null);
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

/**
 * OM-84 follow-up — the keyless embedder's weights are not bundled, so until
 * they are fetched the adapter publishes nothing. Printing a shell command at
 * a desktop user with no terminal in the flow is the same as telling them no,
 * so the page drives the download.
 */
describe('keyless embedder — weight download', () => {
  const LOCAL_MODEL = {
    modelDir: '/var/embedding-models',
    missingFiles: ['onnx/model_quantized.onnx'],
    totalBytes: 135_392_208,
    job: {
      state: 'idle' as const,
      downloadedBytes: 0,
      totalBytes: 135_392_208,
      currentFile: null,
      error: null,
    },
  };

  it('renders nothing when no keyless adapter is active', async () => {
    mockGetLocalEmbeddingModel.mockResolvedValue(null);

    renderWithIntl(<EmbeddingProviderPage />);
    // Same render signal the other cases use: the plugin id, which appears
    // verbatim in the current-state list.
    await screen.findByText(OLLAMA);

    // A keyed deployment must not be shown a card about a provider it does not
    // have — the 404 is a fact about the install, not a failure.
    expect(screen.queryByTestId('local-model-card')).toBeNull();
    expect(screen.queryByTestId('local-model-ready')).toBeNull();
  });

  it('offers the download with its size and location when weights are missing', async () => {
    mockGetLocalEmbeddingModel.mockResolvedValue(LOCAL_MODEL);

    renderWithIntl(<EmbeddingProviderPage />);

    const card = await screen.findByTestId('local-model-card');
    // The size has to be stated BEFORE the click: 135 MB on a metered
    // connection is a decision, not a detail.
    expect(card.textContent).toContain('129');
    expect(card.textContent).toContain('/var/embedding-models');
    expect(screen.getByTestId('local-model-fetch')).toBeTruthy();
  });

  it('names the dedup threshold, which nobody would otherwise notice', async () => {
    mockGetLocalEmbeddingModel.mockResolvedValue(LOCAL_MODEL);

    renderWithIntl(<EmbeddingProviderPage />);

    // At the knowledge-graph default of 0.90 this model's dedup never fires,
    // silently — the same failure class OM-84 was about.
    const card = await screen.findByTestId('local-model-card');
    expect(card.textContent).toContain('0.45');
    expect(card.textContent).toContain('0.90');
  });

  it('starts the download on click and shows progress instead of the button', async () => {
    mockGetLocalEmbeddingModel.mockResolvedValue(LOCAL_MODEL);
    mockStartLocalEmbeddingModelFetch.mockResolvedValue({
      ok: true,
      started: true,
      ...LOCAL_MODEL,
      job: { ...LOCAL_MODEL.job, state: 'running', currentFile: 'onnx/model_quantized.onnx' },
    });

    renderWithIntl(<EmbeddingProviderPage />);
    await userEvent.click(await screen.findByTestId('local-model-fetch'));

    await waitFor(() => {
      expect(screen.getByTestId('local-model-progress')).toBeTruthy();
    });
    expect(mockStartLocalEmbeddingModelFetch).toHaveBeenCalledTimes(1);
    // The button must go away, or a second click races two downloads through
    // the same .partial paths.
    expect(screen.queryByTestId('local-model-fetch')).toBeNull();
  });

  it('shows a failed download with its message', async () => {
    mockGetLocalEmbeddingModel.mockResolvedValue({
      ...LOCAL_MODEL,
      job: { ...LOCAL_MODEL.job, state: 'failed', error: 'GET … → HTTP 503' },
    });

    renderWithIntl(<EmbeddingProviderPage />);

    const error = await screen.findByTestId('local-model-error');
    expect(error.textContent).toContain('HTTP 503');
    // And a failure must stay retryable rather than dead-ending.
    expect(screen.getByTestId('local-model-fetch')).toBeTruthy();
  });

  it('confirms readiness once the weights are complete', async () => {
    mockGetLocalEmbeddingModel.mockResolvedValue({
      ...LOCAL_MODEL,
      missingFiles: [],
      job: { ...LOCAL_MODEL.job, state: 'done', downloadedBytes: LOCAL_MODEL.totalBytes },
    });

    renderWithIntl(<EmbeddingProviderPage />);

    await screen.findByTestId('local-model-ready');
    expect(screen.queryByTestId('local-model-card')).toBeNull();
  });
});

/**
 * OM-98 / OM-99 — the two dead ends this page used to describe without being
 * able to end, and the box that told everybody to enter an API key.
 *
 * The failure class both belong to: the page was RIGHT about the state and
 * useless about the remedy. A subscription install with 768-wide EMPTY columns
 * and the 384-d keyless adapter read as "missing API key" — for the adapter
 * that exists so nobody needs one — and offered a provider switch to a
 * provider #1053 had already removed at boot.
 */
const LOCAL = '@omadia/embedding-adapter-local';

/** A single-provider install with the keyless adapter and nothing published. */
function keylessState(overrides: Record<string, unknown> = {}) {
  return baseState({
    providers: [
      {
        pluginId: LOCAL,
        label: 'Embeddings (keyless)',
        active: true,
        registryStatus: 'active',
        modelId: 'paraphrase-multilingual-MiniLM-L12-v2',
        dimensions: 384,
        preview: null,
      },
    ],
    activeProviderId: LOCAL,
    activeModel: { modelId: 'local:paraphrase-multilingual-MiniLM-L12-v2', dimensions: 384 },
    capabilityPublished: false,
    ...overrides,
  });
}

describe('capability gap — one box per reason', () => {
  it('tells a keyless install the weights are missing, not the API key', async () => {
    mockGetEmbeddingProvider.mockResolvedValue(
      keylessState({ capabilityGap: 'missing-weights' }),
    );

    renderWithIntl(<EmbeddingProviderPage />);

    const box = await screen.findByTestId('capability-missing');
    expect(box.textContent).toContain('keyless');
    // It may MENTION the API key — to say this adapter needs none. What it may
    // never do is what the old single sentence did: report the absence of one
    // as the fault. The fault is the weights.
    expect(box.textContent).toContain('needs neither an API key');
    expect(box.textContent).toContain('model weights');
    expect(box.textContent).not.toContain('not configured');
  });

  it('keeps the credential wording for a keyed adapter', async () => {
    mockGetEmbeddingProvider.mockResolvedValue(
      keylessState({ capabilityGap: 'missing-credentials' }),
    );

    renderWithIntl(<EmbeddingProviderPage />);

    expect((await screen.findByTestId('capability-missing')).textContent).toContain(
      'API key',
    );
  });

  it('names the stood-down case, which has a different fix entirely', async () => {
    mockGetEmbeddingProvider.mockResolvedValue(
      keylessState({ capabilityGap: 'not-published' }),
    );

    renderWithIntl(<EmbeddingProviderPage />);

    // "A second adapter already holds the capability" — uninstalling it is the
    // remedy, and no amount of credential-entering gets there.
    expect((await screen.findByTestId('capability-missing')).textContent).toContain(
      'second adapter',
    );
  });

  it('falls back to the historical wording when the middleware sends no reason', async () => {
    // Compatibility runs both ways in a desktop install, where the page and
    // the kernel can update separately.
    mockGetEmbeddingProvider.mockResolvedValue(keylessState({ capabilityGap: null }));

    renderWithIntl(<EmbeddingProviderPage />);

    expect((await screen.findByTestId('capability-missing')).textContent).toContain(
      'API key',
    );
  });
});

describe('width collision', () => {
  function collisionState(columnsEmpty: boolean | null) {
    return keylessState({
      capabilityPublished: true,
      storedVectorTotal: columnsEmpty === true ? 0 : 1234,
      gate: {
        vectorWritesAllowed: false,
        status: 'blocked',
        reason: 'column-width-mismatch',
        activeModelId: 'local:paraphrase-multilingual-MiniLM-L12-v2 (384d)',
      },
      widthCollision: {
        providerDimensions: 384,
        columnDimensions: 768,
        columnsEmpty,
      },
    });
  }

  it('offers the rebuild, in amber, when the columns are empty', async () => {
    mockGetEmbeddingProvider.mockResolvedValue(collisionState(true));

    renderWithIntl(<EmbeddingProviderPage />);

    const box = await screen.findByTestId('width-collision');
    // Amber, not red: nothing is lost and the fix is one click away.
    expect(box.className).toContain('--warning');
    expect(box.className).not.toContain('--danger');
    expect(box.textContent).toContain('384');
    expect(box.textContent).toContain('768');
    expect(screen.getByTestId('reactivate-provider')).toBeTruthy();
  });

  it('withholds the button, in red, while the columns hold vectors', async () => {
    mockGetEmbeddingProvider.mockResolvedValue(collisionState(false));

    renderWithIntl(<EmbeddingProviderPage />);

    const box = await screen.findByTestId('width-collision');
    expect(box.className).toContain('--danger');
    // Offering a one-click rebuild the middleware then refuses with a 409 is
    // worse than not offering it: it reads as a bug rather than as a guard.
    expect(screen.queryByTestId('reactivate-provider')).toBeNull();
    expect(box.textContent).toContain('provider switch');
  });

  it('withholds the button when emptiness could not be established', async () => {
    // Fails closed for the same reason the gate does — "cannot tell" is not
    // "probably empty".
    mockGetEmbeddingProvider.mockResolvedValue(collisionState(null));

    renderWithIntl(<EmbeddingProviderPage />);

    const box = await screen.findByTestId('width-collision');
    expect(box.textContent).toContain('could not be established');
    expect(screen.queryByTestId('reactivate-provider')).toBeNull();
  });

  it('says nothing when the gate is blocked for another reason', async () => {
    mockGetEmbeddingProvider.mockResolvedValue(
      baseState({
        gate: {
          vectorWritesAllowed: false,
          status: 'blocked',
          reason: 'dimension-mismatch',
          activeModelId: 'ollama:nomic-embed-text (768d)',
        },
      }),
    );

    renderWithIntl(<EmbeddingProviderPage />);

    await screen.findByText('dimension-mismatch');
    expect(screen.queryByTestId('width-collision')).toBeNull();
  });
});

describe('reactivate — result and failure', () => {
  const READY_WEIGHTS = {
    modelDir: '/var/embedding-models',
    missingFiles: [] as string[],
    totalBytes: 135_392_208,
    job: {
      state: 'done' as const,
      downloadedBytes: 135_392_208,
      totalBytes: 135_392_208,
      currentFile: null,
      error: null,
    },
  };

  /** Weights on disk, adapter still publishing nothing — the button's home. */
  const UNPUBLISHED = (): Record<string, unknown> =>
    keylessState({ capabilityGap: 'not-published' });

  beforeEach(() => {
    mockGetLocalEmbeddingModel.mockResolvedValue(READY_WEIGHTS);
    mockGetEmbeddingProvider.mockResolvedValue(UNPUBLISHED());
  });

  it('reports a reactivation that published the client', async () => {
    mockReactivateEmbeddingProvider.mockResolvedValue({
      ...UNPUBLISHED(),
      capabilityPublished: true,
      dedupThreshold: null,
    });

    renderWithIntl(<EmbeddingProviderPage />);
    await userEvent.click(await screen.findByTestId('reactivate-provider'));

    const result = await screen.findByTestId('reactivate-result');
    expect(result.textContent).toContain('Provider reactivated');
    expect(mockReactivateEmbeddingProvider).toHaveBeenCalledTimes(1);
  });

  it('reports a reactivation that published nothing, rather than claiming success', async () => {
    mockReactivateEmbeddingProvider.mockResolvedValue({
      ...UNPUBLISHED(),
      dedupThreshold: null,
    });

    renderWithIntl(<EmbeddingProviderPage />);
    await userEvent.click(await screen.findByTestId('reactivate-provider'));

    expect((await screen.findByTestId('reactivate-result')).textContent).toContain(
      'still publishes no embedding client',
    );
  });

  it('names the dedup threshold it wrote, and that it needs a restart', async () => {
    // Nobody would otherwise notice: at the knowledge graph's 0.90 default
    // this model's dedup never fires, silently.
    mockReactivateEmbeddingProvider.mockResolvedValue({
      ...UNPUBLISHED(),
      capabilityPublished: true,
      dedupThreshold: { applied: true, value: 0.45, previous: null, reason: 'applied' },
    });

    renderWithIntl(<EmbeddingProviderPage />);
    await userEvent.click(await screen.findByTestId('reactivate-provider'));

    const line = await screen.findByTestId('reactivate-dedup');
    expect(line.textContent).toContain('0.45');
    expect(line.textContent).toContain('next time');
  });

  it('says it left an operator-set threshold alone, and what would have fitted', async () => {
    // A value the operator typed is a decision. Overwriting it silently is the
    // bug; overwriting it loudly is still the bug.
    mockReactivateEmbeddingProvider.mockResolvedValue({
      ...UNPUBLISHED(),
      capabilityPublished: true,
      dedupThreshold: {
        applied: false,
        value: 0.45,
        previous: '0.80',
        reason: 'operator-set',
      },
    });

    renderWithIntl(<EmbeddingProviderPage />);
    await userEvent.click(await screen.findByTestId('reactivate-provider'));

    const line = await screen.findByTestId('reactivate-dedup');
    expect(line.textContent).toContain('0.80');
    expect(line.textContent).toContain('0.45');
  });

  it('translates the corpus-not-empty refusal instead of leaking the raw message', async () => {
    mockReactivateEmbeddingProvider.mockRejectedValue(
      new ApiError(409, 'Conflict', '{"code":"embeddingProvider.corpus_not_empty"}'),
    );

    renderWithIntl(<EmbeddingProviderPage />);
    await userEvent.click(await screen.findByTestId('reactivate-provider'));

    const error = await screen.findByTestId('reactivate-error');
    expect(error.textContent).toContain('never discards anything');
    // A refusal is not a result.
    expect(screen.queryByTestId('reactivate-result')).toBeNull();
  });

  it('translates the concurrent-change refusal', async () => {
    mockReactivateEmbeddingProvider.mockRejectedValue(
      new ApiError(409, 'Conflict', '{"code":"embeddingProvider.switch_in_progress"}'),
    );

    renderWithIntl(<EmbeddingProviderPage />);
    await userEvent.click(await screen.findByTestId('reactivate-provider'));

    expect((await screen.findByTestId('reactivate-error')).textContent).toContain(
      'already running',
    );
  });

  it('falls back to the raw message for an unmapped failure', async () => {
    // A 500 from the route carries a diagnosis the operator needs verbatim.
    // Swallowing it behind a generic sentence is how "check the middleware
    // log" becomes the only thing anybody ever reads.
    mockReactivateEmbeddingProvider.mockRejectedValue(
      new Error('reactivating failed: onnxruntime could not load the model'),
    );

    renderWithIntl(<EmbeddingProviderPage />);
    await userEvent.click(await screen.findByTestId('reactivate-provider'));

    expect((await screen.findByTestId('reactivate-error')).textContent).toContain(
      'onnxruntime',
    );
  });
});
