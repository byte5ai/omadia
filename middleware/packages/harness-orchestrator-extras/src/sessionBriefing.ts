import type { Pool } from 'pg';

import type {
  KnowledgeGraph,
  LoadSessionBriefingInput,
  SessionBriefingResult,
  SessionBriefingService,
} from '@omadia/plugin-api';

import {
  SESSION_SUMMARY_MARKER,
  type SessionSummaryGenerator,
} from './sessionSummaryGenerator.js';

/**
 * @omadia/orchestrator-extras — SessionBriefingService (palaia / OB-75).
 *
 * `sessionBriefing@1`-Provider. Lazy-on-demand Briefings für
 * Session-Continuity:
 *
 *   - **Resume-Mode** (newest non-marker turn < `resumeWindowMinutes`):
 *     letzten N Turns als Tail-Stream rendern. Kein LLM-Call.
 *   - **Briefing-Mode** (älter): bestehende oder frisch-generierte
 *     Bullet-Summary + offene Tasks. LLM-Call NUR wenn Summary fehlt
 *     oder älter als der jüngste non-marker Turn der Session.
 *   - **Empty**: keine non-marker Turns vorhanden → leerer String.
 *
 * Storage: regenerierte Summaries werden über `kg.ingestTurn` als
 * Turn mit `userMessage = '<session-summary>'`, `assistantAnswer =
 * <bullets>`, `entryType = 'process'` persistiert. Beim nächsten Load
 * wird die freshness gegen den jüngsten non-marker Turn geprüft.
 *
 * Open-Tasks-Lookup: optional via `pool` (graphPool@1). Ohne Pool
 * wird der Tasks-Block weggelassen (graceful degrade).
 */

export interface SessionBriefingServiceOptions {
  kg: KnowledgeGraph;
  summaryGenerator: SessionSummaryGenerator;
  /** Optional. Wenn nicht gesetzt, werden offene Tasks nicht
   *  gerendert. Pool kommt aus `graphPool@1` (KG-Neon-Plugin). */
  pool?: Pool;
  /** Tenant für SQL-Filter. Erforderlich wenn `pool` gesetzt. */
  tenantId?: string;
  /** Sliding-Window für den Resume-Mode in Minuten. Default 60. */
  resumeWindowMinutes?: number;
  /** Token-Budget Default falls Caller keins angibt. Default 1500. */
  defaultBudgetTokens?: number;
  /** Faustregel chars / token. Default 4 (Anthropic-üblich). */
  charsPerToken?: number;
  /** Tail-Tiefe für Resume + Summary-Generation. Default 10. */
  tailSize?: number;
  /** Optional log sink. Defaults to `console.error`. */
  log?: (msg: string) => void;
}

const DEFAULTS: Required<
  Omit<SessionBriefingServiceOptions, 'kg' | 'summaryGenerator' | 'pool' | 'tenantId' | 'log'>
> = {
  resumeWindowMinutes: 60,
  defaultBudgetTokens: 1500,
  charsPerToken: 4,
  tailSize: 10,
};

interface OpenTaskRow {
  external_id: string;
  scope: string;
  user_message: string;
  assistant_answer: string;
  time: string;
}

