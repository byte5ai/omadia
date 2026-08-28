import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAgentBuilderRouter } from '../src/routes/agentBuilder.js';
import { redactProviderInternals } from '../src/services/providerInternalsRedaction.js';
import { CURRENT_VERIFIER_VERSION, type SkillVerdictRow } from '../src/services/skillVerdict.js';
import { sanitizeVerdictRationale } from '../src/services/skillVerdictLlmVerifier.js';

/**
 * OM-26 read path — legacy rows must not still cross the wire.
 *
 * The write-path fix stopped `skillVerdictLlmVerifier` from persisting raw
 * provider payloads, and the web-ui scrubs what it renders. Neither helps a row
 * that was persisted BEFORE the fix: the server still *sent* it, so the
 * `request_id` sat in the HTTP response body, in devtools, and in any
 * client-side error reporter, no matter what the renderer did with it
 * afterwards.
 *
 * These tests assert at the ROUTE boundary, on the serialized response text,
 * because that is the boundary the value was crossing. A unit test of the
 * scrubber alone would have stayed green through the entire bug.
 */

/** The exact payload from the bug report, as persisted by the old verifier. */
const LEGACY_RATIONALE =
  'llm completion failed: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CdcPnpMTB8iyAmMBnbem8"}';

const SKILL_ID = '11111111-2222-4333-8444-555555555555';
const CONTENT_HASH = 'sha256:deadbeef';
const MODEL_ID = 'stub-model';
const PROMPT_HASH = 'stub-prompt';

function legacyRow(): SkillVerdictRow {
  return {
    contentHash: CONTENT_HASH,
    verifierVersion: CURRENT_VERIFIER_VERSION,
    modelId: MODEL_ID,
    promptHash: PROMPT_HASH,
    severity: 'scan_failed',
    riskCodes: [],
    rationale: LEGACY_RATIONALE,
    computedAt: new Date('2026-01-01T00:00:00.000Z'),
  } as SkillVerdictRow;
}

/**
 * Minimal stub of the store surface `GET /skills/:id` and
 * `POST /skills/:id/verdict/llm-scan` touch. Anything else the route reaches
 * for is absent, so the harness cannot silently drift onto another code path.
 */
function makeStubGraph(): Record<string, unknown> {
  return {
    getSkill: (id: string) =>
      Promise.resolve(
        id === SKILL_ID
          ? {
              id: SKILL_ID,
              slug: 'legacy-skill',
              name: 'Legacy Skill',
              description: 'persisted before the OM-26 write-path fix',
              body: 'Summarise the provided notes.',
              frontmatter: { name: 'Legacy Skill' },
              source: 'import',
              sourcePath: null,
              contentHash: CONTENT_HASH,
              forkedFrom: null,
            }
          : undefined,
      ),
    // No deterministic verdict — the LLM row is the one under test.
    getSkillVerdict: () => Promise.resolve(undefined),
    getSkillVerdictByModel: () => Promise.resolve(legacyRow()),
    upsertSkillVerdict: () => Promise.resolve(),
    listSubAgentsBySkillId: () => Promise.resolve([]),
    listAgentsByPersonaSkillId: () => Promise.resolve([]),
  };
}

