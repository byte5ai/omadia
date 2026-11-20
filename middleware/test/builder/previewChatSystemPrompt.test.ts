import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { previewDraftAgentPrompt } from '../../src/plugins/builder/previewChatService.js';
import { emptyAgentSpec } from '../../src/plugins/builder/types.js';
import type {
  PreviewHandle,
  PreviewToolDescriptor,
} from '../../src/plugins/builder/previewRuntime.js';

/**
 * Spec 2042 §5.10 — the Plugin Builder preview is a turn of a neutral draft
 * agent. Its system prompt names the draft plugin and its tools, marks the
 * turn as a preview and never carries a persona, quality settings, role text
 * or skill files — not even from a draft stored before the change, and not
 * from a stray `skills/` directory in the extracted package.
 */

function tool(id: string): PreviewToolDescriptor {
  return {
    id,
    description: `tool ${id}`,
    inputSchema: { type: 'object', properties: {} },
    run: async () => 'ok',
  };
}

function fakeHandle(previewDir: string, tools: PreviewToolDescriptor[]): PreviewHandle {
  return {
    agentId: '@omadia/weather',
    previewDir,
    toolkit: { tools },
  } as unknown as PreviewHandle;
}

describe('previewDraftAgentPrompt — neutral draft agent', () => {
  let previewDir: string;

  beforeEach(async () => {
    previewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-sysprompt-'));
  });

  afterEach(() => {
    rmSync(previewDir, { recursive: true, force: true });
  });

  it('marks the preview, names the plugin, its kind and exactly its tools', () => {
    const spec = {
      ...emptyAgentSpec(),
      name: 'Weather',
      id: '@omadia/weather',
      description: 'Liefert Wetterdaten.',
      depends_on: ['@omadia/integration-openweather'],
      playbook: { when_to_use: 'Fragen zum Wetter', not_for: ['Klimahistorie'], example_prompts: [] },
    };
    const out = previewDraftAgentPrompt(
      fakeHandle(previewDir, [tool('get_forecast'), tool('get_alerts')]),
      spec,
    );
    assert.match(out, /^# Preview/);
    assert.match(out, /neutral draft agent in the Plugin Builder preview/);
    assert.match(out, /"Weather" \(@omadia\/weather v0\.1\.0, kind integration\)/);
    assert.match(out, /Your only tools are the ones this plugin registers: get_forecast, get_alerts\./);
    assert.match(out, /Fragen zum Wetter/);
    assert.match(out, /- Klimahistorie/);
  });

  it('carries no persona, quality or role text from an old draft or a skills dir', async () => {
    await fs.mkdir(path.join(previewDir, 'skills'));
    await fs.writeFile(
      path.join(previewDir, 'skills', 'weather-expert.md'),
      '---\nkind: prompt_partial\n---\n# Rolle: Wetterfrosch mit Humor',
    );
    const legacy = {
      ...emptyAgentSpec(),
      name: 'Weather',
      id: '@omadia/weather',
      skill: { role: 'Du bist ein Wetterfrosch.', tonality: 'sarkastisch' },
      persona: { axes: { sarcasm: 95 }, custom_notes: 'Antworte immer gereimt.' },
      quality: { sycophancy: 'high', boundaries: { presets: ['no-pii'], custom: ['nie lügen'] } },
    };
    const out = previewDraftAgentPrompt(fakeHandle(previewDir, [tool('get_forecast')]), legacy);
    for (const leaked of [
      'Wetterfrosch',
      'sarkastisch',
      'gereimt',
      'nie lügen',
      '<persona>',
      'Boundaries',
      'Anti-Sycophancy',
    ]) {
      assert.equal(out.includes(leaked), false, `prompt must not contain '${leaked}'`);
    }
  });

  it('says so when the plugin registers no tools yet', () => {
    const out = previewDraftAgentPrompt(fakeHandle(previewDir, []), {
      ...emptyAgentSpec(),
      name: 'Empty',
      id: '@omadia/empty',
    });
    assert.match(out, /registers no tools yet/);
    assert.match(out, /kind tool/);
  });
});
