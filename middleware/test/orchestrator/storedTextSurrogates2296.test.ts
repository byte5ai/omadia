/**
 * #2296 — ADR-0191's rule for stored text, beyond the `memory` tool:
 *
 *   - stored processes are persisted text read back in later turns, so the
 *     process tools get the same restore on write and re-mask on read;
 *   - a stored text with a reserved-shape surrogate (`PLATZHALTER-*`, a pool
 *     name at example.net) is withheld even when the reading turn never
 *     minted it: written before ADR-0191, it stands for a value nobody can
 *     name any more, and no real value has that shape.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { reservedSurrogateShapesIn } from '@omadia/plugin-privacy-guard/dist/promptSurrogates.js';
import { countUnresolvedSurrogates } from '@omadia/plugin-privacy-guard/dist/verifierProjection.js';

import {
  isMemoryNoteTool,
  MEMORY_NOTE_STALE_SURROGATE_NOTICE,
  maskMemoryNoteText,
  maskStoredTextPerEntry,
  restoreMemoryNoteInput,
  withheldEntriesNote,
} from '../../packages/harness-orchestrator/src/memoryNoteSurrogates.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import { labelProcessMemory } from '../../packages/harness-orchestrator/src/discretion/labelledProcessMemory.js';
import { readersOf } from '../../packages/harness-orchestrator/src/discretion/labels.js';
import { createDiscretionTurnState } from '../../packages/harness-orchestrator/src/discretion/turnLabels.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';

describe('#2296 — stored processes are stored text', () => {
  it('handles the four process tools like memory', () => {
    for (const tool of ['memory', 'write_process', 'edit_process', 'query_processes', 'run_stored_process']) {
      assert.equal(isMemoryNoteTool(tool), true, tool);
    }
    assert.equal(isMemoryNoteTool('odoo_query'), false);
  });
});

describe('#2296 — reserved shapes from an earlier turn', () => {
  it('finds both reserved shapes, not look-alikes', () => {
    const hits = reservedSurrogateShapesIn(
      'PLATZHALTER-CUSTOM-3 ruft lukas.becker@example.net an; PLATZHALTER-Röntgen-1 nicht.',
    );
    assert.deepEqual([...hits].sort(), ['lukas.becker@example.net', 'platzhalter-custom-3']);
  });

  it('counts them only when asked, also without a map', () => {
    const text = 'Ansprechpartner PLATZHALTER-NAME-2';
    assert.equal(countUnresolvedSurrogates(text, undefined), 0);
    assert.equal(countUnresolvedSurrogates(text, undefined, { reservedShapes: true }), 1);
  });

  it('a note with a placeholder this turn never minted is withheld', async () => {
    // Masking on, nothing minted in this turn: only the reserved-shape count
    // (the real function, no map) can see the stale placeholder.
    let asked: { reservedShapes?: boolean } | undefined;
    const handle = {
      maskUserPrompt: (text: string) =>
        Promise.resolve({ outcome: 'masked' as const, maskedText: text, spans: [], degraded: false }),
      restorePromptPseudonyms: (text: string) => Promise.resolve(text),
      countUnresolvedSurrogates: (text: string, options?: { unreadableLiterals?: boolean; reservedShapes?: boolean }) => {
        asked = options;
        return Promise.resolve(countUnresolvedSurrogates(text, undefined, options));
      },
      remaskPromptValues: (text: string) => text,
    } as unknown as PrivacyTurnHandle;
    const result = await maskMemoryNoteText(handle, 'PLATZHALTER-CUSTOM-7 gehört zu Vertrieb Nord.');
    assert.deepEqual(result, { ok: false, notice: MEMORY_NOTE_STALE_SURROGATE_NOTICE });
    assert.equal(asked?.reservedShapes, true);
    const clean = await maskMemoryNoteText(handle, 'Projekt Yak gehört zu Vertrieb Nord.');
    assert.equal(clean.ok, true);
  });
});

describe('#2296 — per-entry withholding', () => {
  /** Masking on; only text with `PLATZHALTER-CUSTOM-9` (an earlier turn's) is stale. */
  function staleHandle(): PrivacyTurnHandle {
    return {
      maskUserPrompt: (text: string) =>
        Promise.resolve({ outcome: 'masked' as const, maskedText: text, spans: [], degraded: false }),
      restorePromptPseudonyms: (text: string) => Promise.resolve(text),
      countUnresolvedSurrogates: (text: string) => Promise.resolve(text.includes('PLATZHALTER-CUSTOM-9') ? 1 : 0),
      remaskPromptValues: (text: string) => text,
    } as unknown as PrivacyTurnHandle;
  }

  it('drops only the listing line of the stale note', async () => {
    const listing = [
      "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:",
      '1.0K\t/memories/projects.md',
      '512B\t/memories/PLATZHALTER-CUSTOM-9.md',
      '2.0K\t/memories/team.md',
    ].join('\n');
    const result = await maskStoredTextPerEntry(staleHandle(), listing);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.ok(result.text.includes('/memories/projects.md'));
    assert.ok(result.text.includes('/memories/team.md'));
    assert.ok(!result.text.includes('PLATZHALTER-CUSTOM-9'));
    assert.ok(result.text.includes(withheldEntriesNote(1)));
  });

  it('drops only the stale process hit of query_processes', async () => {
    const result = await maskStoredTextPerEntry(
      staleHandle(),
      JSON.stringify({
        query: 'invoice',
        mode: 'hybrid',
        hits: [
          { id: 'process:a', title: 'Finance: Send the invoice', stepsPreview: ['Open'] },
          { id: 'process:b', title: 'Finance: Ask PLATZHALTER-CUSTOM-9', stepsPreview: [] },
        ],
      }),
      'query_processes',
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    const parsed = JSON.parse(result.text) as { hits: Array<{ id: string }>; withheld?: string };
    assert.deepEqual(parsed.hits.map((h) => h.id), ['process:a']);
    assert.equal(parsed.withheld, withheldEntriesNote(1));
  });

  it('refuses a write that carries an earlier turn\'s reserved placeholder', async () => {
    const handle = {
      maskUserPrompt: (text: string) =>
        Promise.resolve({ outcome: 'masked' as const, maskedText: text, spans: [], degraded: false }),
      restorePromptPseudonyms: (text: string) => Promise.resolve(text),
      countUnresolvedSurrogates: (text: string, options?: { reservedShapes?: boolean }) =>
        Promise.resolve(countUnresolvedSurrogates(text, undefined, options)),
      remaskPromptValues: (text: string) => text,
    } as unknown as PrivacyTurnHandle;
    const result = await restoreMemoryNoteInput(handle, { title: 'Ops: Call PLATZHALTER-NAME-4', steps: ['x'] });
    assert.equal(result.ok, false);
  });

  it('still withholds one stale note as a whole (it is one entry)', async () => {
    const result = await maskStoredTextPerEntry(staleHandle(), 'PLATZHALTER-CUSTOM-9 gehört zu Vertrieb Nord.');
    assert.deepEqual(result, { ok: false, notice: MEMORY_NOTE_STALE_SURROGATE_NOTICE });
  });
});

