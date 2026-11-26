import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * #1806 — the platform builds the preview and runs the runtime smoke on its
 * own, often while a builder turn is still running. The model can only learn
 * that state from `get_build_status` / `runtime_smoke_status`, so the prompt
 * must name both tools as the source of truth, and must not tell the model
 * that "no build" happens (it read that as "nothing has been built yet").
 *
 * The behaviour lives in a model; assert the artifact that carries it.
 */
const MIDDLEWARE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const prompt = readFileSync(
  path.join(MIDDLEWARE_ROOT, 'src/plugins/builder/prompts/builder-system.md'),
  'utf-8',
);

describe('builder-system.md · build and smoke status (#1806)', () => {
  it('tells the model to call get_build_status before reporting build state', () => {
    assert.match(prompt, /`get_build_status`[\s\S]{0,200}berichte/);
  });

  it('tells the model to call runtime_smoke_status before reporting smoke state', () => {
    assert.match(prompt, /`runtime_smoke_status`[\s\S]{0,200}berichte/);
  });

  it('says the platform builds and smokes on its own', () => {
    assert.match(prompt, /Die Plattform baut den Preview \*\*selbst\*\*/);
  });

  it('no longer claims there is no build', () => {
    assert.doesNotMatch(prompt, /Kein direkter Build/);
  });
});
