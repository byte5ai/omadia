/**
 * The decision model's verdict for a chat turn (`done.fastPathDecision`,
 * e.g. TypeSafe Jev): the fast path asked it BEFORE any model call whether
 * the turn needs a language model or one data source answers it. Pure view
 * logic for `DecisionBadge`; the input is untrusted (persisted messages).
 */

export interface FastPathDecision {
  provider: string;
  model?: string;
  verdict: 'data' | 'model';
  route?: 'simple' | 'complex';
  tool?: string;
  confidence: number;
  ms: number;
  direct?: true;
  answered?: true;
  steps?: Array<{ task: string; choice: string; confidence: number; ms: number }>;
}

/** i18n key of a decision step's task (`chat.decision.task.*`). */
export type DecisionStepTask = 'gate' | 'data' | 'complex' | 'plan' | 'source' | 'direct' | 'slot' | 'layout' | 'other';

/** One decision-model answer for the hover list. `choiceKey` keys
 *  `chat.decision.choice.*`; without it `choice` is shown as is (a tool). */
export interface DecisionStepView {
  task: DecisionStepTask;
  choiceKey?: string;
  choice: string;
  confidencePct: number;
  ms: number;
}

/** What the chip shows. `state` keys the i18n label. */
export interface DecisionBadgeView {
  provider: string;
  model?: string;
  state: 'answered' | 'data' | 'model';
  route?: 'simple' | 'complex';
  tool?: string;
  direct: boolean;
  confidencePct: number;
  ms: number;
  /** every decision-model answer, in call order — absent when none came */
  steps?: DecisionStepView[];
}

const KNOWN_PROVIDERS: Readonly<Record<string, string>> = { jev: 'Jev' };
const MAX_TEXT = 80;
const MAX_STEPS = 8;

const TASKS: Readonly<Record<string, DecisionStepTask>> = {
  'fast-path.gate': 'gate',
  'fast-path.source': 'source',
  'fast-path.direct-plan': 'direct',
  'fast-path.turn-gate.data': 'data',
  'fast-path.turn-gate.complex': 'complex',
  'fast-path.turn-gate.plan': 'plan',
  'fast-path.turn-gate.source': 'source',
  'fast-path.turn-gate.direct': 'direct',
  'fast-path.turn-gate.slot': 'slot',
  'canvas.layout': 'layout',
};

const CHOICES = new Set([
  'yes', 'no', 'data', 'model_simple', 'model_complex', 'none', 'plan_new', 'value',
  'table', 'chart_bar', 'chart_line', 'chart_pie',
]);

function stepViews(raw: unknown): DecisionStepView[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_STEPS).flatMap((s): DecisionStepView[] => {
    if (typeof s !== 'object' || s === null) return [];
    const r = s as Record<string, unknown>;
    const task = text(r['task']);
    const choice = text(r['choice']);
    const { confidence, ms } = r;
    if (task === undefined || choice === undefined) return [];
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return [];
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return [];
    const choiceKey = choice.startsWith('plan:') ? 'plan' : CHOICES.has(choice) ? choice : undefined;
    return [
      {
        task: TASKS[task] ?? 'other',
        ...(choiceKey !== undefined ? { choiceKey } : {}),
        choice: choice.startsWith('tool:') ? choice.slice('tool:'.length) : choice,
        confidencePct: Math.round(Math.min(1, Math.max(0, confidence)) * 100),
        ms: Math.round(ms),
      },
    ];
  });
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, MAX_TEXT) : undefined;
}

/** The chip's view of a decision, or null for anything malformed. */
export function decisionBadgeView(raw: unknown): DecisionBadgeView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const provider = text(d['provider']);
  const verdict = d['verdict'];
  const confidence = d['confidence'];
  const ms = d['ms'];
  if (provider === undefined || (verdict !== 'data' && verdict !== 'model')) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const route = d['route'] === 'simple' || d['route'] === 'complex' ? d['route'] : undefined;
  const tool = text(d['tool']);
  const model = text(d['model']);
  const steps = stepViews(d['steps']);
  return {
    provider: KNOWN_PROVIDERS[provider.toLowerCase()] ?? provider,
    ...(model !== undefined ? { model } : {}),
    state: verdict === 'model' ? 'model' : d['answered'] === true ? 'answered' : 'data',
    ...(route !== undefined ? { route } : {}),
    ...(tool !== undefined ? { tool } : {}),
    direct: d['direct'] === true,
    confidencePct: Math.round(Math.min(1, Math.max(0, confidence)) * 100),
    ms: Math.round(ms),
    ...(steps.length > 0 ? { steps } : {}),
  };
}
