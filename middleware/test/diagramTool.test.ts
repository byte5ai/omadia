import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DIAGRAM_TOOL_NAME,
  DiagramRenderError,
  DiagramTool,
  createKrokiClient,
  type DiagramService,
  type RenderInput,
  type RenderOutput,
} from '@omadia/diagrams';
import { createPrivacyTurnHandle, guardControlFlowResult } from '@omadia/orchestrator';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

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

  it('withholds the text of an exception the tool did not author, and logs it', async () => {
    const EMAIL = 'erika.mustermann@example.com';
    const logged: string[] = [];
    const tool = new DiagramTool(
      stubService(() =>
        Promise.reject(new Error(`storage write failed for owner ${EMAIL}`)),
      ),
      undefined,
      (msg) => logged.push(msg),
    );
    const out = await tool.handle({ kind: 'mermaid', source: 'A-->B' });
    assert.equal(out.includes(EMAIL), false, `the exception text reached the model: ${out}`);
    assert.match(out, /^Error: tool `render_diagram` failed with Error \[ref (err_[0-9a-f]{12})\]/);
    const ref = /\[ref (err_[0-9a-f]{12})\]/.exec(out)?.[1] ?? '?';
    assert.ok(
      logged.some((line) => line.includes(`ref=${ref}`) && line.includes(EMAIL)),
      'the full error goes to the tool log under the same ref',
    );
  });
});

/**
 * A renderer failure reaches the model in the tool's own words only. Kroki
 * answers a rejected source with a body that quotes the source back, and a
 * transport exception (undici, a proxy, DNS) carries text this plugin never
 * wrote: both stay in the server log under the notice's ref.
 */
