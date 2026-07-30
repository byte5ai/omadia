import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import {
  ToolDispatchService,
  type ToolDispatchCallerContext,
} from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import { currentDispatchCaller } from '../../packages/harness-orchestrator/src/toolCallerContext.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import type { DomainTool } from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';

/**
 * #542 prerequisite — the privacy/trace seam in `ToolDispatchService`.
 *
 * `ToolDispatchService` is what the loopback MCP server dispatches through, and
 * what a public MCP endpoint would dispatch through. Before this work it applied
 * NO privacy masking: the chat path masks tool results via
 * `Orchestrator.dispatchToolDeadlined`, but that code reads its handle from
 * `turnContext`, which this dispatcher runs entirely outside of. A caller reaching
 * tools here got PII in clear.
 *
 * MUTATION-CHECK DISCIPLINE: every assertion below inspects the CONTENT that
 * leaves the dispatcher. None of them assert "a masking function was called" —
 * a call-count assertion stays green over a masking function that returns its
 * input unchanged, which is exactly the class of false-green this repo has been
 * burned by. The fake handle performs a REAL redaction and the tests assert the
 * raw PII is absent from the output.
 */

const EMAIL = 'erika.mustermann@example.com';
const IBAN = 'DE89370400440532013000';
const PII_RESULT = `{"name":"Erika Mustermann","email":"${EMAIL}","iban":"${IBAN}"}`;

interface RecordedBypass {
  readonly toolName: string;
  readonly pluginId: string;
  readonly bytes: number;
}

/**
 * A privacy handle that genuinely redacts. `internToolResultV4` strips the email
 * and IBAN and returns a digest — so if the dispatcher fails to call it, the raw
 * values survive into the output and the assertions below fail.
 */
function redactingPrivacyHandle(options?: {
  readonly bypassTools?: ReadonlySet<string>;
  readonly bypassReceipts?: RecordedBypass[];
  readonly internThrows?: boolean;
}): PrivacyTurnHandle {
  return {
    async internToolResultV4({ toolName, rawResult }) {
      if (options?.internThrows === true) {
        throw new Error('privacy provider unavailable');
      }
      const redacted = rawResult
        .replaceAll(EMAIL, '[masked:email]')
        .replaceAll(IBAN, '[masked:iban]')
        .replaceAll('Erika Mustermann', '[masked:person]');
      return {
        digestText: `«dataset:${toolName}» ${redacted}`,
        datasetId: `ds-${toolName}`,
      };
    },
    async recordBypassedTool({ toolName, pluginId, bytes }) {
      options?.bypassReceipts?.push({ toolName, pluginId, bytes });
    },
    checkBypass(toolName) {
      return options?.bypassTools?.has(toolName) === true
        ? { pluginId: `plugin-for-${toolName}` }
        : undefined;
    },
    async runV4Tool() {
      throw new Error('not used on this path');
    },
    async subAgentResultV4() {
      throw new Error('not used on this path');
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async maskUserPrompt() {
      return { outcome: 'disabled' };
    },
    async restorePromptPseudonyms(text) {
      return text;
    },
    snapshotPromptRestorer() {
      return undefined;
    },
    async finalize() {
      return undefined;
    },
  };
}

function registryWith(
  name: string,
  result: string,
  extra?: { readonly agentId?: string },
): NativeToolRegistry {
  const nativeTools = new NativeToolRegistry();
  nativeTools.register(name, {
    handler: async () => result,
    spec: {
      name,
      description: 'returns a PII-bearing payload',
      input_schema: { type: 'object', properties: {} },
    },
    domain: 'test.pii',
    ...(extra?.agentId !== undefined ? { agentId: extra.agentId } : {}),
  });
  return nativeTools;
}

describe('ToolDispatchService — privacy data-plane boundary (#542 prerequisite)', () => {
  it('MASKS a PII-bearing native tool result — the raw values never leave the dispatcher', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('odoo_read_partner', {});

    // The load-bearing assertions: the actual PII is GONE from the output.
    assert.equal(
      result.content.includes(EMAIL),
      false,
      'the email address reached the caller in clear — masking did not happen',
    );
    assert.equal(
      result.content.includes(IBAN),
      false,
      'the IBAN reached the caller in clear — masking did not happen',
    );
    assert.equal(
      result.content.includes('Erika Mustermann'),
      false,
      'the person name reached the caller in clear — masking did not happen',
    );
    // And the masked substitutes ARE present, so this is masking rather than
    // the result having been dropped or emptied.
    assert.match(result.content, /\[masked:email\]/);
    assert.match(result.content, /\[masked:iban\]/);
    assert.match(result.content, /«dataset:odoo_read_partner»/);
    assert.equal(result.isError, undefined);
  });

  it('MASKS a PII-bearing DOMAIN tool result too (both dispatch branches, not just native)', async () => {
    const domainTool: DomainTool = {
      name: 'ask_hr',
      spec: {
        name: 'ask_hr',
        description: 'sub-agent',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      domain: 'domain.hr',
      async handle() {
        return PII_RESULT;
      },
    };
    const service = new ToolDispatchService({
      nativeTools: new NativeToolRegistry(),
      domainTools: [domainTool],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('ask_hr', {});

    assert.equal(result.content.includes(EMAIL), false, 'domain-tool branch leaked the email');
    assert.equal(result.content.includes(IBAN), false, 'domain-tool branch leaked the IBAN');
    assert.match(result.content, /\[masked:email\]/);
  });

  it('inherits an AMBIENT turn privacy handle when no explicit dep is wired', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
    });

    const result = await turnContext.run(
      {
        privacyHandle: redactingPrivacyHandle(),
      } as unknown as Parameters<typeof turnContext.run>[0],
      () => service.dispatch('odoo_read_partner', {}),
    );

    assert.equal(
      result.content.includes(EMAIL),
      false,
      'a dispatch inside a turn must inherit that turn privacy handle',
    );
    assert.match(result.content, /\[masked:email\]/);
  });

  it('leaves the result UNCHANGED when no privacy provider is installed (parity with the orchestrator)', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
    });

    const result = await service.dispatch('odoo_read_partner', {});

    assert.equal(result.content, PII_RESULT);
  });

  it('honours the intern EXEMPTION list — a self/infra tool is not masked', async () => {
    // `memory` is on `INTERN_EXEMPT_TOOLS`: masking it would blind the agent to
    // its own operational state. The chat path exempts it, so this path must too.
    const service = new ToolDispatchService({
      nativeTools: registryWith('memory', PII_RESULT),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('memory', {});

    assert.equal(result.content, PII_RESULT, 'an intern-exempt tool must pass through raw');
  });

  it('honours the operator BYPASS and records the receipt entry', async () => {
    const receipts: RecordedBypass[] = [];
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
      privacy: () =>
        redactingPrivacyHandle({
          bypassTools: new Set(['odoo_read_partner']),
          bypassReceipts: receipts,
        }),
    });

    const result = await service.dispatch('odoo_read_partner', {});

    // Bypass means the operator explicitly opted this plugin out — raw is correct.
    assert.equal(result.content, PII_RESULT);
    // But it must stay auditable, exactly as on the chat path.
    assert.deepEqual(receipts, [
      {
        toolName: 'odoo_read_partner',
        pluginId: 'plugin-for-odoo_read_partner',
        bytes: Buffer.byteLength(PII_RESULT, 'utf8'),
      },
    ]);
  });

  it('fails OPEN when the privacy provider throws — documented parity with the chat path', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
      privacy: () => redactingPrivacyHandle({ internThrows: true }),
    });

    const result = await service.dispatch('odoo_read_partner', {});

    // `Orchestrator.dispatchToolDeadlined` logs and sends the raw result when
    // interning throws. This path matches it deliberately rather than silently
    // diverging; a fail-CLOSED policy for untrusted callers is its own decision.
    assert.equal(result.content, PII_RESULT);
    assert.equal(result.isError, undefined);
  });
});

