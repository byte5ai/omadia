'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { ConfirmDialog } from '../ConfirmDialog';
import { ApiError } from '../../_lib/api';
import { BROAD_REACH_CONFIRMATION_REQUIRED } from '../../_lib/agents';

interface BroadReachRefusal {
  slug: string;
  connectedSystems: number;
  systems: string[];
}

/** The refusal's details, or `null` when `err` is not that refusal. */
export function broadReachRefusalOf(err: unknown): BroadReachRefusal | null {
  if (!(err instanceof ApiError) || err.code !== BROAD_REACH_CONFIRMATION_REQUIRED) return null;
  try {
    const body = JSON.parse(err.body) as {
      slug?: unknown;
      reach?: { connected_systems?: unknown; systems?: Array<{ name?: unknown }> };
    };
    return {
      slug: typeof body.slug === 'string' ? body.slug : '',
      connectedSystems: typeof body.reach?.connected_systems === 'number' ? body.reach.connected_systems : 0,
      systems: (body.reach?.systems ?? [])
        .map((s) => s.name)
        .filter((n): n is string => typeof n === 'string'),
    };
  } catch {
    return { slug: '', connectedSystems: 0, systems: [] };
  }
}

interface Pending {
  refusal: BroadReachRefusal;
  agentName: string;
  answer: (confirmed: boolean) => void;
}

/**
 * #2054 — spec 2042 §5.7: a grant that gives an agent access to every
 * connected system needs the operator's explicit confirmation. The API
 * refuses it with `broad_reach_confirmation_required`; this hook turns that
 * refusal into the confirm dialog and repeats the write with
 * `confirmBroadReach: true` when the operator agrees.
 *
 * `guard(agentName, write)` runs `write(false)`; on the refusal it asks, then
 * resolves with `write(true)` — or with `undefined` when the operator
 * declined. Any other error is rethrown unchanged. Render `dialog` once.
 */
export function useBroadReachConfirm(): {
  guard: <T>(agentName: string, write: (confirm: boolean) => Promise<T>) => Promise<T | undefined>;
  dialog: React.ReactElement;
} {
  const t = useTranslations('agentReach');
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const guard = useCallback(
    async <T,>(agentName: string, write: (confirm: boolean) => Promise<T>): Promise<T | undefined> => {
      try {
        return await write(false);
      } catch (err) {
        const refusal = broadReachRefusalOf(err);
        if (!refusal) throw err;
        const confirmed = await new Promise<boolean>((resolve) => {
          const next = { refusal, agentName: agentName || refusal.slug, answer: resolve };
          pendingRef.current = next;
          setPending(next);
        });
        return confirmed ? write(true) : undefined;
      }
    },
    [],
  );

  const settle = (confirmed: boolean): void => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.answer(confirmed);
  };

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      tone="danger"
      wide
      title={t('confirmTitle', { agent: pending?.agentName ?? '' })}
      body={t('confirmBody', {
        agent: pending?.agentName ?? '',
        count: pending?.refusal.connectedSystems ?? 0,
      })}
      confirmLabel={t('confirmYes')}
      cancelLabel={t('cancel')}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      {pending && pending.refusal.systems.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-sm" data-testid="broad-reach-systems">
          {pending.refusal.systems.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : null}
    </ConfirmDialog>
  );

  return { guard, dialog };
}