export function createSessionBriefingService(
  opts: SessionBriefingServiceOptions,
): SessionBriefingService {
  const log = opts.log ?? ((msg: string): void => { console.error(msg); });
  const cfg = {
    resumeWindowMinutes:
      opts.resumeWindowMinutes ?? DEFAULTS.resumeWindowMinutes,
    defaultBudgetTokens:
      opts.defaultBudgetTokens ?? DEFAULTS.defaultBudgetTokens,
    charsPerToken: opts.charsPerToken ?? DEFAULTS.charsPerToken,
    tailSize: opts.tailSize ?? DEFAULTS.tailSize,
  };

  return {
    async loadSessionBriefing(
      input: LoadSessionBriefingInput,
    ): Promise<SessionBriefingResult> {
      const budgetTokens = Math.max(1, input.budgetTokens ?? cfg.defaultBudgetTokens);
      const budgetChars = budgetTokens * Math.max(1, cfg.charsPerToken);

      // 1. Load session via KG. Backend returns null when scope is unknown.
      const session = await opts.kg.getSession(input.scope);
      if (!session) {
        return emptyResult(0);
      }

      // 2. Split turns into marker (summaries) + non-marker (real chat).
      const turns = session.turns.map((t) => ({
        externalId: String(t.turn.id),
        time: String(t.turn.props['time'] ?? ''),
        userMessage: String(t.turn.props['userMessage'] ?? ''),
        assistantAnswer: String(t.turn.props['assistantAnswer'] ?? ''),
      }));
      const summaryTurns = turns
        .filter((t) => t.userMessage === SESSION_SUMMARY_MARKER)
        .sort((a, b) => a.time.localeCompare(b.time));
      const realTurns = turns
        .filter((t) => t.userMessage !== SESSION_SUMMARY_MARKER)
        .sort((a, b) => a.time.localeCompare(b.time));

      if (realTurns.length === 0) {
        return emptyResult(0);
      }

      const newestRealTurn = realTurns[realTurns.length - 1];
      if (!newestRealTurn) {
        return emptyResult(0);
      }
      const newestRealAt = parseTime(newestRealTurn.time);
      const ageMinutes = newestRealAt
        ? (Date.now() - newestRealAt) / 60_000
        : Number.POSITIVE_INFINITY;

      // 3. Resume-Mode — newest non-marker turn ist frisch genug,
      //    Tail-Stream als Recap.
      if (ageMinutes < cfg.resumeWindowMinutes) {
        const tail = realTurns.slice(-cfg.tailSize);
        const text = renderResumeTail(tail, budgetChars);
        return {
          text,
          mode: 'resume',
          stats: {
            resumeTurns: tail.length,
            summaryFound: summaryTurns.length > 0,
            summaryRegenerated: false,
            openTasks: 0,
            tokensUsed: Math.ceil(text.length / cfg.charsPerToken),
          },
        };
      }

      // 4. Briefing-Mode — Summary refresh wenn nötig.
      const latestSummary =
        summaryTurns.length > 0
          ? summaryTurns[summaryTurns.length - 1]
          : undefined;
      const needsRegenerate =
        !latestSummary ||
        (newestRealTurn.time !== '' &&
          latestSummary.time !== '' &&
          latestSummary.time < newestRealTurn.time);

      let summaryText = latestSummary?.assistantAnswer ?? '';
      let regenerated = false;

      if (needsRegenerate) {
        try {
          const generated = await opts.summaryGenerator.generate({
            scope: input.scope,
            turns: realTurns.slice(-cfg.tailSize).map((t) => ({
              time: t.time,
              userMessage: t.userMessage,
              assistantAnswer: t.assistantAnswer,
            })),
          });
          if (generated.length > 0) {
            summaryText = generated;
            regenerated = true;
            // Persist as a process-type Turn so the next load finds it.
            // Stamped 1ms after newest real turn so freshness-check passes.
            const summaryTime = bumpTime(newestRealTurn.time);
            try {
              await opts.kg.ingestTurn({
                scope: input.scope,
                time: summaryTime,
                userMessage: SESSION_SUMMARY_MARKER,
                assistantAnswer: generated,
                entityRefs: [],
                entryType: 'process',
                ...(input.userId ? { userId: input.userId } : {}),
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log(`[session-briefing] persist summary failed (scope=${input.scope}): ${msg}`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[session-briefing] generator failed (scope=${input.scope}): ${msg}`);
        }
      }

      // 5. Open-Tasks lookup (optional, scope-filtered).
      const openTasks = await loadOpenTasks(
        opts.pool,
        opts.tenantId,
        input.scope,
        log,
      );

      // 6. Render briefing block.
      if (summaryText.length === 0 && openTasks.length === 0) {
        return {
          text: '',
          mode: 'empty',
          stats: {
            resumeTurns: 0,
            summaryFound: latestSummary !== undefined,
            summaryRegenerated: regenerated,
            openTasks: 0,
            tokensUsed: 0,
          },
        };
      }
      const text = renderBriefing(summaryText, openTasks, budgetChars);
      return {
        text,
        mode: 'briefing',
        stats: {
          resumeTurns: 0,
          summaryFound: latestSummary !== undefined,
          summaryRegenerated: regenerated,
          openTasks: openTasks.length,
          tokensUsed: Math.ceil(text.length / cfg.charsPerToken),
        },
      };
    },
  };

  function emptyResult(resumeTurns: number): SessionBriefingResult {
    return {
      text: '',
      mode: 'empty',
      stats: {
        resumeTurns,
        summaryFound: false,
        summaryRegenerated: false,
        openTasks: 0,
        tokensUsed: 0,
      },
    };
  }
}

async function loadOpenTasks(
  pool: Pool | undefined,
  tenantId: string | undefined,
  scope: string,
  log: (msg: string) => void,
): Promise<OpenTaskRow[]> {
  if (!pool || !tenantId) return [];
  try {
    const result = await pool.query<OpenTaskRow>(
      `
      SELECT
        external_id,
        scope,
        properties->>'userMessage'      AS user_message,
        properties->>'assistantAnswer'  AS assistant_answer,
        properties->>'time'             AS time
      FROM graph_nodes
      WHERE tenant_id = $1
        AND type = 'Turn'
        AND entry_type = 'task'
        AND task_status = 'open'
        AND scope = $2
      ORDER BY (properties->>'time') DESC
      LIMIT 10
      `,
      [tenantId, scope],
    );
    return result.rows;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[session-briefing] open-tasks lookup failed (scope=${scope}): ${msg}`);
    return [];
  }
}

function parseTime(iso: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function bumpTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return new Date().toISOString();
  return new Date(t + 1).toISOString();
}

function renderResumeTail(
  tail: ReadonlyArray<{
    time: string;
    userMessage: string;
    assistantAnswer: string;
  }>,
  budgetChars: number,
): string {
  const parts: string[] = ['## Resume — letzte Turns dieser Session'];
  let used = parts[0]?.length ?? 0;
  for (const t of tail) {
    const chunk = `- [${t.time}]\n  Nutzer: ${truncate(t.userMessage, 400)}\n  Assistent: ${truncate(t.assistantAnswer, 800)}`;
    if (used + chunk.length + 1 > budgetChars) break;
    parts.push(chunk);
    used += chunk.length + 1;
  }
  return parts.join('\n');
}

function renderBriefing(
  summaryText: string,
  openTasks: ReadonlyArray<OpenTaskRow>,
  budgetChars: number,
): string {
  const parts: string[] = [];
  let used = 0;
  if (summaryText.length > 0) {
    const block = `## Briefing — Zusammenfassung der vorherigen Session\n\n${summaryText.trim()}`;
    if (block.length + 1 <= budgetChars) {
      parts.push(block);
      used += block.length + 1;
    } else {
      parts.push(`${block.slice(0, budgetChars - 2)}…`);
      return parts.join('\n');
    }
  }
  if (openTasks.length > 0 && used < budgetChars) {
    const heading = '\n## Offene Tasks aus dieser Session';
    if (used + heading.length + 1 <= budgetChars) {
      parts.push(heading);
      used += heading.length + 1;
      for (const task of openTasks) {
        const u = (task.user_message ?? '').trim();
        const a = (task.assistant_answer ?? '').trim();
        const line = `- [${task.time}] ${truncate(u || '(ohne Frage)', 200)}${a.length > 0 ? ` → ${truncate(a, 200)}` : ''}`;
        if (used + line.length + 1 > budgetChars) break;
        parts.push(line);
        used += line.length + 1;
      }
    }
  }
  return parts.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
