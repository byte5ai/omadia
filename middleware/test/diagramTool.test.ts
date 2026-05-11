import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DiagramRenderError,
  DiagramTool,
  type DiagramService,
  type RenderInput,
  type RenderOutput,
} from '@omadia/diagrams';

function stubService(
  render: (input: RenderInput) => Promise<RenderOutput>,
): DiagramService {
  return { render } as unknown as DiagramService;
}

describe('DiagramTool', () => {
  it('returns compact JSON with url + kind + cacheHit on success', async () => {
    const service = stubService(async (input) => ({
      kind: input.kind,
      url: `http://example/diagrams/abc.png?exp=1&sig=aa`,
      key: 'byte5/abc.png',
      cacheHit: false,
    }));
    const tool = new DiagramTool(service);
    const out = await tool.handle({ kind: 'mermaid', source: 'graph TD; A-->B' });
    const parsed = JSON.parse(out) as { kind: string; url: string; cacheHit: boolean };
    assert.equal(parsed.kind, 'mermaid');
    assert.equal(parsed.cacheHit, false);
    assert.match(parsed.url, /diagrams\/abc\.png/);
  });

  it('exposes the last render via takeLastRender and clears it on read', async () => {
    const service = stubService(async (input) => ({
      kind: input.kind,
      url: 'http://example/x.png',
      key: 'byte5/x.png',
      cacheHit: true,
      ...(input.title ? { title: input.title } : {}),
    }));
    const tool = new DiagramTool(service);
    await tool.handle({ kind: 'graphviz', source: 'digraph{a->b}', title: 'demo' });
    const first = tool.takeLastRender();
    assert.ok(first);
    assert.equal(first?.title, 'demo');
    const second = tool.takeLastRender();
    assert.equal(second, undefined, 'second read should be empty');
  });

  it('rejects invalid input with a string (no throw)', async () => {
    const service = stubService(() => {
      throw new Error('should not be called');
    });
    const tool = new DiagramTool(service);
    const out = await tool.handle({ kind: 'not-a-kind', source: 'x' });
    assert.ok(out.startsWith('Error:'));
  });

  it('rejects when source missing', async () => {
    const tool = new DiagramTool(stubService(() => {
      throw new Error('should not be called');
    }));
    const out = await tool.handle({ kind: 'mermaid' });
    assert.ok(out.startsWith('Error:'));
  });

  it('surfaces upstream DiagramRenderError as an Error: string', async () => {
    const tool = new DiagramTool(
      stubService(() => {
        return Promise.reject(new DiagramRenderError('kroki down', 502));
      }),
    );
    const out = await tool.handle({ kind: 'mermaid', source: 'A-->B' });
    assert.ok(out.startsWith('Error: upstream renderer failed'));
    assert.equal(tool.takeLastRender(), undefined);
  });
});
