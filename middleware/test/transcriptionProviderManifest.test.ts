import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseTranscriptionProviderManifestBlock } from '../src/platform/transcriptionProviderManifest.js';

/** The block the OpenAI adapter's manifest.yaml actually ships. */
const OPENAI_BLOCK = {
  id: 'openai',
  label: 'OpenAI',
  default_base_url: 'https://api.openai.com/v1',
  base_url_config_key: 'base_url',
  policy: {
    requires_avv_disclosure: true,
    eu_hosted: false,
    requires_api_key: true,
  },
  models: [
    {
      id: 'openai:gpt-transcribe',
      model_id: 'gpt-transcribe',
      label: 'GPT Transcribe (Batch)',
      surfaces: ['file'],
    },
  ],
};

describe('parseTranscriptionProviderManifestBlock', () => {
  it('maps a full block to a typed descriptor (snake_case → camelCase)', () => {
    const d = parseTranscriptionProviderManifestBlock(OPENAI_BLOCK);
    assert.equal(d.id, 'openai');
    assert.equal(d.label, 'OpenAI');
    assert.equal(d.baseURL, 'https://api.openai.com/v1');
    assert.equal(d.baseUrlConfigKey, 'base_url');
    assert.deepEqual(d.policy, {
      requiresAvvDisclosure: true,
      euHosted: false,
      requiresApiKey: true,
    });
    assert.equal(d.models.length, 1);
    const m = d.models[0];
    assert.ok(m);
    assert.equal(m.id, 'openai:gpt-transcribe');
    assert.equal(m.provider, 'openai');
    assert.equal(m.modelId, 'gpt-transcribe');
    assert.equal(m.label, 'GPT Transcribe (Batch)');
    assert.deepEqual(m.surfaces, ['file']);
  });

  it('accepts a minimal block without policy and base_url_config_key', () => {
    const d = parseTranscriptionProviderManifestBlock({
      id: 'p',
      label: 'P',
      default_base_url: 'https://p.example/v1',
      models: [
        { id: 'p:m', model_id: 'm', label: 'M', surfaces: ['file', 'stream'] },
      ],
    });
    assert.equal(d.policy, undefined);
    assert.equal(d.baseUrlConfigKey, undefined);
    assert.deepEqual(d.models[0]?.surfaces, ['file', 'stream']);
  });

  it('ignores non-boolean policy fields instead of flipping a default', () => {
    const d = parseTranscriptionProviderManifestBlock({
      ...OPENAI_BLOCK,
      policy: { requires_avv_disclosure: 'yes', eu_hosted: false },
    });
    assert.deepEqual(d.policy, { euHosted: false });
  });

  it('throws on a non-object block', () => {
    assert.throws(() => parseTranscriptionProviderManifestBlock('nope'), /expected an object/);
    assert.throws(() => parseTranscriptionProviderManifestBlock([OPENAI_BLOCK]), /expected an object/);
  });

  for (const key of ['id', 'label', 'default_base_url'] as const) {
    it(`throws when '${key}' is missing or empty`, () => {
      const { [key]: _omitted, ...rest } = OPENAI_BLOCK;
      assert.throws(
        () => parseTranscriptionProviderManifestBlock(rest),
        new RegExp(`'${key}' must be a non-empty string`),
      );
      assert.throws(
        () => parseTranscriptionProviderManifestBlock({ ...OPENAI_BLOCK, [key]: '  ' }),
        new RegExp(`'${key}' must be a non-empty string`),
      );
    });
  }

  it('throws when models is missing, empty, or not an array', () => {
    const { models: _models, ...rest } = OPENAI_BLOCK;
    for (const bad of [rest, { ...OPENAI_BLOCK, models: [] }, { ...OPENAI_BLOCK, models: 'x' }]) {
      assert.throws(
        () => parseTranscriptionProviderManifestBlock(bad),
        /'models' must be a non-empty array/,
      );
    }
  });

  it('throws when a model misses model_id or label', () => {
    assert.throws(
      () =>
        parseTranscriptionProviderManifestBlock({
          ...OPENAI_BLOCK,
          models: [{ id: 'openai:x', label: 'X', surfaces: ['file'] }],
        }),
      /'model_id' must be a non-empty string/,
    );
    assert.throws(
      () =>
        parseTranscriptionProviderManifestBlock({
          ...OPENAI_BLOCK,
          models: [{ id: 'openai:x', model_id: 'x', surfaces: ['file'] }],
        }),
      /'label' must be a non-empty string/,
    );
  });

  it('throws when surfaces is missing, empty, or carries an unknown value', () => {
    const model = { id: 'openai:x', model_id: 'x', label: 'X' };
    assert.throws(
      () =>
        parseTranscriptionProviderManifestBlock({ ...OPENAI_BLOCK, models: [model] }),
      /'surfaces' must be a non-empty array/,
    );
    assert.throws(
      () =>
        parseTranscriptionProviderManifestBlock({
          ...OPENAI_BLOCK,
          models: [{ ...model, surfaces: [] }],
        }),
      /'surfaces' must be a non-empty array/,
    );
    assert.throws(
      () =>
        parseTranscriptionProviderManifestBlock({
          ...OPENAI_BLOCK,
          models: [{ ...model, surfaces: ['batch'] }],
        }),
      /surface 'batch' must be 'file' or 'stream'/,
    );
  });
});
