'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { ChevronDown, MessageCircleHeart, Sparkles, Wand2 } from 'lucide-react';

import { cn } from '../../../../_lib/cn';
import type { BuilderModelId, Draft } from '../../../../_lib/builderTypes';
import type { PersonaConfig } from '../../../../_lib/personaTypes';

import { PersonaPillar } from './PersonaPillar';
import { PreviewChatPane, type BuildStatusSnapshot } from './PreviewChatPane';
import { SimpleIntakePane } from './SimpleIntakePane';

interface SimpleWorkspaceProps {
  draft: Draft;
  /** Codegen model resolved from the draft (drives the intake stream). */
  model: BuilderModelId;
  /** Lifts preview build status up so the shared footer / publish gate
   *  stays in sync with the Extended view. */
  onBuildStatus: (status: BuildStatusSnapshot) => void;
  /** Persists a persona edit back into the draft state. */
  onPersonaPersisted: (next: PersonaConfig) => void;
  /** Shared `ask_user_choice` card hoisted by the Workspace bus. */
  pendingUserChoice?: {
    choiceId: string;
    question: string;
    options: ReadonlyArray<{
      value: string;
      label: string;
      description?: string;
    }>;
  } | null;
  onUserChoiceResolved?: () => void;
  /** Issue #224 — lifts the intake pane's in-flight flag so the Workspace
   *  can lock the view toggle while a build reply streams. */
  onIntakeStreamingChange?: (streaming: boolean) => void;
  /** Issue #224 — lifts the reduced preview pane's in-flight flag so the
   *  Workspace can lock the view toggle while a test reply streams. */
  onPreviewStreamingChange?: (streaming: boolean) => void;
}

// byte5 ease-out curve (mirrors --ease-out token) for entrance motion.
const EASE_OUT = [0.22, 0.61, 0.36, 1] as const;

/**
 * Simplified No-Code builder view (Einfach) — the default surface for
 * non-technical operators.
 *
 * Where the Extended {@link Workspace} exposes four resizable panes (a chat
 * with full tool transcript, a tabbed spec/slot/persona editor with a Monaco
 * source view, and a build-status footer), this view collapses the whole
 * flow into one calm, guided vertical column:
 *
 *   1. Beschreiben   — describe the assistant in plain language; progress
 *                      shows as a single breathing status line (no steps).
 *   2. Übersicht     — a friendly, non-technical summary plus an optional
 *                      "Persönlichkeit" section (the persona editor).
 *   3. Ausprobieren  — a reduced preview chat to test the assistant.
 *
 * The aesthetic leans on the byte5 brand's warmer register: a cyan hero
 * wash, the Days One display face, soft blue-tinted shadows, and staggered
 * entrance motion — no monospaced IDs, no uppercase tech labels. The draft
 * is kept fresh by the Workspace's SpecEventBus subscription, so this
 * component only reads the latest `draft` prop. All copy comes from the
 * `builder.simple` i18n namespace.
 */
