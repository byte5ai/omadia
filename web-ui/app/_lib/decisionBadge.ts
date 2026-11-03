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
}

const KNOWN_PROVIDERS: Readonly<Record<string, string>> = { jev: 'Jev' };
const MAX_TEXT = 80;

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
  return {
    provider: KNOWN_PROVIDERS[provider.toLowerCase()] ?? provider,
    ...(model !== undefined ? { model } : {}),
    state: verdict === 'model' ? 'model' : d['answered'] === true ? 'answered' : 'data',
    ...(route !== undefined ? { route } : {}),
    ...(tool !== undefined ? { tool } : {}),
    direct: d['direct'] === true,
    confidencePct: Math.round(Math.min(1, Math.max(0, confidence)) * 100),
    ms: Math.round(ms),
  };
}
