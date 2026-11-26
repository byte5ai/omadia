/**
 * #1961 (ADR-0177) — a file or diagram is delivered only with the turn whose
 * tool call produced it. One tool instance serves every turn, so an
 * instance-wide buffer used to hand a concurrent turn's output to whichever
 * turn drained first.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import {
  DiagramTool,
  MAX_PENDING_TURNS,
  PerTurnBuffer,
  type DiagramService,
  type TigrisStore,
} from '@omadia/diagrams';
import { OfficeService, OfficeTool } from '@omadia/plugin-office';

class InMemoryStore implements TigrisStore {
  private readonly objects = new Map<string, Buffer>();
  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }
  put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, body);
    return Promise.resolve();
  }
  getStream(key: string): Promise<{
    stream: Readable;
    contentType: string | undefined;
    contentLength: number | undefined;
  }> {
    const body = this.objects.get(key);
    if (!body) return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
    return Promise.resolve({ stream: Readable.from(body), contentType: undefined, contentLength: body.byteLength });
  }
}

function officeTool(turn: { id: string | undefined }): OfficeTool {
  const service = new OfficeService({
    store: new InMemoryStore(),
    secret: 's'.repeat(32),
    publicBaseUrl: 'https://bot.example.com',
    tenantId: 'dev',
    signedUrlTtlSec: 60,
  });
  return new OfficeTool(service, 1000, { currentTurnId: () => turn.id });
}

const XLSX = (name: string) => ({
  filename: name,
  sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }] }],
});

describe('OfficeTool — files stay with the turn that created them', () => {
  it('a turn that made no tool call drains nothing; the creating turn gets its file', async () => {
    const turn: { id: string | undefined } = { id: 'turn-A' };
    const tool = officeTool(turn);
    await tool.handleXlsx(XLSX('race-A'));

    assert.equal(tool.drain('turn-B'), undefined, 'turn B finished first and made no call');
    const forA = tool.drain('turn-A');
    assert.equal(forA?.length, 1);
    assert.match(JSON.stringify(forA), /race-A\.xlsx/);
    assert.equal(tool.drain('turn-A'), undefined, 'drained once');
  });

  it('interleaved turns each get only their own files', async () => {
    const turn: { id: string | undefined } = { id: 'turn-A' };
    const tool = officeTool(turn);
    await tool.handleXlsx(XLSX('a1'));
    turn.id = 'turn-B';
    await tool.handleDocx({ filename: 'b1', blocks: [{ type: 'paragraph', text: 'x' }] });
    turn.id = 'turn-A';
    await tool.handleXlsx(XLSX('a2'));

    const forB = JSON.stringify(tool.drain('turn-B'));
    assert.match(forB, /b1\.docx/);
    assert.doesNotMatch(forB, /a[12]\.xlsx/);
    const forA = tool.drain('turn-A');
    assert.equal(forA?.length, 2);
  });
});

describe('DiagramTool — renders stay with the turn that made them', () => {
  let n = 0;
  const service = {
    render: () => {
      n += 1;
      return Promise.resolve({ kind: 'mermaid', url: `https://x/d${String(n)}.png`, cacheHit: false });
    },
  } as unknown as DiagramService;
  const quiet = (): void => {};

  it('two renders in one turn give two; another turn gets none', async () => {
    const turn: { id: string | undefined } = { id: 'turn-A' };
    const tool = new DiagramTool(service, undefined, quiet, undefined, () => turn.id);
    await tool.handle({ kind: 'mermaid', source: 'graph TD; A-->B' });
    await tool.handle({ kind: 'mermaid', source: 'graph TD; B-->C' });

    assert.equal(tool.takeRenders('turn-B'), undefined);
    assert.equal(tool.takeRenders('turn-A')?.length, 2);
    assert.equal(tool.takeRenders('turn-A'), undefined);
  });
});

describe('PerTurnBuffer', () => {
  it('keeps no-turn outputs apart from turn outputs', () => {
    const buf = new PerTurnBuffer<number>();
    buf.push(undefined, 1);
    buf.push('t', 2);
    assert.deepEqual(buf.drain('t'), [2]);
    assert.deepEqual(buf.drain(undefined), [1]);
  });

  it('drops the oldest turn once the bound is reached', () => {
    const buf = new PerTurnBuffer<number>();
    for (let i = 0; i <= MAX_PENDING_TURNS; i += 1) buf.push(`t${String(i)}`, i);
    assert.equal(buf.pendingTurns, MAX_PENDING_TURNS);
    assert.equal(buf.drain('t0'), undefined, 'the oldest undrained turn was dropped');
    assert.deepEqual(buf.drain(`t${String(MAX_PENDING_TURNS)}`), [MAX_PENDING_TURNS]);
  });
});
