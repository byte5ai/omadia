/**
 * @omadia/orchestrator-extras — CaptureFilter (palaia Phase 2 / OB-71).
 *
 * Pure-logic classifier that runs *before* `KnowledgeGraph.ingestTurn` to
 *
 *   1. strip `<private>...</private>` blocks (DSGVO hygiene — sensitive
 *      content must never reach the embedding sidecar or LLM scorers),
 *   2. parse + remove inline `<palaia-hint .../>` markers (operator-driven
 *      classification override; tags must NOT pollute the embedding text),
 *   3. (optionally) call out to a Significance-Scorer (`level=normal` or
 *      `aggressive`) to receive a `[0,1]` score + `entry_type` suggestion,
 *   4. merge Hint > Scorer > Workspace-Default to produce the final
 *      `CaptureFilterDecision` (visibility, entry_type, significance,
 *      shouldEmbed, persist).
 *
 * Eckpfeiler (HANDOFF · OB-71):
 *   - Default level is `'minimal'`: privacy + hint stripping run, scorer
 *     does NOT run, no turn is dropped.
 *   - `'off'` is an explicit escape-hatch (backup-replay) — NO cleanup,
 *     ungestripped text flows 1:1 into the inner KG.
 *   - LLM scorer failures are non-fatal: the turn is persisted with
 *     `significance=null` and the default classification.
 *   - Hints are ALWAYS stripped (even at `'minimal'` and pass-through),
 *     so the embedding text never contains `<palaia-hint />` tokens.
 *   - Privacy blocks are stripped BEFORE every external call (scorer +
 *     downstream embedding).
 */

import type { EntryType, Visibility } from '@omadia/plugin-api';

/** Capture-Level controls scorer activation + drop behaviour. */
export type CaptureLevel = 'off' | 'minimal' | 'normal' | 'aggressive';

/** Significance-Scorer surface. Implementations: Haiku-based factory in
 *  `significanceScorer.ts`. Returns a `[0,1]` score plus an optional
 *  `entry_type` suggestion. Errors are caught by the filter; the turn is
 *  still persisted with `significance=null` + default classification. */
export interface SignificanceScorer {
  score(text: string): Promise<{
    score: number;
    suggestedEntryType?: EntryType;
  }>;
}

export interface CaptureFilterDeps {
  /** Optional — only consulted at `level === 'normal' | 'aggressive'`. */
  significanceScorer?: SignificanceScorer;
  captureLevel: CaptureLevel;
  /** Default visibility when neither hint nor LLM provides one. */
  defaultVisibility: Visibility;
  /** Threshold below which a turn is dropped at `level=normal/aggressive`.
   *  HANDOFF defaults: `0.2` for normal, `0.5` for aggressive. The bootstrap
   *  picks the right number per level when the operator hasn't overridden
   *  it; passing it here keeps the filter ignorant of level-specific defaults. */
  significanceThreshold: number;
  /** Optional log sink. Defaults to `console.error`. */
  log?: (msg: string) => void;
}

export interface CaptureFilterDecision {
  /** Persist the turn at all? `false` only at `level=normal|aggressive`
   *  with sub-threshold significance and no force-hint. */
  persist: boolean;
  /** Final entry_type to write. */
  entryType: EntryType;
  /** [0,1] significance, or null if scorer was skipped/failed. */
  significance: number | null;
  /** Final visibility. Hint > LLM > workspace-default. */
  visibility: Visibility;
  /** Should the embedding be computed? Workspace setting + classification.
   *  Always `true` at the moment — kept on the wire so a future setting
   *  ("don't embed `process` rows") can flip it without a schema change. */
  shouldEmbed: boolean;
  /** Cleaned user message (privacy + hints stripped). */
  cleanUserMessage: string;
  /** Cleaned assistant answer. */
  cleanAssistantAnswer: string;
  /** Marker reasons for observability log. */
  reasons: readonly string[];
}

/** Inline marker the operator/agent emits to override classification.
 *
 *   `<palaia-hint type="task" visibility="private" project="acme" force="true" />`
 *
 * `force="true"` instructs the filter to skip the Significance-Scorer
 * (we trust the explicit hint). All hint tags are stripped from the
 * persisted text regardless of level. */
