import { createHash } from 'node:crypto';

import type {
  Nudge,
  NudgeEvaluationInput,
  NudgeProvider,
  ProcessMemoryService,
  ReadonlyToolTraceEntry,
} from '@omadia/plugin-api';

/**
 * Palaia Phase 8 (OB-77 Slice 3e) — `palaia.process-promote`.
 *
 * Lead-Use-Case heuristic. Detects multi-step, multi-domain workflows
 * after they finish and nudges the agent to call `write_process` so
 * future runs can be auto-replayed via `run_stored_process`.
 *
 * Trigger (all must hold):
 *   1. ≥2 successful tool-calls in the current turn
 *   2. ≥2 distinct domains across those tool-calls (meta-tools without
 *      a domain don't count — that's intentional, see PluginContext
 *      doc-block + Slice 3a)
 *   3. The canonical-query-hash (= sha256 of `userMessage + sorted
 *      tool-names`) hasn't already been promoted (best-effort
 *      processMemory.query lookup; skipped when no `processMemory@1`
 *      provider is published, in which case the nudge fires unguarded)
 *
 * Lifecycle is owned by the pipeline (NudgeStateStore reads + retire-at-
 * streak-3 + suppress-at-regression-3); the provider stays stateless.
 */

export const PROCESS_PROMOTE_NUDGE_ID = 'palaia.process-promote';

/** Title-derivation templates. Order matters: first regex hit wins. */
const TITLE_TEMPLATES: ReadonlyArray<{ pattern: RegExp; title: string }> = [
  // HR-Audit: vacation-rule compliance check (live use-case 2026-05-08).
  {
    pattern: /wie hat .+ die ([\wäöüß-]+)[\s-]?regeln eingehalten/i,
    title: 'HR-Audit: $1-Compliance',
  },
  // Generic compliance audit.
  {
    pattern: /(audit|compliance|einhaltung|compliance-check)/i,
    title: 'Audit: Compliance-Check',
  },
  // Backend / deploy.
  {
    pattern: /\b(deploy(ment|en)?|rollout|release)\b/i,
    title: 'Backend: Deployment',
  },
  // Generic data lookup spanning domains.
  {
    pattern: /\b(report|bericht|auswertung|analyse)\b/i,
    title: 'Reporting: Cross-Domain-Auswertung',
  },
  // Onboarding / setup playbooks.
  {
    pattern: /\b(onboarding|setup-?guide|einrichtung)\b/i,
    title: 'Onboarding: Setup-Playbook',
  },
];

/**
 * Per-domain step renderer. The map is intentionally small + opinionated —
 * adding a new entry is a one-line change. Tools without a mapping render
 * as `"<verb> via {toolName}: {arg-summary}"` which is good enough for the
 * agent to recognise and edit later via `edit_process`.
 */
const DOMAIN_STEP_TEMPLATES: Record<string, (entry: ReadonlyToolTraceEntry) => string> = {
  confluence: () => 'Confluence-Playbook konsultieren',
  'odoo.hr': () => 'Odoo HR-Daten abrufen',
  'odoo.accounting': () => 'Odoo Accounting-Daten abrufen',
  odoo: () => 'Odoo-Daten abrufen',
  'm365.calendar': () => 'M365-Kalender abfragen',
  'm365.sharepoint': () => 'M365-SharePoint abfragen',
  m365: () => 'Microsoft-365-Daten abrufen',
  'web.search': () => 'Web-Recherche durchführen',
  github: () => 'GitHub-Daten abrufen',
  seo: () => 'SEO-Audit durchführen',
};

/** Trace entries the multi-domain trigger ignores entirely. */
function isCountableEntry(entry: ReadonlyToolTraceEntry): boolean {
  if (entry.status !== 'ok') return false;
  if (!entry.domain) return false;
  return true;
}

function distinctDomains(trace: readonly ReadonlyToolTraceEntry[]): string[] {
  const seen = new Set<string>();
  for (const e of trace) {
    if (isCountableEntry(e) && e.domain) seen.add(e.domain);
  }
  return Array.from(seen).sort();
}

function deriveTitle(userMessage: string): string | null {
  const trimmed = userMessage.trim();
  for (const tpl of TITLE_TEMPLATES) {
    const match = tpl.pattern.exec(trimmed);
    if (match) {
      // Resolve $1 etc. by replacing back into the title pattern.
      return tpl.title.replace(/\$(\d+)/g, (_full, idx: string) => {
        const captured = match[Number(idx)];
        if (!captured) return '';
        const trimmedCap = captured.trim();
        return trimmedCap.charAt(0).toUpperCase() + trimmedCap.slice(1);
      });
    }
  }
  return null;
}

function deriveSteps(trace: readonly ReadonlyToolTraceEntry[]): string[] {
  const steps: string[] = [];
  for (const entry of trace) {
    if (!isCountableEntry(entry)) continue;
    const tpl = entry.domain ? DOMAIN_STEP_TEMPLATES[entry.domain] : undefined;
    if (tpl) {
      steps.push(tpl(entry));
    } else {
      // Generic fallback: `<domain>-Daten abrufen`. Drops kebab-case to
      // a slightly readable form. Operator can edit_process to refine.
      const domainLabel = entry.domain ?? 'externe Quelle';
      steps.push(`${domainLabel}-Daten abrufen via ${entry.toolName}`);
    }
  }
  return steps;
}

