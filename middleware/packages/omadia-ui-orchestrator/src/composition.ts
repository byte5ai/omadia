import { validateTree } from './treeValidator.js';

/**
 * Tier-2 skeleton composition (PR-9b-2): one fast-model call turns the user's
 * request into (a) a schema-valid skeleton tree the client renders immediately
 * and (b) the data requirements the delegated main turn must satisfy — so
 * Tier-3 sub-agents return payloads matching exactly the fields the skeleton
 * promised.
 */

/** Narrow LLM port — structurally satisfied by `ctx.llm` (LlmAccessor); injected
 *  so composition is testable without network or SDK coupling. */
export interface CompositionLlm {
  complete(req: {
    model: string;
    system?: string;
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
  }): Promise<{ text: string }>;
}

/** What the skeleton promised the user — handed to the delegated main turn as
 *  the `[canvas-context]` block (the requirement-handoff contract). */
export interface DataRequirement {
  containerId: string;
  description: string;
  dataClass?: string;
  fields: Array<{ fieldKey: string; label: string; type?: string }>;
}

export interface SkeletonResult {
  tree: unknown;
  dataRequirements: DataRequirement[];
  source: 'model' | 'fallback';
}

export const FALLBACK_SKELETON = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [{ type: 'status', id: 'st', text: 'Working on it…', loading: 'spinner' }],
} as const;

const SYSTEM_PROMPT = `You are the Omadia UI Tier-2 composer. Given a user request, emit ONLY a JSON object:
{ "tree": <primitive tree>, "dataRequirements": [{ "containerId", "description", "dataClass"?, "fields": [{ "fieldKey", "label", "type"? }] }] }
The tree is a SKELETON for data still being fetched: data-carrying primitives use loading:"skeleton" and empty rows/items. Use only these primitives: container, heading, text, table, list, tree, button, input, choice, toggle, image, chart, form, toolbar, menubar, tabs, pane, status, progress, divider. Every container and data-carrying primitive needs a stable "id"; table columns need fieldKey+label. dataRequirements must name, per data-carrying container, exactly the fields the content agents must deliver. No prose, no markdown fences — raw JSON only.`;

/** Models routinely ignore "raw JSON only" and wrap the object in markdown
 *  fences or a prose preamble — extract the JSON payload before parsing. */
function extractJsonPayload(raw: string): string {
  let s = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fenced?.[1]) s = fenced[1].trim();
  if (!s.startsWith('{')) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  return s;
}

function parseResult(raw: string): { tree: unknown; dataRequirements: DataRequirement[] } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(extractJsonPayload(raw));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const { tree, dataRequirements } = obj as { tree?: unknown; dataRequirements?: unknown };
  if (tree === undefined) return null;
  const reqs = Array.isArray(dataRequirements)
    ? dataRequirements.filter(
        (r): r is DataRequirement =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as DataRequirement).containerId === 'string' &&
          Array.isArray((r as DataRequirement).fields),
      )
    : [];
  return { tree, dataRequirements: reqs };
}

/**
 * Compose the skeleton-first tree. One bounded repair retry on schema failure
 * (the retry prompt carries the validator errors); deterministic fallback after
 * that — composition must NEVER block or fail the turn.
 */
export async function composeSkeleton(opts: {
  llm: CompositionLlm;
  model: string;
  userText: string;
  /** observability for the never-throw contract: every fallback states why. */
  log?: (message: string) => void;
}): Promise<SkeletonResult> {
  const fallback: SkeletonResult = {
    tree: structuredClone(FALLBACK_SKELETON),
    dataRequirements: [{ containerId: 'root', description: opts.userText, fields: [] }],
    source: 'fallback',
  };

  let user = `User request: ${opts.userText}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: string;
    try {
      const result = await opts.llm.complete({
        model: opts.model,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: user }],
        maxTokens: 2048,
      });
      raw = result.text;
    } catch (err) {
      opts.log?.(
        `[composition] llm call failed → fallback skeleton: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fallback;
    }
    const parsed = parseResult(raw);
    if (!parsed) {
      opts.log?.(`[composition] attempt ${attempt + 1}: output not parseable as raw JSON`);
      user = `User request: ${opts.userText}\nYour previous output was not valid raw JSON. Emit ONLY the JSON object.`;
      continue;
    }
    const valid = validateTree(parsed.tree);
    if (valid.ok) {
      return { ...parsed, source: 'model' };
    }
    opts.log?.(`[composition] attempt ${attempt + 1}: tree schema-invalid: ${valid.errors}`);
    user = `User request: ${opts.userText}\nYour previous tree was schema-invalid: ${valid.errors}. Emit a corrected JSON object.`;
  }
  opts.log?.('[composition] both attempts schema-invalid → fallback skeleton');
  return fallback;
}
