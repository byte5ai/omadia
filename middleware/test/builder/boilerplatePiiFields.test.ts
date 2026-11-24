/**
 * S3c (spec 2042 §5.10) — the Plugin Builder's boilerplates hand a tool's
 * declared PII fields to the kernel with its registration
 * (`ctx.tools.register(spec, handler, { piiFields })`), so the Privacy Shield
 * masks them in every result. Before, `registerTools.ts` had no slot for them.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { registerToolkit as registerIntegrationToolkit } from '../../assets/boilerplate/integration/registerTools.js';
import { registerToolkit as registerToolToolkit } from '../../assets/boilerplate/tool/registerTools.js';

const PII = [{ path: '[].name', idPath: '[].id', type: 'PERSON' as const }];

function fakeCtx() {
  const registered: { name: string; options: unknown }[] = [];
  const ctx = {
    tools: {
      register(spec: { name: string }, _handler: unknown, options?: unknown) {
        registered.push({ name: spec.name, options });
        return () => undefined;
      },
    },
  };
  return { ctx, registered };
}

function toolkit() {
  const input = z.object({ query: z.string() });
  return {
    tools: [
      { id: 'list_people', description: 'people', input, piiFields: PII, run: async () => [] },
      { id: 'count_rows', description: 'rows', input, run: async () => 0 },
    ],
    close: async () => undefined,
  };
}

describe('Builder boilerplate registerTools — piiFields', () => {
  for (const [kind, register] of [
    ['tool', registerToolToolkit],
    ['integration', registerIntegrationToolkit],
  ] as const) {
    it(`${kind}: a tool's piiFields go with its registration, a tool without them registers without options`, () => {
      const { ctx, registered } = fakeCtx();
      register(ctx as never, toolkit() as never);
      assert.deepEqual(registered, [
        { name: 'list_people', options: { piiFields: PII } },
        { name: 'count_rows', options: undefined },
      ]);
    });
  }
});
