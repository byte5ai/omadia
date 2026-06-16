/**
 * @omadia/orchestrator-extras — Palaia-Excerpt-Extractor (Slice 4a).
 *
 * Haiku-backed per-turn enrichment producing a {kind, summary,
 * rationale?, excerpts[]} suggestion that the chat-side save-as-memory
 * modal pre-fills with, and that the auto-promotion pipeline (Slice 4b)
 * hands to `createMemorableKnowledge` so both code-paths share the
 * same payload shape.
 *
 * Failure semantics (same as significanceScorer): every error is
 * caught here, logged on stderr (Fly drops stdout INFO), and the
 * extractor returns `undefined`. Callers must treat `undefined` as
 * "no enrichment available" — the modal falls back to its dumb
 * 240-char prefix, the auto-promotion pipeline does nothing.
 *
 * Hint precedence: when `entryTypeHint` is set (because the user
 * annotated the turn with `<palaia-hint type=…>`), we SKIP the Haiku
 * call entirely and synthesise a deterministic excerpt from the
 * assistant answer. The user's explicit annotation outranks LLM
 * re-classification.
 */

import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';
import type {
  EntryType,
  MemorableKind,
  PalaiaExcerpt,
  PalaiaExcerptExtractInput,
  PalaiaExcerptExtractor,
} from '@omadia/plugin-api';

