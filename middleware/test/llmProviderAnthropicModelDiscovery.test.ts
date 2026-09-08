import assert from 'node:assert/strict';
import { test } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import {
  getAnthropicModel,
  listAnthropicModels,
} from '@omadia/llm-adapter-anthropic';

type ModelPayload = Record<string, unknown>;

function model(
  id: string,
  overrides: ModelPayload = {},
): ModelPayload {
  return {
    id,
    display_name: `Label for ${id}`,
    max_input_tokens: 200_000,
    max_tokens: 32_000,
    capabilities: {},
    ...overrides,
  };
}

function mockClient(options: {
  pages?: ModelPayload[][];
  retrieveResult?: ModelPayload;
  onRetrieve?: (id: string) => void;
} = {}): Anthropic {
  const pages = options.pages ?? [];
  return {
    models: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          for (const page of pages) {
            for (const entry of page) {
              yield entry;
            }
          }
        },
      }),
      retrieve: async (id: string) => {
        options.onRetrieve?.(id);
        return options.retrieveResult ?? model(id);
      },
    },
  } as unknown as Anthropic;
}

test('listAnthropicModels drains a two-page models.list() result and preserves model order', async () => {
  const client = mockClient({
    pages: [
      [model('claude-first'), model('claude-second')],
      [model('claude-third')],
    ],
  });

  const discovered = await listAnthropicModels(client);

  assert.deepEqual(
    discovered.map((entry) => entry.modelId),
    ['claude-first', 'claude-second', 'claude-third'],
  );
});

test('listAnthropicModels maps display_name, max_input_tokens, and max_tokens to their public fields', async () => {
  const client = mockClient({
    pages: [[model('claude-mapped', {
      display_name: 'Claude Mapped',
      max_input_tokens: 123_456,
      max_tokens: 7_890,
    })]],
  });

  const [discovered] = await listAnthropicModels(client);

  assert.equal(discovered?.label, 'Claude Mapped');
  assert.equal(discovered?.contextWindow, 123_456);
  assert.equal(discovered?.maxTokens, 7_890);
});

test('listAnthropicModels maps image_input.supported true to vision true and false to vision false', async () => {
  const client = mockClient({
    pages: [[
      model('claude-vision', {
        capabilities: { image_input: { supported: true } },
      }),
      model('claude-text', {
        capabilities: { image_input: { supported: false } },
      }),
    ]],
  });

  const discovered = await listAnthropicModels(client);

  assert.equal(discovered[0]?.vision, true);
  assert.equal(discovered[1]?.vision, false);
});

test('listAnthropicModels filters vendor-reported effort.max from effortLevels', async () => {
  const client = mockClient({
    pages: [[model('claude-effort', {
      capabilities: {
        effort: {
          low: { supported: true },
          medium: { supported: false },
          high: { supported: true },
          xhigh: { supported: true },
          max: { supported: true },
        },
      },
    })]],
  });

  const [discovered] = await listAnthropicModels(client);

  // 'max' is supported by the vendor here but must not survive the
  // intersection with omadia's vocabulary; 'medium' is dropped because the
  // vendor reports it unsupported.
  assert.deepEqual(discovered?.effortLevels, ['low', 'high', 'xhigh']);
});

test('listAnthropicModels maps a missing effort capability to an empty effortLevels array', async () => {
  const client = mockClient({
    pages: [[model('claude-no-effort', {
      capabilities: { image_input: { supported: true } },
    })]],
  });

  const [discovered] = await listAnthropicModels(client);

  assert.deepEqual(discovered?.effortLevels, []);
});

test('listAnthropicModels tolerates absent or malformed capabilities with false vision and empty effortLevels', async () => {
  const absent = model('claude-absent');
  delete absent['capabilities'];
  const client = mockClient({
    pages: [[
      absent,
      model('claude-malformed', {
        capabilities: { image_input: 42, effort: 'unsupported-shape' },
      }),
    ]],
  });

  const discovered = await listAnthropicModels(client);

  assert.deepEqual(
    discovered.map(({ vision, effortLevels }) => ({ vision, effortLevels })),
    [
      { vision: false, effortLevels: [] },
      { vision: false, effortLevels: [] },
    ],
  );
});

test('listAnthropicModels rejects non-numeric max_input_tokens with the offending model id', async () => {
  const client = mockClient({
    pages: [[model('claude-invalid-limit', { max_input_tokens: '200000' })]],
  });

  await assert.rejects(
    listAnthropicModels(client),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /claude-invalid-limit/);
      assert.match(error.message, /max_input_tokens/);
      return true;
    },
  );
});

test('getAnthropicModel retrieves the requested id and applies the same model mapping', async () => {
  let retrievedId: string | undefined;
  const client = mockClient({
    retrieveResult: model('claude-retrieved', {
      display_name: 'Claude Retrieved',
      max_input_tokens: 500_000,
      max_tokens: 64_000,
      capabilities: {
        image_input: { supported: true },
        effort: {
          low: { supported: true },
          max: { supported: true },
        },
      },
    }),
    onRetrieve: (id) => {
      retrievedId = id;
    },
  });

  const discovered = await getAnthropicModel(client, 'claude-retrieved');

  assert.equal(retrievedId, 'claude-retrieved');
  assert.deepEqual(discovered, {
    modelId: 'claude-retrieved',
    label: 'Claude Retrieved',
    contextWindow: 500_000,
    maxTokens: 64_000,
    vision: true,
    effortLevels: ['low'],
  });
});