describe('ToolDispatchService — raw-result capture (#542 prerequisite)', () => {
  it('captures the RAW result before masking, while the caller gets the MASKED one', async () => {
    const captured: Array<{ name: string; result: string; caller?: ToolDispatchCallerContext }> = [];
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
      captureRawToolResult: (name, result, caller) => {
        captured.push({ name, result, ...(caller !== undefined ? { caller } : {}) });
      },
    });

    const result = await service.dispatch('odoo_read_partner', {});

    // The trace consumer sees ground truth …
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.result, PII_RESULT);
    // … and the caller does NOT. Both halves matter: capturing the masked value
    // would make traces useless, returning the raw value would be the leak.
    assert.equal(result.content.includes(EMAIL), false);
  });

  it('survives a throwing capture callback without failing the tool call', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
      captureRawToolResult: () => {
        throw new Error('audit sink exploded');
      },
    });

    const result = await service.dispatch('odoo_read_partner', {});

    assert.equal(result.content, PII_RESULT);
    assert.equal(result.isError, undefined);
  });
});

describe('ToolDispatchService — caller context seam (#542 prerequisite)', () => {
  it('propagates the caller identity to layers BENEATH the handler', async () => {
    const nativeTools = new NativeToolRegistry();
    let seenInsideHandler: ToolDispatchCallerContext | undefined;
    nativeTools.register('whoami', {
      // A plugin handler cannot receive identity as a parameter — the
      // `NativeToolHandler` contract is published — so it must be readable
      // ambiently, which is what this asserts.
      handler: async () => {
        seenInsideHandler = currentDispatchCaller();
        return 'ok';
      },
      spec: {
        name: 'whoami',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
    });
    const service = new ToolDispatchService({ nativeTools, domainTools: [] });

    const caller: ToolDispatchCallerContext = {
      principal: 'apikey_123',
      scopes: ['tools:write'],
      tenantId: 'tenant-a',
      userId: 'user-7',
      requestId: 'req-abc',
    };
    await service.dispatch('whoami', {}, { caller });

    assert.deepEqual(seenInsideHandler, caller);
  });

  it('leaves the ambient caller EMPTY on the loopback path (no caller supplied)', async () => {
    const nativeTools = new NativeToolRegistry();
    let seenInsideHandler: ToolDispatchCallerContext | undefined = {
      principal: 'sentinel',
    };
    nativeTools.register('whoami', {
      handler: async () => {
        seenInsideHandler = currentDispatchCaller();
        return 'ok';
      },
      spec: {
        name: 'whoami',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
    });
    const service = new ToolDispatchService({ nativeTools, domainTools: [] });

    await service.dispatch('whoami', {});

    assert.equal(seenInsideHandler, undefined);
  });
});