interface Harness {
  baseUrl: string;
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const graph = makeStubGraph();
  const config = {
    listAgents: () => Promise.resolve([]),
    getAgentBySlug: () => Promise.resolve(undefined),
  };

  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/operator',
    createAgentBuilderRouter({
      getConfigStore: () => config as never,
      getGraphStore: () => graph as never,
      getRegistry: () => undefined,
      getLlmVerifier: () =>
        Promise.resolve({
          modelId: MODEL_ID,
          promptHash: PROMPT_HASH,
          verify: () => Promise.reject(new Error('the scan must never run in this test')),
        } as never),
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Assert on the RAW response text — that is what leaves the process. */
function assertNoProviderInternals(raw: string, where: string): void {
  for (const forbidden of [
    'req_011CdcPnpMTB8iyAmMBnbem8',
    'request_id',
    'x-api-key',
    'authentication_error',
  ]) {
    assert.ok(
      !raw.includes(forbidden),
      `${where}: response body must not carry '${forbidden}' — got: ${raw.slice(0, 400)}`,
    );
  }
}

describe('OM-26 — the skill read path redacts legacy provider payloads', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  it('GET /skills/:id does not serve a persisted raw provider payload', async () => {
    h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/api/v1/operator/skills/${SKILL_ID}`);
    const raw = await res.text();

    assert.equal(res.status, 200);
    assertNoProviderInternals(raw, 'GET /skills/:id');

    // The verdict itself must still be served — redaction may not silently
    // erase the finding the operator needs to see.
    const body = JSON.parse(raw) as {
      verdict?: { llm?: { severity?: string; rationale?: string } };
    };
    assert.equal(body.verdict?.llm?.severity, 'scan_failed');
    // Redaction may not silently erase the finding: a legacy raw payload is
    // normalized to the generic code, which the UI renders as localized copy.
    assert.equal(body.verdict?.llm?.rationale, 'scan_failed:provider_error');
  });

  it('POST /skills/:id/verdict/llm-scan does not serve it either on a cache hit', async () => {
    h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/api/v1/operator/skills/${SKILL_ID}/verdict/llm-scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const raw = await res.text();

    assert.equal(res.status, 200);
    assertNoProviderInternals(raw, 'POST /verdict/llm-scan');
  });
});

describe('redactProviderInternals covers every correlation-handle shape', () => {
  // Kept in agreement with `REDACTIONS` in web-ui/app/_lib/scanFailure.ts.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['{"x-request-id":"abc123def456"}', 'abc123def456'],
    ['{"requestId":"7f3e9a1b2c4d"}', '7f3e9a1b2c4d'],
    ['{"trace_id":"0af7651916cd43dd"}', '0af7651916cd43dd'],
    ['{"correlation_id":"c0rr3l4t10n"}', 'c0rr3l4t10n'],
    ['{"cf-ray":"8f3a1b2c3d4e5f60-FRA"}', '8f3a1b2c3d4e5f60-FRA'],
    ['x-request-id: abc123def456', 'abc123def456'],
    ['trace_id: 0af7651916cd43dd', '0af7651916cd43dd'],
    ['cf-ray: 8f3a1b2c3d4e5f60-FRA', '8f3a1b2c3d4e5f60-FRA'],
    ['ctx req_011CdcPnpMTB8iyAmMBnbem8', 'req_011CdcPnpMTB8iyAmMBnbem8'],
    ['key sk-ant-api03-AAAABBBBCCCC', 'sk-ant-api03-AAAABBBBCCCC'],
  ];

  for (const [raw, secret] of cases) {
    it(`scrubs ${secret} from ${raw}`, () => {
      const out = redactProviderInternals(raw);
      assert.ok(!out.includes(secret), `still present: ${out}`);
      assert.ok(out.includes('[redacted]'));
    });
  }

  it('leaves an ordinary operator-facing rationale untouched', () => {
    const clean = 'The skill reads ~/.ssh/id_rsa and posts it to an external host.';
    assert.equal(redactProviderInternals(clean), clean);
  });
});

describe('sanitizeVerdictRationale', () => {
  it('replaces a legacy scan_failed payload wholesale, not token-by-token', () => {
    assert.equal(
      sanitizeVerdictRationale('scan_failed', LEGACY_RATIONALE),
      'scan_failed:provider_error',
    );
  });

  it('keeps a valid sentinel code exactly as stored', () => {
    assert.equal(sanitizeVerdictRationale('scan_failed', 'scan_failed:auth'), 'scan_failed:auth');
  });

  it('rejects an unknown code, so a near-miss cannot smuggle text through', () => {
    assert.equal(
      sanitizeVerdictRationale('scan_failed', 'scan_failed:auth 401 request_id req_abc123def'),
      'scan_failed:provider_error',
    );
  });

  it('keeps a genuine LLM judgment, scrubbing only the internals inside it', () => {
    const out = sanitizeVerdictRationale(
      'flagged',
      'The body embeds a key sk-ant-api03-AAAABBBBCCCC and exfiltrates it.',
    );
    assert.ok(out?.includes('exfiltrates it'), `judgment must survive: ${String(out)}`);
    assert.ok(!out?.includes('sk-ant-api03-AAAABBBBCCCC'));
  });

  it('passes a null rationale through', () => {
    assert.equal(sanitizeVerdictRationale('too_large_to_scan', null), null);
  });
});
