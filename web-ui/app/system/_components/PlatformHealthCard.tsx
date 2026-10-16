import { getTranslations } from 'next-intl/server';

import {
  databaseCheckOf,
  type DatabaseCheck,
  type MiddlewareHealth,
} from '../../_lib/platformHealth';
import { Row, StatusDot, dotLabel, type TFn, type Tone } from './statusParts';

/**
 * The middleware's own `/health`, rendered on `/system` (#1385). The page is
 * titled "Platform health" but used to show the vault card alone, so during a
 * Postgres outage it pointed at the vault ("Vault status unreachable") and
 * never mentioned the database. This card shows the database and the recall
 * capabilities from the one unauthenticated source that still answers during
 * that outage. Both master keys (#1387) are on the vault card beside it.
 */
export async function PlatformHealthCard({
  health,
}: {
  health: MiddlewareHealth;
}): Promise<React.ReactElement> {
  const t = await getTranslations('system.platformHealth');
  const tDot = (await getTranslations('system.vaultStatus')) as TFn;

  if (!health.reachable) {
    return (
      <Card t={t} tone="danger" tDot={tDot}>
        <p
          data-testid="platform-health-unreachable"
          className="mt-4 text-sm text-[color:var(--danger)]"
        >
          {t('middlewareUnreachable')}
        </p>
      </Card>
    );
  }

  const { body } = health;
  const database = databaseCheckOf(health);
  const kg = body.kg;
  const databaseTone = toneOfDatabase(database);
  const tone: Tone =
    databaseTone === 'danger' ? 'danger' : databaseTone === 'warn' ? 'warn' : 'ok';

  return (
    <Card t={t} tone={tone} tDot={tDot}>
      <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Row
          label={t('middleware')}
          value={t('middlewareReachable', { version: body.version ?? '—' })}
          tone="ok"
        />
        <Row
          label={t('database')}
          value={t(`databaseState.${database ?? 'unreported'}`)}
          tone={databaseTone}
        />
        {kg ? (
          <>
            <Row
              label={t('embeddings')}
              value={kg.embeddings ? t('active') : t('off')}
              tone={kg.embeddings ? 'ok' : 'warn'}
            />
            <Row
              label={t('semanticRecall')}
              value={kg.semanticRecall ? t('active') : t('off')}
              tone={kg.semanticRecall ? 'ok' : 'warn'}
            />
          </>
        ) : null}
      </dl>
      {kg && kg.warnings.length > 0 ? (
        <div className="mt-6">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
            {t('warningsHeading')}
          </div>
          {/* The middleware's own diagnostic lines (English, technical) —
              behind a catalog heading, as the detail rather than the message. */}
          <ul className="mt-2 flex flex-col gap-1 font-mono text-xs text-[color:var(--fg-muted)]">
            {kg.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function Card({
  t,
  tDot,
  tone,
  children,
}: {
  t: TFn;
  tDot: TFn;
  tone: Tone;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <article
      data-testid="platform-health-card"
      data-tone={tone}
      className="rounded-lg border border-[color:var(--divider)] bg-[color:var(--surface)] p-6 shadow-sm"
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--fg-subtle)]">
            {t('eyebrow')}
          </div>
          <h2 className="font-display mt-1 text-2xl text-[color:var(--fg-strong)]">
            {t('heading')}
          </h2>
        </div>
        <StatusDot tone={tone} label={dotLabel(tone, tDot)} />
      </header>
      {children}
    </article>
  );
}

function toneOfDatabase(check: DatabaseCheck | null): Tone {
  switch (check) {
    case 'ok':
      return 'ok';
    case 'unreachable':
      return 'danger';
    case 'unknown':
      return 'warn';
    default:
      // `none` (in-memory backend) is a deployment choice, not a fault, and
      // `null` is a middleware too old to say.
      return 'muted';
  }
}

