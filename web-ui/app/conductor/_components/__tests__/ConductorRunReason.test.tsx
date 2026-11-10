import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ConductorRun, ConductorRunResult, ConductorRunStep } from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { ConductorRunTrace } from '../ConductorRunTrace';

// #1699 — "Verlauf" could only ever render a red badge: the cause of a failure
// reached the container log and nothing else. These tests pin what the trace
// shows now, including the two honest fallbacks (a cause that was never
// recorded, and a code this build has no translation for).

function step(overrides: Partial<ConductorRunStep>): ConductorRunStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    stepId: 'entwurf',
    seq: 0,
    actor: { kind: 'agent', ref: 'fallback' },
    postconditionOutcome: 'n/a',
    transitionTaken: null,
    ...overrides,
  };
}

function result(run: Partial<ConductorRun>, steps: ConductorRunStep[]): ConductorRunResult {
  return {
    run: {
      id: 'run-1',
      status: 'failed',
      triggerKind: 'manual',
      startedAt: '2026-11-02T12:54:54.000Z',
      endedAt: '2026-11-02T12:54:55.591Z',
      currentStepId: null,
      ...run,
    } as ConductorRun,
    steps,
  };
}

describe('ConductorRunTrace — failure reason (#1699)', () => {
  it('names the cause in the run header and on the failed step row', () => {
    renderWithIntl(
      <ConductorRunTrace
        result={result(
          { errorCode: 'effect_threw', errorMessage: 'Error: 429 Rate limit exceeded' },
          [
            step({
              errorCode: 'effect_threw',
              errorMessage: 'Error: 429 Rate limit exceeded',
              startedAt: '2026-11-02T12:54:54.000Z',
              endedAt: '2026-11-02T12:54:55.500Z',
            }),
          ],
        )}
      />,
    );

    // The translated CODE carries the meaning…
    expect(screen.getAllByText('Step failed with an error').length).toBeGreaterThan(0);
    // …and the stored (already redacted, already truncated) message corroborates it.
    expect(screen.getAllByText('Error: 429 Rate limit exceeded').length).toBeGreaterThan(0);
  });

  it('says the cause was not recorded instead of inventing one (pre-0013 rows)', () => {
    renderWithIntl(<ConductorRunTrace result={result({ errorCode: null, errorMessage: null }, [step({})])} />);
    expect(screen.getByText('Cause not recorded')).toBeInTheDocument();
  });

  it('falls back to the raw code when this build has no translation for it', () => {
    renderWithIntl(
      <ConductorRunTrace result={result({ errorCode: 'from_a_newer_build', errorMessage: 'x' }, [step({})])} />,
    );
    // Never a crash and never "no cause": the code shows as itself. (The store
    // drops a code outside ITS vocabulary, so this guards a client older than
    // the middleware — the InspectorPanel `t.has` pattern.)
    expect(screen.getAllByText('from a newer build').length).toBeGreaterThan(0);
  });

  it('labels a message with no code as "cause not recorded" — the message is only detail', () => {
    renderWithIntl(
      <ConductorRunTrace
        result={result({ errorCode: null, errorMessage: 'Error: boom' }, [
          step({ errorCode: null, errorMessage: 'Error: boom' }),
        ])}
      />,
    );
    // A code the store could not validate is gone; what is left must not be
    // promoted to the label.
    expect(screen.getAllByText('Cause not recorded').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Error: boom').length).toBeGreaterThan(0);
  });

  it('formats the duration in the active locale', () => {
    renderWithIntl(
      <ConductorRunTrace result={result({ status: 'completed' }, [
        step({ startedAt: '2026-11-02T12:54:54.000Z', endedAt: '2026-11-02T12:54:55.500Z' }),
      ])} />,
      { locale: 'de' },
    );
    // German uses a decimal comma — the number goes through useFormatter.
    expect(screen.getByText('1,5 s')).toBeInTheDocument();
  });

  it('never prints the cancelling operator into the trace table', () => {
    renderWithIntl(
      <ConductorRunTrace result={result({ status: 'cancelled' }, [
        step({ stepId: 'freigabe', actor: { kind: 'operator_cancel', requestedBy: 'auth0|0f3c9d' } }),
      ])} />,
    );
    const row = screen.getByText('freigabe').closest('tr');
    expect(within(row!).getByText('operator_cancel')).toBeInTheDocument();
    expect(screen.queryByText(/0f3c9d/)).toBeNull();
  });

  it('shows a real per-step duration, and keeps the actor qualifiers it used to drop', () => {
    renderWithIntl(
      <ConductorRunTrace result={result({ status: 'completed', errorCode: null }, [
        step({
          stepId: 'freigabe',
          actor: { kind: 'human', noHolder: true },
          errorCode: 'no_role_holder',
          errorMessage: "human step 'freigabe' has no reachable holder for role 'reviewer'",
          transitionTaken: 't-skip',
          startedAt: '2026-11-02T12:54:54.000Z',
          endedAt: '2026-11-02T12:54:56.000Z',
        }),
      ])} />,
    );

    const row = screen.getByText('freigabe').closest('tr');
    expect(row).not.toBeNull();
    // Formatted, not padded: `format.number` drops a trailing zero decimal.
    expect(within(row!).getByText('2 s')).toBeInTheDocument();
    // `noHolder` was recorded all along and rendered nowhere.
    expect(within(row!).getByText('human (noHolder)')).toBeInTheDocument();
    // A recovered step still names its cause even though the run completed.
    expect(within(row!).getByText('No reachable holder for the human step')).toBeInTheDocument();
  });

  it('renders the legacy zero-duration row as 0 ms rather than hiding it', () => {
    renderWithIntl(
      <ConductorRunTrace result={result({ status: 'completed' }, [
        step({ startedAt: '2026-11-02T12:54:55.591Z', endedAt: '2026-11-02T12:54:55.591Z' }),
      ])} />,
    );
    expect(screen.getByText('0 ms')).toBeInTheDocument();
  });
});
