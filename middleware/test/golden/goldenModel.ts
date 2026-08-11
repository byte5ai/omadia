/**
 * Golden-set regression runner — MODEL layer (#129).
 *
 * Split out of `goldenRunner.ts` on purpose: this is the only part that imports
 * the verifier package as a VALUE (real `ClaimExtractor` + `EvidenceJudge` +
 * `VerifierPipeline`), so it can only load once the workspace `dist/` is built.
 * Anything importing this file therefore needs the build; the pure harness logic
 * (voting, parsing, comparison) stays in `goldenRunner.ts` and does not.
 *
 * It wires a real `VerifierPipeline` — real ClaimExtractor + EvidenceJudge on an
 * injected `LlmProvider`, fixture-backed DeterministicChecker + EvidenceFetcher —
 * behind a `RunOnce`. The provider is injected, so this stays key-free: the CLI
 * (`goldenSet.eval.ts`) supplies the Anthropic adapter with a real key, while
 * `test/goldenModel.test.ts` supplies a stub provider and asserts the synthetic
 * (no-model-needed) block paths without spending a token.
 */

import {
  ClaimExtractor,
  DeterministicChecker,
  EvidenceJudge,
  VerifierPipeline,
  type EvidenceFetcher,
  type EvidenceSnippet,
  type SoftClaim,
  type VerifierInput,
} from '@omadia/verifier';
import type { LlmProvider } from '@omadia/llm-provider-api';

import type { EntryRun, GoldenEntry, RunOnce } from './goldenRunner.js';

function toVerifierInput(entry: GoldenEntry): VerifierInput {
  const t = entry.trace;
  return {
    runId: `golden_${entry.id}`,
    userMessage: entry.userMessage,
    answer: entry.answer,
    ...(t?.agent !== undefined ? { agent: t.agent } : {}),
    ...(t?.domainToolsCalled !== undefined
      ? { domainToolsCalled: t.domainToolsCalled }
      : {}),
    ...(t?.knowledgeGraphToolsCalled !== undefined
      ? { knowledgeGraphToolsCalled: t.knowledgeGraphToolsCalled }
      : {}),
    ...(t?.toolPostconditionViolations !== undefined
      ? { toolPostconditionViolations: t.toolPostconditionViolations }
      : {}),
  };
}

/** Fixture evidence source — returns the entry's frozen snippets for any claim,
 *  so the judge stage is deterministic in its INPUT while still stochastic in
 *  its VERDICT. */
function fixtureFetcher(evidence: EvidenceSnippet[]): EvidenceFetcher {
  return {
    fetch(_claim: SoftClaim): Promise<EvidenceSnippet[]> {
      return Promise.resolve(evidence);
    },
  };
}

function buildPipeline(
  llm: LlmProvider,
  model: string,
  evidence: EvidenceSnippet[],
): VerifierPipeline {
  return new VerifierPipeline({
    extractor: new ClaimExtractor({ llm, model }),
    // No odoo/graph reader: hard claims resolve to `unverified` rather than
    // hitting Postgres. The verdict-class fixtures never depend on
    // deterministic hard-claim verification (that path needs an Odoo fixture
    // reader — v2, see README).
    deterministic: new DeterministicChecker({}),
    judge: new EvidenceJudge({ llm, fetcher: fixtureFetcher(evidence), model }),
    log: (): void => {
      /* silent */
    },
  });
}

/**
 * Build a `RunOnce` backed by a real pipeline + injected provider. Wraps the
 * provider in a per-run token counter so the summary can report cost without
 * the pipeline having to surface usage.
 */
export function buildVerifierRunOnce(
  provider: LlmProvider,
  model: string,
): RunOnce {
  return async (entry: GoldenEntry): Promise<EntryRun> => {
    let tokens = 0;
    const counting: LlmProvider = {
      id: provider.id,
      capabilities: provider.capabilities,
      async complete(req) {
        const res = await provider.complete(req);
        tokens += res.usage.inputTokens + res.usage.outputTokens;
        return res;
      },
      stream: provider.stream.bind(provider),
      classifyError: provider.classifyError.bind(provider),
    };
    const pipeline = buildPipeline(counting, model, entry.evidence ?? []);
    const verdict = await pipeline.verify(toVerifierInput(entry));
    return { status: verdict.status, tokens };
  };
}