interface ParsedHint {
  type?: EntryType;
  visibility?: Visibility;
  project?: string;
  force: boolean;
}

const PRIVATE_BLOCK_RE = /<private>[\s\S]*?<\/private>/gi;
const HINT_TAG_RE = /<palaia-hint\b[^>]*\/>/gi;
// Attribute parser: `key="value"` (double-quoted only — keeps the regex
// total). Plays well with arbitrary attribute order.
const HINT_ATTR_RE = /(\w+)="([^"]*)"/g;

/** Strip `<private>...</private>` blocks from a single string. Multi-line
 *  via `[\s\S]`, non-greedy so adjacent blocks don't merge. */
export function stripPrivacy(text: string): {
  cleaned: string;
  blocksStripped: number;
} {
  let blocksStripped = 0;
  const cleaned = text.replace(PRIVATE_BLOCK_RE, () => {
    blocksStripped += 1;
    return '';
  });
  return { cleaned, blocksStripped };
}

/** Extract every `<palaia-hint />` tag from a single string. The first hint
 *  wins on conflicting attributes (operator-deterministic order). All tags
 *  are removed from the returned `cleaned` text. */
export function parseHints(text: string): {
  cleaned: string;
  hints: ParsedHint[];
  tagsStripped: number;
} {
  const hints: ParsedHint[] = [];
  let tagsStripped = 0;
  const cleaned = text.replace(HINT_TAG_RE, (tag) => {
    tagsStripped += 1;
    const hint: ParsedHint = { force: false };
    HINT_ATTR_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HINT_ATTR_RE.exec(tag)) !== null) {
      const key = match[1];
      const value = match[2];
      if (key === undefined || value === undefined) continue;
      switch (key.toLowerCase()) {
        case 'type':
          if (value === 'memory' || value === 'process' || value === 'task') {
            hint.type = value;
          }
          break;
        case 'visibility':
          if (
            value === 'private' ||
            value === 'team' ||
            value === 'public' ||
            value.startsWith('shared:')
          ) {
            hint.visibility = value as Visibility;
          }
          break;
        case 'project':
          hint.project = value;
          break;
        case 'force':
          hint.force = value.toLowerCase() === 'true';
          break;
        default:
          // Forward-compatible: unknown attributes are tolerated, ignored.
          break;
      }
    }
    hints.push(hint);
    return '';
  });
  return { cleaned, hints, tagsStripped };
}

/** Merge a list of hints into a single override view. First non-undefined
 *  attribute wins (operator-deterministic order); `force` is OR'd. */
function mergeHints(hints: readonly ParsedHint[]): ParsedHint {
  const merged: ParsedHint = { force: false };
  for (const h of hints) {
    if (merged.type === undefined && h.type !== undefined) merged.type = h.type;
    if (merged.visibility === undefined && h.visibility !== undefined) {
      merged.visibility = h.visibility;
    }
    if (merged.project === undefined && h.project !== undefined) {
      merged.project = h.project;
    }
    if (h.force) merged.force = true;
  }
  return merged;
}

export class CaptureFilter {
  private readonly deps: CaptureFilterDeps;
  private readonly log: (msg: string) => void;

  constructor(deps: CaptureFilterDeps) {
    this.deps = deps;
    this.log = deps.log ?? ((msg): void => console.error(msg));
  }