export function SimpleWorkspace({
  draft,
  model,
  onBuildStatus,
  onPersonaPersisted,
  pendingUserChoice,
  onUserChoiceResolved,
  onIntakeStreamingChange,
  onPreviewStreamingChange,
}: SimpleWorkspaceProps): React.ReactElement {
  const t = useTranslations('builder.simple');
  const [personaOpen, setPersonaOpen] = useState(false);

  const { spec } = draft;
  const toolCount = spec.tools?.length ?? 0;
  const hasBeenBuilt = Boolean(spec.description) || toolCount > 0;

  return (
    <div className="flex w-full flex-col gap-6 pb-8">
      {/* Warm intro band — sets a welcoming, non-technical tone. */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE_OUT }}
        className="b5-hero-bg relative overflow-hidden rounded-lg px-6 py-6 shadow-[var(--shadow-sm)]"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-8 -top-10 size-40 rounded-full bg-white/40 blur-2xl"
        />
        <span className="inline-flex items-center gap-2 rounded-full bg-[color:var(--accent-subtle)] px-3 py-1 text-[12px] font-semibold text-[color:var(--accent)]">
          <Wand2 className="size-3.5" aria-hidden />
          {t('intro.badge')}
        </span>
        <h2 className="font-display mt-3 text-[26px] leading-tight">
          {t('intro.title')}
                  </h2>
        <p className="mt-2 max-w-[480px] text-[15px] leading-relaxed">
          {t('intro.subtitle')}
        </p>
      </motion.div>

      {/* The two interactive panes sit side by side on wide screens
          (describe on the left, try it out on the right) and stack on
          narrow ones. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* 1 — Intake */}
        <SimpleStepCard
          step={1}
          icon={<Sparkles className="size-4" aria-hidden />}
          title={t('step1.title')}
          subtitle={t('step1.subtitle')}
          delay={0.08}
        >
          <div className="h-[520px]">
            <SimpleIntakePane
              draftId={draft.id}
              model={model}
              initialTranscript={draft.transcript}
              pendingUserChoice={pendingUserChoice}
              onUserChoiceResolved={onUserChoiceResolved}
              {...(onIntakeStreamingChange
                ? { onStreamingChange: onIntakeStreamingChange }
                : {})}
            />
          </div>
        </SimpleStepCard>

        {/* 2 — Reduced preview */}
        <SimpleStepCard
          step={2}
          icon={<MessageCircleHeart className="size-4" aria-hidden />}
          title={t('step3.title')}
          subtitle={t('step3.subtitle')}
          delay={0.16}
        >
          <div className="h-[520px]">
            <PreviewChatPane
              draftId={draft.id}
              initialTranscript={draft.previewTranscript}
              setupFields={spec.setup_fields ?? []}
              onBuildStatus={onBuildStatus}
              {...(onPreviewStreamingChange
                ? { onStreamingChange: onPreviewStreamingChange }
                : {})}
            />
          </div>
        </SimpleStepCard>
      </div>

      {/* 3 — Reduced overview + persona, full width beneath the panes */}
      <SimpleStepCard
        step={3}
        icon={<Sparkles className="size-4" aria-hidden />}
        title={t('step2.title')}
        subtitle={t('step2.subtitle')}
        delay={0.24}
      >
        <div className="flex flex-col gap-4 px-6 py-6">
          <OverviewField label={t('overview.nameLabel')}>
            <span className="font-display text-[18px] text-[color:var(--fg-strong)]">
              {spec.name || t('overview.namePlaceholder')}
            </span>
          </OverviewField>

          <OverviewField label={t('overview.whatLabel')}>
            <span
              className={cn(
                'text-[15px] leading-relaxed',
                spec.description
                  ? 'text-[color:var(--fg-default)]'
                  : 'text-[color:var(--fg-subtle)]',
              )}
            >
              {spec.description || t('overview.whatPlaceholder')}
            </span>
          </OverviewField>

          {hasBeenBuilt ? (
            <div className="flex items-center gap-3 rounded-lg bg-[color:var(--bg-soft)] px-4 py-3 text-[14px] text-[color:var(--fg-muted)]">
              <span className="inline-flex size-7 items-center justify-center text-[color:var(--success)]">
                <Sparkles className="size-3.5" aria-hidden />
              </span>
              {toolCount > 0
                ? t('overview.readyTools', { count: toolCount })
                : t('overview.readyChat')}
            </div>
          ) : null}

          {/* Persona — opt-in, collapsed by default to keep things calm. */}
          <div className="overflow-hidden rounded-lg border border-[color:var(--divider)]">
            <button
              type="button"
              onClick={() => setPersonaOpen((v) => !v)}
              aria-expanded={personaOpen}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[color:var(--bg-soft)]"
            >
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--highlight)]/12 text-[color:var(--highlight)]">
                <MessageCircleHeart className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-[color:var(--fg-strong)]">
                  {t('persona.title')}
                </span>
                <span className="block text-[12.5px] text-[color:var(--fg-subtle)]">
                  {t('persona.subtitle')}
                </span>
              </span>
              <span className="rounded-full bg-[color:var(--bg-soft)] px-3 py-0.5 text-[11px] font-medium text-[color:var(--fg-subtle)]">
                {t('persona.optional')}
              </span>
              <ChevronDown
                className={cn(
                  'size-4 shrink-0 text-[color:var(--fg-subtle)] transition-transform duration-200',
                  personaOpen && 'rotate-180',
                )}
                aria-hidden
              />
            </button>
            {personaOpen ? (
              <div className="border-t border-[color:var(--divider)]">
                <PersonaPillar
                  draftId={draft.id}
                  initialPersona={spec.persona ?? {}}
                  {...(spec.quality ? { quality: spec.quality } : {})}
                  onPersisted={onPersonaPersisted}
                />
              </div>
            ) : null}
          </div>
        </div>
      </SimpleStepCard>
    </div>
  );
}

function OverviewField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <p className="text-[12px] font-semibold text-[color:var(--fg-subtle)]">{label}</p>
      <div className="mt-2 break-words">{children}</div>
    </div>
  );
}

function SimpleStepCard({
  step,
  icon,
  title,
  subtitle,
  delay,
  children,
}: {
  step: number;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  delay: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE_OUT, delay }}
      className="overflow-hidden rounded-lg border border-[color:var(--divider)] bg-[color:var(--bg-elevated)] shadow-[var(--shadow-md)]"
    >
      <header className="flex items-center gap-4 border-b border-[color:var(--divider)] px-6 py-4">
        <span className="lume-donut relative inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-[color:var(--accent)] text-[color:var(--accent)]">
          <span className="font-display text-[16px] leading-none">{step}</span>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[19px] leading-tight text-[color:var(--fg-strong)]">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 text-[13.5px] leading-snug text-[color:var(--fg-muted)]">
              {subtitle}
            </p>
          ) : null}
        </div>
        <span className="hidden size-9 items-center justify-center rounded-full bg-[color:var(--accent)]/8 text-[color:var(--accent)] sm:inline-flex">
          {icon}
        </span>
      </header>
      {children}
    </motion.section>
  );
}