describe('DiagramTool — renderer failures keep foreign text off the model', () => {
  const NAME = 'Jane Doe';
  const EMAIL = 'erika.mustermann@example.com';
  const REF = /\[ref (err_[0-9a-f]{12})\]/;

  async function failWith(err: Error): Promise<{ out: string; logged: string[] }> {
    const logged: string[] = [];
    const tool = new DiagramTool(
      stubService(() => Promise.reject(err)),
      undefined,
      (msg) => logged.push(msg),
    );
    const out = await tool.handle({ kind: 'mermaid', source: 'A-->B' });
    return { out, logged };
  }

  function assertLoggedUnderRef(out: string, logged: string[], needle: string): void {
    const ref = REF.exec(out)?.[1];
    assert.ok(ref, `no log ref in the notice: ${out}`);
    assert.ok(
      logged.some((line) => line.includes(`ref=${ref}`) && line.includes(needle)),
      'the withheld detail goes to the tool log under the same ref',
    );
  }

  it('withholds a transport exception carried as the cause', async () => {
    const { out, logged } = await failWith(
      new DiagramRenderError('Kroki mermaid/png request failed', undefined, undefined, {
        cause: new Error(`connection failed for ${NAME}`),
      }),
    );
    assert.equal(out.includes(NAME), false, `the cause reached the model: ${out}`);
    assert.match(out, /^Error: upstream renderer failed for `mermaid` \[ref err_[0-9a-f]{12}\]/);
    assert.match(out, /answer without the diagram/);
    assertLoggedUnderRef(out, logged, NAME);
  });

  it('withholds the upstream body preview but keeps the HTTP status', async () => {
    const { out, logged } = await failWith(
      new DiagramRenderError('Kroki mermaid/png responded 400', 400, `Syntax error near "${EMAIL}"`),
    );
    assert.equal(out.includes(EMAIL), false, `the body preview reached the model: ${out}`);
    assert.match(out, /^Error: upstream renderer failed for `mermaid` with HTTP 400 \[ref /);
    assert.match(out, /check its syntax/, 'a 4xx tells the model the source was rejected');
    assertLoggedUnderRef(out, logged, EMAIL);
  });

  it('never echoes the message of a DiagramRenderError, whoever built it', async () => {
    // A KrokiClient implemented elsewhere may still fold foreign text into
    // the message the way this package's client used to.
    const { out, logged } = await failWith(
      new DiagramRenderError(`Kroki request failed: connection failed for ${NAME}`),
    );
    assert.equal(out.includes(NAME), false, `the message reached the model: ${out}`);
    assertLoggedUnderRef(out, logged, NAME);
  });

  it('through the dispatch seam with the real privacy guard: no name, hint intact', async () => {
    // The seam redacts identity patterns, the deny-list and C1 when it is
    // configured — a name in running prose passes it, so it must not be in
    // the tool result in the first place.
    const { out } = await failWith(
      new DiagramRenderError(`Kroki mermaid/png responded 400: Syntax error near "${NAME}"`, 400),
    );
    const privacy = createPrivacyTurnHandle({
      service: createPrivacyGuardService(),
      sessionId: 'session-diagrams',
      turnId: 'turn-diagrams',
    });
    const errorLog = mock.method(console, 'error', () => {});
    let forModel: string;
    try {
      forModel = await guardControlFlowResult({
        toolName: DIAGRAM_TOOL_NAME,
        result: out,
        privacy,
        site: 'test',
      });
    } finally {
      errorLog.mock.restore();
    }
    assert.equal(forModel.includes(NAME), false, `the name reached the model: ${forModel}`);
    assert.equal(forModel, out, 'the tool-authored result passes the redactor unchanged');
    assert.match(forModel, /HTTP 400/);
  });
});

describe("createKrokiClient — errors carry only the client's own words", () => {
  const EMAIL = 'erika.mustermann@example.com';

  type Handler = (req: IncomingMessage, res: ServerResponse) => void;

  async function withServer(handler: Handler, run: (baseUrl: string) => Promise<void>): Promise<void> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${String(port)}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function answer(status: number, contentType: string, body: string): Handler {
    return (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': contentType });
        res.end(body);
      });
    };
  }

  it("keeps a rejected source's body preview on `body`, off the message", async () => {
    await withServer(answer(400, 'text/plain', `Error 400: Syntax error near "${EMAIL}"`), async (baseUrl) => {
      await assert.rejects(createKrokiClient({ baseUrl }).renderPng('mermaid', 'A-->B'), (err: unknown) => {
        assert.ok(err instanceof DiagramRenderError);
        assert.equal(err.message, 'Kroki mermaid/png responded 400');
        assert.equal(err.status, 400);
        assert.ok(err.body?.includes(EMAIL), 'the preview stays available for the log');
        return true;
      });
    });
  });

  it('keeps an unexpected content type off the message', async () => {
    await withServer(answer(200, `text/html; owner=${EMAIL}`, '<html></html>'), async (baseUrl) => {
      await assert.rejects(
        createKrokiClient({ baseUrl }).renderPng('graphviz', 'digraph{a->b}'),
        (err: unknown) => {
          assert.ok(err instanceof DiagramRenderError);
          assert.equal(err.message.includes(EMAIL), false, err.message);
          assert.ok(err.body?.includes(EMAIL), 'the content type stays available for the log');
          return true;
        },
      );
    });
  });

  it('keeps a transport exception off the message, as the cause', async () => {
    // A port nothing listens on any more: the request fails in transport.
    let closedBaseUrl = '';
    await withServer(answer(200, 'image/png', ''), (baseUrl) => {
      closedBaseUrl = baseUrl;
      return Promise.resolve();
    });
    await assert.rejects(
      createKrokiClient({ baseUrl: closedBaseUrl, timeoutMs: 5_000 }).renderPng('mermaid', 'A-->B'),
      (err: unknown) => {
        assert.ok(err instanceof DiagramRenderError);
        assert.equal(err.message, 'Kroki mermaid/png request failed');
        assert.equal(err.status, undefined);
        assert.ok(err.cause instanceof Error, 'the transport exception rides as the cause');
        return true;
      },
    );
  });
});
