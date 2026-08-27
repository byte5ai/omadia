'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  CONTEXT_MEMORY_MODES,
  getAgentContextMemory,
  parseContextMemoryMode,
  parseOperatorAgentErrorCode,
  setAgentContextMemory,
  type ContextMemoryMode,
} from '../../../../_lib/agents';
import { humanizeApiError } from '../../_components/AgentsDashboard';

interface AgentContextMemoryProps {
  /** Slug of the orchestrator whose rollout mode is edited. */
  readonly slug: string;
}

/**
 * Issue #899 (epic #860) — operator control for the W5 chat-context memory
 * ACL (`agents.context_memory`, migration 0050).
 *
 * W5 shipped the whole mechanism — scoping, the `/memories/contexts/` tree,
 * the promote route and its audit log — behind a per-agent column that had no
 * UI and no API. The only way to enable it was a hand-written `UPDATE`, which
 * made the wave inert in practice. This is the supported path.
 *
 * Two deliberate interaction choices:
 *
 *  - The control edits a DEDICATED endpoint (`PUT .../context-memory`), not a
 *    field on the dashboard's rename/enable PATCH. A memory-scope change
 *    should never ride along with an unrelated edit.
 *  - Switching AWAY from `off` requires an explicit acknowledgement of the
 *    three semantics below. They are not decoration: an operator who expects
 *    "the agent forgets across teams" but writes to a channel the plugin does
 *    not scope, or who expects API turns to reach the team tree, will read the
 *    result as a bug in the ACL rather than as its contract. Switching back to
 *    `off` needs no acknowledgement — the safe direction is never gated.
 *
 * The mode list is INTERSECTED with the server's `modes` array: the server can
 * take a mode away (an older middleware that does not accept `enforce-strict`
 * must not offer it), but it cannot add one, because a mode this bundle has no
 * label for cannot be rendered. Growing the union is therefore a deliberate UI
 * release, not an accident.
 *
 * Everything that arrives from the wire is narrowed through
 * `parseContextMemoryMode` before it reaches state — not only inside the API
 * client. A component that renders a security state should not inherit its
 * trust from a type annotation: the UI must never show "enforcing" for a value
 * the runtime routes as off, whatever the payload said.
 *
 * Error copy: the route emits machine codes as `{ error: '<code>' }`.
 * `parseOperatorAgentErrorCode` narrows them onto the `detailErrors.*`
 * catalogue; unknown failures render the localized fallback with the technical
 * detail as an ICU argument — raw bodies never reach the UI (i18n hard rule).
 */
export function AgentContextMemory(
  props: AgentContextMemoryProps,
): React.ReactElement {
  const t = useTranslations('operatorAgents');
  /** Mode as last confirmed by the server. `null` until the first load lands. */
  const [saved, setSaved] = useState<ContextMemoryMode | null>(null);
  const [modes, setModes] =
    useState<readonly ContextMemoryMode[]>(CONTEXT_MEMORY_MODES);
  const [selected, setSelected] = useState<ContextMemoryMode | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseOperatorAgentErrorCode(err);
      return code !== null
        ? t(`detailErrors.${code}`)
        : t('detailErrors.unknown', { detail: humanizeApiError(err) });
    },
    [t],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await getAgentContextMemory(props.slug);
      const mode = parseContextMemoryMode(res.mode);
      setSaved(mode);
      setSelected(mode);
      // Intersect, never union: an entry this bundle has no label for is
      // dropped rather than rendered. Falling back to the local constant when
      // nothing survives keeps an older or unexpected middleware from leaving
      // the operator with no control at all.
      const offered = CONTEXT_MEMORY_MODES.filter((m) => res.modes.includes(m));
      setModes(offered.length > 0 ? offered : CONTEXT_MEMORY_MODES);
      setError(null);
    } catch (err: unknown) {
      setError(localizeError(err));
    } finally {
      setLoading(false);
    }
  }, [props.slug, localizeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirty = selected !== null && saved !== null && selected !== saved;
  /**
   * The acknowledgement gate applies to ENABLING only — moving off `off`.
   * Tightening `enforce` → `enforce-strict` narrows an already-scoped agent,
   * and turning the ACL back off restores today's behaviour; neither is the
   * step whose semantics surprise an operator.
   */
  const needsAck = dirty && saved === 'off' && selected !== 'off';
  const canSave = dirty && (!needsAck || acknowledged) && !saving;

  const save = useCallback(async (): Promise<void> => {
    if (selected === null) return;
    setSaving(true);
    try {
      const res = await setAgentContextMemory(props.slug, selected);
      const applied = parseContextMemoryMode(res.mode);
      setSaved(applied);
      setSelected(applied);
      setAcknowledged(false);
      setError(null);
    } catch (err: unknown) {
      setError(localizeError(err));
      // Leave `selected` where the operator put it: re-reading the server
      // value here would erase the choice they are trying to make and hide
      // which mode the failed write was for.
    } finally {
      setSaving(false);
    }
  }, [props.slug, selected, localizeError]);

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{t('contextMemory.heading')}</h2>
        <span className="text-xs text-[color:var(--fg-muted)]">
          {saved === null
            ? t('contextMemory.stateUnknown')
            : t('contextMemory.stateSummary', {
                mode: t(`contextMemory.modes.${saved}.label`),
              })}
        </span>
      </div>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">
        {t('contextMemory.hint')}
      </p>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {error}
        </div>
      )}

      {loading && saved === null && !error && (
        <p className="text-sm text-[color:var(--fg-muted)]">
          {t('contextMemory.loading')}
        </p>
      )}

      {selected !== null && (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t('contextMemory.heading')}</legend>
            {modes.map((mode) => {
              return (
                <label
                  key={mode}
                  className="flex cursor-pointer items-start gap-2 rounded border border-[color:var(--border)]/60 p-2 text-sm"
                >
                  <input
                    type="radio"
                    className="mt-1"
                    name={`context-memory-${props.slug}`}
                    value={mode}
                    checked={selected === mode}
                    disabled={saving}
                    onChange={() => {
                      setSelected(mode);
                      // Every change re-arms the gate: an acknowledgement
                      // given for one mode must not carry over to another.
                      setAcknowledged(false);
                    }}
                  />
                  <span>
                    <span className="font-medium text-[color:var(--fg-strong)]">
                      {t(`contextMemory.modes.${mode}.label`)}
                    </span>
                    <span className="block text-xs text-[color:var(--fg-muted)]">
                      {t(`contextMemory.modes.${mode}.description`)}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {needsAck && (
            <div
              role="note"
              className="mt-3 rounded border border-[color:var(--border)] bg-[color:var(--bg)] p-3 text-xs"
            >
              <p className="mb-2 font-medium text-[color:var(--fg-strong)]">
                {t('contextMemory.semanticsHeading')}
              </p>
              <ul className="mb-3 flex list-disc flex-col gap-1 pl-4 text-[color:var(--fg-muted)]">
                <li>{t('contextMemory.semanticsTeam')}</li>
                <li>{t('contextMemory.semanticsAgent')}</li>
                <li>{t('contextMemory.semanticsApi')}</li>
              </ul>
              <label className="flex cursor-pointer items-start gap-2 text-[color:var(--fg-strong)]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={acknowledged}
                  disabled={saving}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>{t('contextMemory.acknowledge')}</span>
              </label>
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              busy={saving}
              busyLabel={t('contextMemory.saving')}
              disabled={!canSave}
              onClick={() => void save()}
            >
              {t('contextMemory.save')}
            </Button>
            {!dirty && !saving && (
              <span className="text-xs text-[color:var(--fg-muted)]">
                {t('contextMemory.unchanged')}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