function canonicalWorkflowHash(
  userMessage: string,
  trace: readonly ReadonlyToolTraceEntry[],
): string {
  const sortedNames = trace
    .filter(isCountableEntry)
    .map((e) => e.toolName)
    .sort()
    .join(',');
  const body = `${userMessage.trim().toLowerCase()}|${sortedNames}`;
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export interface ProcessPromoteProviderOptions {
  /** Provided by the orchestrator's `nudgeProcessMemory` injection. */
  readonly processMemory?: ProcessMemoryService;
  /** Cosine-similarity threshold for the alreadyPromoted check. Default 0.85. */
  readonly alreadyPromotedThreshold?: number;
  /** Test-friendly logger. Defaults to `console.error`. */
  readonly log?: (msg: string) => void;
}

const DEFAULT_ALREADY_PROMOTED_THRESHOLD = 0.85;

export class ProcessPromoteProvider implements NudgeProvider {
  readonly id = PROCESS_PROMOTE_NUDGE_ID;
  readonly priority = 100;

  private readonly processMemoryFromCtor: ProcessMemoryService | undefined;
  private readonly alreadyPromotedThreshold: number;
  private readonly log: (msg: string) => void;

  constructor(opts: ProcessPromoteProviderOptions = {}) {
    this.processMemoryFromCtor = opts.processMemory;
    this.alreadyPromotedThreshold =
      opts.alreadyPromotedThreshold ?? DEFAULT_ALREADY_PROMOTED_THRESHOLD;
    this.log = opts.log ?? ((msg) => console.error(msg));
  }

  async evaluate(input: NudgeEvaluationInput): Promise<Nudge | null> {
    const trace = input.turnContext.toolTrace;

    // Trigger 1: ≥2 successful, domain-bearing tool-calls.
    const countable = trace.filter(isCountableEntry);
    if (countable.length < 2) return null;

    // Trigger 2: ≥2 distinct domains.
    const domains = distinctDomains(countable);
    if (domains.length < 2) return null;

    // Compute hash now so it's available for both the dedup-check and
    // the emitted nudge's workflowHash.
    const workflowHash = canonicalWorkflowHash(
      input.turnContext.userMessage,
      countable,
    );

    // Trigger 3: skip when this canonical workflow was already promoted.
    // Falls back to "always allowed" when no processMemory is wired —
    // the lifecycle store still retires the nudge after success_streak=3.
    //
    // Race the probe against an internal sub-budget (300 ms): an
    // embedding-backed cosine query routinely takes 100-300 ms on a cold
    // cache, and the surrounding `NUDGE_PROVIDER_TIMEOUT_MS` budget
    // would otherwise abort the provider before we ever get to emit the
    // nudge. On timeout we treat the workflow as "not yet promoted" —
    // worst case the agent gets nudged about an already-saved process,
    // which the lifecycle's retire-after-3-follows still resolves.
    const processMemory = input.processMemory ?? this.processMemoryFromCtor;
    if (processMemory) {
      const probe = (async () => {
        try {
          return await processMemory.query({
            query: input.turnContext.userMessage,
            limit: 5,
          });
        } catch (err) {
          this.log(
            `[palaia.process-promote] processMemory.query failed (treating as not-promoted): ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }
      })();
      const timeout = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 300);
      });
      const hits = await Promise.race([probe, timeout]);
      if (hits) {
        const alreadyPromoted = hits.some(
          (h) => h.score >= this.alreadyPromotedThreshold,
        );
        if (alreadyPromoted) return null;
      }
    }

    // Build the nudge. Title-derivation may fail (no template matches the
    // user-question). In that case we emit a text-only nudge — no CTA, no
    // pre-filled write_process args — so the agent can still surface the
    // workflow but the operator has to type a title manually. That's the
    // documented "no-CTA-fallback" path from the HANDOFF.
    const title = deriveTitle(input.turnContext.userMessage);
    const steps = deriveSteps(countable);
    const sortedDomains = domains.join(', ');

    if (!title) {
      return {
        id: this.id,
        text: `Du hast eben einen mehrschrittigen Workflow ausgeführt (${sortedDomains}). Wenn du diesen Ablauf als Process speicherst, kannst du ihn später per \`run_stored_process\` einfach replayen — gib ihm einen Titel im Format "[Domain]: [Beschreibung]" und ruf \`write_process\` auf.`,
        successSignal: {
          kind: 'tool_call_after',
          toolName: 'write_process',
          withinTurns: 2,
        },
        workflowHash,
      };
    }

    const sessionScope = input.turnContext.sessionScope || 'default';

    return {
      id: this.id,
      text: `Du hast eben einen mehrschrittigen Workflow ausgeführt (${sortedDomains}). Soll ich das als Process speichern?`,
      cta: {
        label: 'Als Process speichern',
        toolCall: {
          name: 'write_process',
          arguments: {
            title,
            steps,
            scope: sessionScope,
          },
        },
      },
      successSignal: {
        kind: 'tool_call_after',
        toolName: 'write_process',
        withinTurns: 2,
      },
      workflowHash,
    };
  }
}
