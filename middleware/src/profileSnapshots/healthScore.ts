/**
 * Phase 2.3 — Health-Score Pure-Function (OB-65).
 *
 * Translates an asset-level diff (snapshot vs. live) into a 0-100 health
 * score plus operator-readable suggestions. Heuristic, NOT authoritative;
 * the UI surfaces this with a tooltip making clear it's a guidance signal,
 * not an automatic reject-trigger.
 *
 * Design notes:
 * - Pure function, zero IO. Trivially testable + safe to call from both the
 *   cron worker (computes + persists) and the UI (preview without writes).
 * - Score weighted by asset-path patterns. First match wins. Default
 *   fallback weight 0.1 ("noise") so rapid churn in low-signal files
 *   (e.g. operator-curated knowledge logs) doesn't scare the operator.
 * - Identical paths are excluded — only added/removed/modified matter.
 * - Suggestion-IDs are stable so the UI can dedupe and React keys are
 *   well-behaved. Don't rename them without coordinating UI + Notion.
 */

import type { AssetDiff } from './snapshotService.js';

export interface AssetWeight {
  /** Path patterns (substring match) → weight 0-1. Order matters: first
   *  match wins. Default fallback weight is 0.1 ("noise"). */
  pattern: string;
  weight: number;
}

export const DEFAULT_ASSET_WEIGHTS: ReadonlyArray<AssetWeight> = [
  { pattern: 'agent.md', weight: 1.0 },
  { pattern: 'knowledge/spec.json', weight: 0.8 },
  { pattern: 'plugins/', weight: 0.6 },
  { pattern: 'knowledge/', weight: 0.4 },
];

/** Implicit weight for any asset path not matched by an explicit pattern. */
export const FALLBACK_ASSET_WEIGHT = 0.1;

export interface HealthScoreInput {
  /** Result of `SnapshotService.diff(base=snapshot, target=live)`. */
  diffs: ReadonlyArray<AssetDiff>;
  /** Optional override; defaults to DEFAULT_ASSET_WEIGHTS. */
  weights?: ReadonlyArray<AssetWeight>;
}

export type DivergedAssetStatus = 'added' | 'removed' | 'modified';

export interface DivergedAsset {
  path: string;
  status: DivergedAssetStatus;
  weight: number;
}

export type SuggestionSeverity = 'info' | 'warn' | 'critical';

export interface HealthSuggestion {
  /** Stable ID — UI dedupes, React keys, telemetry filtering. */
  id: string;
  severity: SuggestionSeverity;
  message: string;
}

export interface HealthScoreResult {
  /** 0-100, integer. 100 = no drift, 0 = every weighted asset diverged. */
  score: number;
  /** Per-asset signal — drives the Suggestion-list and the UI tooltip. */
  divergedAssets: ReadonlyArray<DivergedAsset>;
  /** Operator-readable suggestions. Stable IDs for React keys. */
  suggestions: ReadonlyArray<HealthSuggestion>;
}

function weightFor(
  path: string,
  weights: ReadonlyArray<AssetWeight>,
): number {
  for (const w of weights) {
    if (path.includes(w.pattern)) return w.weight;
  }
  return FALLBACK_ASSET_WEIGHT;
}

function isDivergedStatus(
  s: AssetDiff['status'],
): s is DivergedAssetStatus {
  return s === 'added' || s === 'removed' || s === 'modified';
}

export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  const weights = input.weights ?? DEFAULT_ASSET_WEIGHTS;

  const diverged: DivergedAsset[] = [];
  for (const d of input.diffs) {
    if (!isDivergedStatus(d.status)) continue;
    diverged.push({
      path: d.path,
      status: d.status,
      weight: weightFor(d.path, weights),
    });
  }

  // Score = 100 - sum(weights) * 100 / max(totalAddressableWeight, 1).
  // The "max addressable weight" is the maximum weight any single asset
  // could carry (i.e. the heaviest weight pattern). This anchors the
  // ratio so a single agent.md-drift drops the score by ~100 (every
  // critical asset diverged), while a single noise-file drift drops it
  // only marginally — independent of how many assets exist.
  const maxWeight = Math.max(
    FALLBACK_ASSET_WEIGHT,
    ...weights.map((w) => w.weight),
  );
  const summed = diverged.reduce((acc, d) => acc + d.weight, 0);
  const rawScore = 100 - (summed * 100) / maxWeight;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const suggestions = buildSuggestions(diverged, score);

  return { score, divergedAssets: diverged, suggestions };
}

function buildSuggestions(
  diverged: ReadonlyArray<DivergedAsset>,
  score: number,
): HealthSuggestion[] {
  const out: HealthSuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: HealthSuggestion): void => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push(s);
  };

  for (const d of diverged) {
    if (d.path.includes('agent.md')) {
      push({
        id: 'agent-md-modified',
        severity: 'critical',
        message: 'Persona/Quality drifted — Snapshot aktualisieren',
      });
    } else if (d.path.includes('plugins/')) {
      push({
        id: 'plugins-modified',
        severity: 'critical',
        message: 'Pin-Drift — Plugin neu vendored seit Snapshot',
      });
    } else if (d.path.includes('knowledge/')) {
      push({
        id: 'knowledge-modified',
        severity: 'warn',
        message: 'Operator-Knowledge drifted seit letztem Deploy',
      });
    }
  }

  if (score < 30) {
    push({
      id: 'score-critical',
      severity: 'critical',
      message: 'Live-State unterscheidet sich substantiell vom letzten Deploy',
    });
  } else if (score < 70) {
    push({
      id: 'score-warn',
      severity: 'warn',
      message: 'Erheblicher Drift — Re-Snapshot empfohlen',
    });
  }

  return out;
}
