'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Palaia Phase 8 (OB-77 Slice 4) — inline Nudge renderer for the dev UI.
 *
 * Parses the `<nudge>` block out of a tool_result.output string and
 * renders the hint + an optional CTA button below the cleaned tool
 * output. Mirrors the contract emitted by `serialiseNudge` in
 * `harness-orchestrator/src/nudgePipeline.ts`. The middleware's
 * `parseNudge` helper is the source of truth; this component duplicates
 * the parser locally because web-dev is a separate Next.js app and
 * doesn't import the kernel package.
 *
 * CTA click POSTs the pre-filled tool-call into a follow-up turn so the
 * agent picks it up on the next user message — mirrors the Teams
 * Action.Submit pattern (teamsNudge.ts) which surfaces the same data
 * via `value.toolName` / `value.toolArgs` on the bot side.
 *
 * Suppress link is a no-op stub today; OB-78's curate-cron will wire it
 * to a real `/api/admin/nudges/suppress` route. The button stays so the
 * UX intent is visible during dev review.
 */

interface ParsedCta {
  readonly label: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

interface ParsedNudge {
  readonly id: string;
  readonly text: string;
  readonly cta?: ParsedCta;
}

interface ParseResult {
  readonly cleaned: string;
  readonly nudge: ParsedNudge | null;
}

const NUDGE_BLOCK_REGEX =
  /<nudge\s+id="([^"]+)">\s*<text>([\s\S]*?)<\/text>(?:\s*<cta\s+label="([^"]+)"\s+tool="([^"]+)">\s*([\s\S]*?)\s*<\/cta>)?\s*<\/nudge>/;

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function parseNudgeBlock(content: string): ParseResult {
  if (!content.includes('<nudge ')) {
    return { cleaned: content, nudge: null };
  }
  const match = NUDGE_BLOCK_REGEX.exec(content);
  if (!match) {
    return { cleaned: content, nudge: null };
  }
  const [block, idAttr, textBody, ctaLabel, ctaTool, ctaArgsJson] = match;
  const id = decodeXml(idAttr ?? '');
  const text = decodeXml((textBody ?? '').trim());

  let cta: ParsedCta | undefined;
  if (ctaLabel !== undefined && ctaTool !== undefined && ctaArgsJson !== undefined) {
    try {
      const args = JSON.parse(ctaArgsJson) as Record<string, unknown>;
      cta = {
        label: decodeXml(ctaLabel),
        toolName: decodeXml(ctaTool),
        args,
      };
    } catch {
      cta = undefined;
    }
  }

  const cleaned = (
    content.slice(0, match.index) +
    content.slice(match.index + (block ?? '').length)
  )
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  const parsed: ParsedNudge = cta ? { id, text, cta } : { id, text };
  return { cleaned, nudge: parsed };
}

interface NudgeCardProps {
  nudge: ParsedNudge;
  /** Callback the host renders into a chat-side follow-up turn. When
   *  omitted, the CTA button still renders + acknowledges the click but
   *  doesn't dispatch anywhere — useful for static review. */
  onCtaClick?: (cta: ParsedCta) => void;
  /** Suppress link — placeholder until OB-78 lands the admin route. */
  onSuppressClick?: (nudgeId: string) => void;
}

export function NudgeCard({
  nudge,
  onCtaClick,
  onSuppressClick,
}: NudgeCardProps): React.ReactElement {
  const t = useTranslations('nudgeCard');
  const [acknowledged, setAcknowledged] = useState<boolean>(false);

  return (
    <div
      className={[
        'mt-2 rounded-md border bg-amber-50/70 px-3 py-2 text-[12px]',
        'border-amber-200 ring-1 ring-amber-100',
        'dark:border-amber-900/60 dark:bg-amber-950/30 dark:ring-amber-900/40',
      ].join(' ')}
    >
      <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-300">
        <span>💡</span>
        <span>{t('kicker')}</span>
        <span className="ml-auto font-mono text-[10px] font-normal text-amber-600/80 dark:text-amber-400/80">
          {nudge.id}
        </span>
      </div>
      <p className="whitespace-pre-wrap text-amber-900 dark:text-amber-100">
        {nudge.text}
      </p>
      <div className="mt-2 flex items-center gap-2">
        {nudge.cta ? (
          <button
            type="button"
            disabled={acknowledged}
            onClick={() => {
              if (!nudge.cta) return;
              setAcknowledged(true);
              onCtaClick?.(nudge.cta);
            }}
            className={[
              'rounded bg-amber-600 px-2 py-1 text-[11px] font-medium text-white',
              'transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60',
              'dark:bg-amber-500 dark:hover:bg-amber-400',
            ].join(' ')}
          >
            {acknowledged ? t('ackTriggered') : nudge.cta.label}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onSuppressClick?.(nudge.id)}
          className="text-[11px] text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
        >
          {t('suppress')}
        </button>
        {nudge.cta ? (
          <span
            className="ml-auto truncate font-mono text-[10px] text-amber-600/80 dark:text-amber-400/80"
            title={`${nudge.cta.toolName}(${JSON.stringify(nudge.cta.args)})`}
          >
            → {nudge.cta.toolName}
          </span>
        ) : null}
      </div>
    </div>
  );
}
