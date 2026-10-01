/**
 * A privacy service with #361 prompt masking switched on, for tests that
 * check what a turn puts on the wire. It masks every e-mail address at a
 * reserved `.example` domain through a per-turn surrogate map (stable within
 * a turn, like the real service), restores the map over the answer, and
 * reports each masked span on the turn's receipt. Everything else is a no-op
 * shield: tool results pass through unchanged.
 *
 * All values are synthetic.
 */

import type {
  PrivacyGuardService,
  PrivacyPromptMaskRequest,
  PrivacyPromptMaskResult,
  PrivacyReceipt,
  PromptMaskedSpanInfo,
} from '@omadia/plugin-api';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.example\b/g;

export interface PromptMaskingPrivacy {
  readonly service: PrivacyGuardService;
  /** Every text a turn asked to mask, in order. */
  readonly maskRequests: string[];
}

export interface PromptMaskingOptions {
  /** Answer `blocked` (failure-closed) for a text this returns true for. */
  readonly blockWhen?: (text: string) => boolean;
}

interface TurnState {
  readonly forward: Map<string, string>;
  readonly spans: PromptMaskedSpanInfo[];
}

/** The surrogate the n-th distinct address of a turn gets. */
export function surrogate(n: number): string {
  return `«email-${String(n)}»`;
}

export function promptMaskingPrivacy(options: PromptMaskingOptions = {}): PromptMaskingPrivacy {
  const turns = new Map<string, TurnState>();
  const turn = (turnId: string): TurnState => {
    let t = turns.get(turnId);
    if (!t) {
      t = { forward: new Map(), spans: [] };
      turns.set(turnId, t);
    }
    return t;
  };
  const restore = (t: TurnState | undefined, text: string): string => {
    let out = text;
    for (const [real, sur] of t?.forward ?? []) out = out.replaceAll(sur, real);
    return out;
  };
  const maskRequests: string[] = [];
  const service = {
    maskUserPrompt(request: PrivacyPromptMaskRequest): Promise<PrivacyPromptMaskResult> {
      maskRequests.push(request.text);
      if (options.blockWhen?.(request.text) === true) {
        return Promise.resolve({ outcome: 'blocked', reason: 'test: masking could not be guaranteed' });
      }
      const t = turn(request.turnId);
      const spans: PromptMaskedSpanInfo[] = [];
      const maskedText = request.text.replace(EMAIL, (real) => {
        let sur = t.forward.get(real);
        if (sur === undefined) {
          sur = surrogate(t.forward.size + 1);
          t.forward.set(real, sur);
        }
        spans.push({ type: 'email', detector: 'c0' });
        return sur;
      });
      t.spans.push(...spans);
      return Promise.resolve({ outcome: 'masked', maskedText, spans, degraded: false });
    },
    restorePromptPseudonyms(turnId: string, text: string): Promise<string> {
      return Promise.resolve(restore(turns.get(turnId), text));
    },
    snapshotPromptRestorer(turnId: string) {
      const t = turns.get(turnId);
      if (!t || t.forward.size === 0) return undefined;
      const copy: TurnState = { forward: new Map(t.forward), spans: [] };
      return (text: string) => restore(copy, text);
    },
    internToolResultV4(request: { toolName: string; rawResult: string }) {
      return Promise.resolve({ digestText: request.rawResult, datasetId: `ds-${request.toolName}` });
    },
    recordBypassedTool: () => Promise.resolve(),
    recordToolError: () => Promise.resolve(),
    redactToolErrorText: ({ text }: { text: string }) =>
      Promise.resolve({ outcome: 'redacted' as const, text, spans: [], degraded: false }),
    runV4Tool: () => Promise.resolve({ resultText: '' }),
    subAgentResultV4: (request: { narration: string }) => Promise.resolve({ resultText: request.narration }),
    takeRenderedAnswerV4: () => Promise.resolve(undefined),
    v4ToolSpecs: () => [],
    finalizeTurn(turnId: string): Promise<PrivacyReceipt | undefined> {
      const t = turns.get(turnId);
      turns.delete(turnId);
      if (!t) return Promise.resolve(undefined);
      return Promise.resolve({
        datasetsInterned: 0,
        fieldsMasked: 0,
        fieldsCleartext: 0,
        verbsExecuted: [],
        pseudonymProjectionUsed: false,
        ...(t.spans.length > 0 ? { maskedPromptSpans: [...t.spans] } : {}),
      });
    },
  } as unknown as PrivacyGuardService;
  return { service, maskRequests };
}
