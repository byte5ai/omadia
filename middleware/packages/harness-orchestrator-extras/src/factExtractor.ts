import type Anthropic from '@anthropic-ai/sdk';
import {
  factNodeId,
  type EntityRef,
  type FactIngest,
  type KnowledgeGraph,
} from '@omadia/plugin-api';

/**
 * Distills atomic subject-predicate-object facts out of a completed turn via
 * Haiku and persists them as `Fact` nodes in the knowledge graph with
 * `DERIVED_FROM` edges to the source Turn and `MENTIONS` edges to any
 * entities referenced in the turn.
 *
 * Fires after the turn has been fully persisted — we don't want a slow or
 * failing Haiku call to block the user-visible reply. Silent failures are
 * acceptable: a turn without facts isn't wrong, just less searchable.
 *
 * The prompt deliberately biases toward *stable* facts (conventions,
 * permanent numbers, ownership), not one-off observations. A chat turn like
 * "Umsatz 2025 war X" produces `byte5 | umsatz_2025 | <X €>`, not the raw
 * assistant prose. This keeps the Fact store dense and reusable.
 */

export interface FactExtractorOptions {
  anthropic: Anthropic;
  graph: KnowledgeGraph;
  /** Haiku model id. Cheap + fast; we pay one call per completed turn. */
  model?: string;
  /** Cap. The prompt asks for "up to N" — the model usually returns fewer. */
  maxFactsPerTurn?: number;
  /** Token budget for the extraction call. 512 is ample for up to ~10 facts. */
  maxTokens?: number;
  /** Fact confidence threshold. Haiku self-reports; we drop anything below. */
  minConfidence?: number;
  log?: (msg: string) => void;
}

export interface ExtractInput {
  turnId: string;
  userMessage: string;
  assistantAnswer: string;
  entityRefs: readonly EntityRef[];
}

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

interface HaikuFactShape {
  subject?: unknown;
  predicate?: unknown;
  object?: unknown;
  confidence?: unknown;
}

const DEFAULTS = {
  model: 'claude-haiku-4-5-20251001',
  maxFactsPerTurn: 6,
  maxTokens: 512,
  minConfidence: 0.6,
};

export class FactExtractor {
  private readonly opts: Required<Omit<FactExtractorOptions, 'anthropic' | 'graph' | 'log'>> & {
    anthropic: Anthropic;
    graph: KnowledgeGraph;
    log: (msg: string) => void;
  };

  constructor(opts: FactExtractorOptions) {
    this.opts = {
      anthropic: opts.anthropic,
      graph: opts.graph,
      model: opts.model ?? DEFAULTS.model,
      maxFactsPerTurn: opts.maxFactsPerTurn ?? DEFAULTS.maxFactsPerTurn,
      maxTokens: opts.maxTokens ?? DEFAULTS.maxTokens,
      minConfidence: opts.minConfidence ?? DEFAULTS.minConfidence,
      log:
        opts.log ??
        ((msg: string): void => {
          console.error(msg);
        }),
    };
  }

  /**
   * Extract + ingest. Returns the count actually persisted. Never throws —
   * every error path logs on stderr and falls through to a zero-count return.
   */
  async extractAndIngest(input: ExtractInput): Promise<number> {
    try {
      const facts = await this.extract(input);
      if (facts.length === 0) {
        this.opts.log(`[fact-extractor] 0 facts turn=${shortTurn(input.turnId)}`);
        return 0;
      }
      const entityIds = input.entityRefs.map((r) => `${r.system}:${r.model}:${String(r.id)}`);
      const ingests: FactIngest[] = facts.map((f) => ({
        factId: factNodeId(input.turnId, f.subject, f.predicate, f.object),
        sourceTurnId: input.turnId,
        subject: f.subject,
        predicate: f.predicate,
        object: f.object,
        confidence: f.confidence,
        ...(entityIds.length > 0 ? { mentionedEntityIds: entityIds } : {}),
      }));
      const result = await this.opts.graph.ingestFacts(ingests);
      this.opts.log(
        `[fact-extractor] ${String(facts.length)} facts turn=${shortTurn(input.turnId)} ins=${String(result.inserted)} upd=${String(result.updated)}`,
      );
      return result.factIds.length;
    } catch (err) {
      this.opts.log(
        `[fact-extractor] FAIL turn=${shortTurn(input.turnId)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Haiku-only. No graph I/O so tests can stub this. Returns [] on any
   * parser or API failure — the caller shouldn't care which.
   */
  async extract(input: ExtractInput): Promise<ExtractedFact[]> {
    if (input.userMessage.trim().length === 0 && input.assistantAnswer.trim().length === 0) {
      return [];
    }

    const system = `You distill durable, reusable facts out of a single chat turn between a user and an AI assistant at byte5 (a German software studio running on Odoo).

Output a JSON array of objects: {"subject": string, "predicate": string, "object": string, "confidence": number}. Return ONLY the JSON, no prose, no markdown fences.

Rules:
- Extract AT MOST ${String(this.opts.maxFactsPerTurn)} facts, usually 0–3.
- Prefer **stable, cross-session truths**: partner identities, department structure, ongoing commitments, agreed conventions. Skip one-off observations ("today the server was slow"), trivia, or restatements of the user's question.
- If the user stated a CORRECTION or a new rule ("immer auf Deutsch antworten", "Lilium ist ein Neukunde seit Q4"), capture it.
- Subject/predicate/object are SHORT strings. Subject is a named entity or scope (e.g. "byte5", "kunde:Lilium", "abteilung:Engineering"). Predicate is a verb or possessive phrase in snake_case (e.g. "umsatz_2025", "hat_ansprechpartner", "gilt_als"). Object is the value — a number with unit, a name, a date, a short phrase.
- Confidence is how sure you are the fact is stable and correct (0–1). Be strict: use <0.6 when the turn is speculative.
- If no durable facts → return [].

Example:
User: "Wer ist der Head of Engineering bei byte5?"
Assistant: "Das ist Max Müller, seit Januar 2024."
Output: [{"subject":"byte5","predicate":"head_of_engineering","object":"Max Müller","confidence":0.9},{"subject":"Max Müller","predicate":"rolle_seit","object":"2024-01","confidence":0.7}]`;

    const user = `USER MESSAGE:
${truncate(input.userMessage, 2000)}

ASSISTANT ANSWER:
${truncate(input.assistantAnswer, 4000)}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await this.opts.anthropic.messages.create({
      model: this.opts.model,
      max_tokens: this.opts.maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const raw = firstText(response).trim();
    if (raw.length === 0) return [];

    // Strip accidental code fences (Haiku is usually clean but defensive
    // parsing is cheap).
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      this.opts.log(
        `[fact-extractor] non-JSON response from Haiku (first 100 chars): ${cleaned.slice(0, 100)}`,
      );
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const out: ExtractedFact[] = [];
    for (const item of parsed.slice(0, this.opts.maxFactsPerTurn)) {
      if (!item || typeof item !== 'object') continue;
      const shape = item as HaikuFactShape;
      const subject = asString(shape.subject);
      const predicate = asString(shape.predicate);
      const object = asString(shape.object);
      const confidence = asConfidence(shape.confidence);
      if (!subject || !predicate || !object) continue;
      if (confidence < this.opts.minConfidence) continue;
      out.push({ subject, predicate, object, confidence });
    }
    return out;
  }
}

function asString(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, 200);
}

function asConfidence(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0.6;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstText(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return '';
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function shortTurn(turnId: string): string {
  return turnId.length > 60 ? `${turnId.slice(0, 60)}…` : turnId;
}
