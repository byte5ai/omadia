import { describe, expect, it } from 'vitest';

import type { AdminProviderModel, ModelClass } from '../../../../_lib/api';
import { buildModelSelect, isClassRef } from '../assignmentModelOptions';

function model(modelId: string, cls: ModelClass, label = modelId.toUpperCase()): AdminProviderModel {
  return {
    id: `anthropic:${modelId}`,
    modelId,
    label,
    class: cls,
    contextWindow: 200_000,
    maxTokens: 8_192,
    vision: false,
  };
}

const MODELS = [
  model('claude-haiku-x', 'fast', 'Claude Haiku X'),
  model('claude-opus-5', 'frontier', 'Claude Opus 5'),
  model('claude-sonnet-5', 'balanced', 'Claude Sonnet 5'),
];

const DEFAULTS = {
  frontier: 'claude-opus-5',
  balanced: 'claude-sonnet-5',
  fast: 'claude-haiku-x',
} as const;

describe('isClassRef', () => {
  it('accepts exactly the three class refs', () => {
    expect(isClassRef('class:frontier')).toBe(true);
    expect(isClassRef('class:balanced')).toBe(true);
    expect(isClassRef('class:fast')).toBe(true);
    expect(isClassRef('class:huge')).toBe(false);
    expect(isClassRef('claude-opus-5')).toBe(false);
    expect(isClassRef(null)).toBe(false);
  });
});

describe('buildModelSelect (#1083)', () => {
  it('selects a stored class ref and labels it with the resolved model', () => {
    const sel = buildModelSelect({
      stored: 'class:frontier',
      resolvedModel: 'claude-opus-5',
      models: MODELS,
      classDefaults: DEFAULTS,
    });
    expect(sel.value).toBe('class:frontier');
    expect(sel.placeholder).toBe(false);
    expect(sel.extraOption).toBeUndefined();
    const opt = sel.classOptions.find((o) => o.value === sel.value);
    expect(opt).toEqual({ value: 'class:frontier', cls: 'frontier', target: 'Claude Opus 5' });
  });

  it('labels the stored class with the server-resolved model, not the class default', () => {
    // The provider has no fast model: the runtime falls back to another class.
    const sel = buildModelSelect({
      stored: 'class:fast',
      resolvedModel: 'claude-sonnet-5',
      models: MODELS.filter((m) => m.class !== 'fast'),
      classDefaults: { frontier: 'claude-opus-5', balanced: 'claude-sonnet-5' },
    });
    expect(sel.value).toBe('class:fast');
    const opt = sel.classOptions.find((o) => o.value === 'class:fast');
    expect(opt?.target).toBe('Claude Sonnet 5');
  });

  it('falls back to the raw id when the resolved model has no row', () => {
    const sel = buildModelSelect({
      stored: 'class:frontier',
      resolvedModel: 'claude-opus-6',
      models: MODELS,
    });
    expect(sel.classOptions[0]).toEqual({
      value: 'class:frontier',
      cls: 'frontier',
      target: 'claude-opus-6',
    });
  });

  it('names no model when the server says the stored class resolves to nothing', () => {
    // `null` is the server's "unresolvable" (e.g. the stored provider has no
    // models); only an absent `resolvedModel` may fall back to a class default.
    const sel = buildModelSelect({
      stored: 'class:frontier',
      resolvedModel: null,
      models: MODELS,
      classDefaults: { frontier: 'x' },
    });
    expect(sel.value).toBe('class:frontier');
    expect(sel.classOptions.find((o) => o.cls === 'frontier')).toEqual({
      value: 'class:frontier',
      cls: 'frontier',
    });
  });

  it('falls back to the class default only when the server did not report a resolution', () => {
    const sel = buildModelSelect({
      stored: 'class:frontier',
      models: MODELS,
      classDefaults: DEFAULTS,
    });
    expect(sel.classOptions.find((o) => o.cls === 'frontier')?.target).toBe('Claude Opus 5');
  });

  it('leaves the target off when nothing says what a class resolves to', () => {
    const sel = buildModelSelect({ stored: 'class:frontier', models: MODELS });
    expect(sel.classOptions.find((o) => o.cls === 'frontier')).toEqual({
      value: 'class:frontier',
      cls: 'frontier',
    });
  });

  it('gives an unlisted concrete id or alias its own selected option', () => {
    for (const stored of ['opus', 'anthropic:claude-opus-5', 'claude-dropped-1']) {
      const sel = buildModelSelect({
        stored,
        resolvedModel: 'claude-opus-5',
        models: MODELS,
        classDefaults: DEFAULTS,
      });
      expect(sel.value).toBe(stored);
      expect(sel.extraOption).toEqual({ value: stored, label: stored });
    }
  });

  it('renders the placeholder when no model is stored', () => {
    const sel = buildModelSelect({ stored: null, models: MODELS, classDefaults: DEFAULTS });
    expect(sel.value).toBe('');
    expect(sel.placeholder).toBe(true);
    expect(sel.extraOption).toBeUndefined();
  });

  it('adds no extra option for a listed concrete id', () => {
    const sel = buildModelSelect({
      stored: 'claude-sonnet-5',
      resolvedModel: 'claude-sonnet-5',
      models: MODELS,
      classDefaults: DEFAULTS,
    });
    expect(sel.value).toBe('claude-sonnet-5');
    expect(sel.extraOption).toBeUndefined();
    expect(sel.modelOptions.map((o) => o.value)).toEqual([
      'claude-haiku-x',
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
  });

  it('orders class options frontier → balanced → fast, only for classes served', () => {
    const all = buildModelSelect({ stored: null, models: MODELS, classDefaults: DEFAULTS });
    expect(all.classOptions.map((o) => o.value)).toEqual([
      'class:frontier',
      'class:balanced',
      'class:fast',
    ]);
    expect(all.classOptions.map((o) => o.target)).toEqual([
      'Claude Opus 5',
      'Claude Sonnet 5',
      'Claude Haiku X',
    ]);
    const noBalanced = buildModelSelect({
      stored: null,
      models: MODELS.filter((m) => m.class !== 'balanced'),
    });
    expect(noBalanced.classOptions.map((o) => o.cls)).toEqual(['frontier', 'fast']);
  });

  it('offers no class options for a provider with no models', () => {
    const sel = buildModelSelect({ stored: null, models: [] });
    expect(sel.classOptions).toEqual([]);
    expect(sel.modelOptions).toEqual([]);
  });
});