  /** Classify a single turn. Pure-ish: only side-effect is the optional
   *  scorer call (which is itself failure-tolerant). */
  async classify(input: {
    userMessage: string;
    assistantAnswer: string;
  }): Promise<CaptureFilterDecision> {
    const { captureLevel, defaultVisibility, significanceThreshold } =
      this.deps;
    const reasons: string[] = [];

    // ---------- Capture-Level: 'off' is the explicit escape-hatch. ----------
    // No stripping, no scorer, no drop. Used for backup-replay where the
    // raw `<private>` tags must survive 1:1 into the inner KG.
    if (captureLevel === 'off') {
      reasons.push('level=off:passthrough');
      return {
        persist: true,
        entryType: 'memory',
        significance: null,
        visibility: defaultVisibility,
        shouldEmbed: true,
        cleanUserMessage: input.userMessage,
        cleanAssistantAnswer: input.assistantAnswer,
        reasons: Object.freeze(reasons),
      };
    }

    // ---------- Steps 1+2: Privacy-Strip (always) + Hint-Parse (always) ----
    const userPrivacy = stripPrivacy(input.userMessage);
    const assistantPrivacy = stripPrivacy(input.assistantAnswer);
    const userHints = parseHints(userPrivacy.cleaned);
    const assistantHints = parseHints(assistantPrivacy.cleaned);

    const cleanUserMessage = userHints.cleaned;
    const cleanAssistantAnswer = assistantHints.cleaned;

    const totalPrivateBlocks =
      userPrivacy.blocksStripped + assistantPrivacy.blocksStripped;
    const totalHintTags = userHints.tagsStripped + assistantHints.tagsStripped;
    if (totalPrivateBlocks > 0 || totalHintTags > 0) {
      reasons.push(
        `stripped privacy=${String(totalPrivateBlocks)} hints=${String(totalHintTags)}`,
      );
    }

    const mergedHint = mergeHints([...userHints.hints, ...assistantHints.hints]);

    // ---------- Step 3: Capture-Level gate (minimal = no scorer / no drop) -
    if (captureLevel === 'minimal') {
      reasons.push('level=minimal:no-scorer');
      return {
        persist: true,
        entryType: mergedHint.type ?? 'memory',
        significance: null,
        visibility: mergedHint.visibility ?? defaultVisibility,
        shouldEmbed: true,
        cleanUserMessage,
        cleanAssistantAnswer,
        reasons: Object.freeze(reasons),
      };
    }

    // ---------- Step 4: Significance-Scorer (normal | aggressive) ----------
    let significance: number | null = null;
    let suggestedEntryType: EntryType | undefined;
    const skipScorer =
      mergedHint.force === true || this.deps.significanceScorer === undefined;

    if (skipScorer) {
      reasons.push(
        mergedHint.force
          ? 'force-hint:scorer-skipped'
          : 'no-scorer:scorer-skipped',
      );
    } else {
      try {
        const scorerInput =
          `${cleanUserMessage}\n\n${cleanAssistantAnswer}`.trim();
        const result = await this.deps.significanceScorer!.score(scorerInput);
        if (Number.isFinite(result.score)) {
          significance = Math.max(0, Math.min(1, result.score));
          suggestedEntryType = result.suggestedEntryType;
          reasons.push(`scored=${significance.toFixed(2)}`);
        } else {
          reasons.push('scorer-non-finite:significance=null');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(
          `[capture-filter] scorer-failed (turn persisted with default classification): ${msg}`,
        );
        reasons.push('scorer-error:significance=null');
      }
    }

    // ---------- Step 5: Decision-merge (hint > scorer > default) ----------
    const entryType: EntryType =
      mergedHint.type ?? suggestedEntryType ?? 'memory';
    const visibility: Visibility = mergedHint.visibility ?? defaultVisibility;

    let persist = true;
    if (
      !mergedHint.force &&
      significance !== null &&
      significance < significanceThreshold
    ) {
      persist = false;
      reasons.push(
        `dropped:score(${significance.toFixed(2)})<threshold(${significanceThreshold.toFixed(2)})`,
      );
    }

    return {
      persist,
      entryType,
      significance,
      visibility,
      shouldEmbed: persist,
      cleanUserMessage,
      cleanAssistantAnswer,
      reasons: Object.freeze(reasons),
    };
  }
}

/** Default thresholds per level — used by the bootstrap when the operator
 *  hasn't overridden `capture_significance_threshold`. */
export function defaultThresholdForLevel(level: CaptureLevel): number {
  switch (level) {
    case 'aggressive':
      return 0.5;
    case 'normal':
      return 0.2;
    default:
      return 0;
  }
}