export interface HaikuPalaiaExcerptExtractorOptions {
  /** Provider-agnostic LLM (Anthropic adapter today). Was `anthropic` pre-phase-2. */
  llm: LlmProvider;
  /** Anthropic model id. Default: `claude-haiku-4-5-20251001`. */
  model?: string;
  /** Token budget for the response. 512 fits 3-5 excerpts + summary + rationale. */
  maxTokens?: number;
  /** Optional log sink. Defaults to `console.error`. */
  log?: (msg: string) => void;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 512;

const MEMORABLE_KINDS: readonly MemorableKind[] = [
  'decision',
  'insight',
  'preference',
  'reference',
];

const MAX_SUMMARY_LEN = 500;
const MAX_RATIONALE_LEN = 2000;
const MAX_EXCERPTS = 5;
const MAX_EXCERPT_LEN = 300;

const SYSTEM_PROMPT = `You are a memory-curation assistant for a chat between a team member and an AI agent.

Given a single turn (user message + assistant answer), distil a SHORT save-as-memory suggestion the user could promote into a curated knowledge entry.

Output STRICT JSON with exactly these fields:
  {
    "kind":      "decision" | "insight" | "preference" | "reference",
    "summary":   string,           // 1-3 sentences, <=500 chars, neutral voice
    "rationale": string | null,    // optional context / caveats, <=2000 chars, or null
    "excerpts":  string[]          // 0-5 verbatim spans copied from the assistant answer, each <=300 chars
  }

Definitions:
  kind
    "decision"   — A choice was made or recommended ("we will use X", "go with Y").
    "insight"    — A non-obvious finding or learning ("turns out the API caps at 100/min").
    "preference" — A stated user/team preference ("always reply in German first").
    "reference"  — Stable, reusable lookup material that does NOT change per
                   request: how-to / SOP ("to deploy: run X then Y"), AND —
                   importantly — **data-model / schema / domain conventions**:
                   which table or entity holds which data, field names and
                   their meaning, entity-set names, how to filter/join, naming
                   rules. E.g. "Courses live in the Dynamics table ud_tutorial
                   (entitySet ud_tutorials); fields ud_name, ud_coursenumber,
                   ud_startdatetime; bookings in ud_booking". This kind of
                   learned structure is long-lived knowledge the agent must NOT
                   re-discover every session — classify it as "reference".
                   (A time-bound DATA snapshot — "29 courses next week" — is an
                   "insight", NOT a reference.)
  summary  — Stand-alone sentence(s) the user could read in /memories years later.
              Do NOT start with "The user asked about…" — describe the answer's substance.
  rationale — Why it matters / preconditions / caveats. Use null when redundant with summary.
  excerpts  — Pick the 0-5 sentences in the assistant answer that BEST support the summary.
              Copy verbatim (no reformatting). Order = document order top-to-bottom.

Reply with JSON only — NO markdown fence, NO commentary.`;

/** Build a `PalaiaExcerptExtractor` backed by an Anthropic Haiku call. */
export function createHaikuPalaiaExcerptExtractor(
  opts: HaikuPalaiaExcerptExtractorOptions,
): PalaiaExcerptExtractor {
  const model = opts.model?.trim() || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const log = opts.log ?? ((msg): void => console.error(msg));

  return {
    async extract(
      input: PalaiaExcerptExtractInput,
    ): Promise<PalaiaExcerpt | undefined> {
      const cleanedAnswer = input.cleanedAssistantAnswer.trim();
      // No assistant answer → nothing memorable. Skip the call.
      if (cleanedAnswer.length === 0) return undefined;

      // Hint precedence: user pre-classified via <palaia-hint type=…>.
      // Deterministic short-circuit — no LLM call, no risk of the model
      // overriding the user's explicit annotation.
      if (input.entryTypeHint !== undefined) {
        return {
          suggestedKind: mapEntryTypeToKind(input.entryTypeHint),
          suggestedSummary: clipText(cleanedAnswer, MAX_SUMMARY_LEN),
          excerpts: [],
          source: 'hint',
        };
      }

      const userBlock = input.cleanedUserMessage.trim();
      const turnPayload =
        userBlock.length > 0
          ? `<user>\n${userBlock}\n</user>\n<assistant>\n${cleanedAnswer}\n</assistant>`
          : `<assistant>\n${cleanedAnswer}\n</assistant>`;

      let response: LlmResponse;
      try {
        response = await opts.llm.complete({
          model,
          maxTokens,
          system: SYSTEM_PROMPT,
          messages: [textMessage('user', turnPayload)],
        });
      } catch (err) {
        log(
          `[excerpt-extractor] Haiku call failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }

      const replyText = collectText(response.content);
      if (!replyText) {
        log('[excerpt-extractor] empty response from Haiku');
        return undefined;
      }

      const parsed = parseJsonStrict(replyText);
      if (!parsed) {
        log(
          `[excerpt-extractor] non-JSON response: ${replyText.slice(0, 120)}…`,
        );
        return undefined;
      }

      return normalise(parsed, cleanedAnswer, log);
    },
  };
}

function normalise(
  raw: unknown,
  fallbackAnswer: string,
  log: (msg: string) => void,
): PalaiaExcerpt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  // Kind: must be in enum, fall back to 'insight' on miss/unknown so the
  // extractor never returns garbage to the modal.
  const rawKind = obj['kind'];
  const suggestedKind: MemorableKind = isMemorableKind(rawKind)
    ? rawKind
    : 'insight';
  if (!isMemorableKind(rawKind)) {
    log(`[excerpt-extractor] kind '${String(rawKind)}' invalid → 'insight'`);
  }

  // Summary: required, non-empty. Fall back to first 500 chars of the
  // answer when the model returned nothing usable.
  const rawSummary = obj['summary'];
  let suggestedSummary =
    typeof rawSummary === 'string' && rawSummary.trim().length > 0
      ? clipText(rawSummary.trim(), MAX_SUMMARY_LEN)
      : '';
  if (suggestedSummary.length === 0) {
    log('[excerpt-extractor] empty summary, falling back to answer prefix');
    suggestedSummary = clipText(fallbackAnswer, MAX_SUMMARY_LEN);
  }

  // Rationale: optional. Accept string, ignore null/missing.
  const rawRationale = obj['rationale'];
  const suggestedRationale =
    typeof rawRationale === 'string' && rawRationale.trim().length > 0
      ? clipText(rawRationale.trim(), MAX_RATIONALE_LEN)
      : undefined;

  // Excerpts: array of strings, cap count + length.
  const rawExcerpts = obj['excerpts'];
  const excerpts: string[] = Array.isArray(rawExcerpts)
    ? rawExcerpts
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .slice(0, MAX_EXCERPTS)
        .map((x) => clipText(x.trim(), MAX_EXCERPT_LEN))
    : [];

  return {
    suggestedKind,
    suggestedSummary,
    ...(suggestedRationale ? { suggestedRationale } : {}),
    excerpts,
    source: 'llm',
  };
}

function mapEntryTypeToKind(t: EntryType): MemorableKind {
  switch (t) {
    case 'memory':
      return 'insight';
    case 'process':
      return 'reference';
    case 'task':
      return 'decision';
  }
}

function isMemorableKind(v: unknown): v is MemorableKind {
  return typeof v === 'string' && (MEMORABLE_KINDS as readonly string[]).includes(v);
}

function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function parseJsonStrict(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