describe('#2296 — labels survive the id rewrite', () => {
  it('a read of a rewritten process takes the labels kept under its old id', async () => {
    const asked: string[][] = [];
    const port = {
      labelsOf: (_kind: string, ids: readonly string[]) => {
        asked.push([...ids]);
        return Promise.resolve(new Map());
      },
      persistLabels: () => Promise.resolve(),
      declarationOf: () => Promise.resolve(undefined),
      audit: () => {},
    };
    const record = {
      id: 'process:0b6f2c1e-1111-4222-8333-944455556666',
      legacyId: 'process:hr:kunde-rechnung',
      scope: 'hr',
      title: 'Kunde: Rechnung',
      steps: ['Senden'],
      visibility: 'team',
      version: 1,
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z',
    };
    const inner = {
      write: () => Promise.reject(new Error('unused')),
      edit: () => Promise.reject(new Error('unused')),
      query: () => Promise.resolve([{ record, score: 1 }]),
      get: () => Promise.resolve(record),
      history: () => Promise.resolve([record]),
    };
    const labelled = labelProcessMemory(inner as never, port as never);
    await turnContext.run(
      {
        turnId: 't1',
        discretion: createDiscretionTurnState({ resolveReaders: () => Promise.resolve(readersOf(['a'])) }),
      } as never,
      async () => {
        await labelled.get(record.legacyId);
        await labelled.query({ query: 'x', limit: 3 } as never);
      },
    );
    assert.deepEqual(asked[0], [record.id, record.legacyId]);
    assert.deepEqual(asked[1], [record.id, record.legacyId]);
  });
});
