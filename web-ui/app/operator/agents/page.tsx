import type { Metadata } from 'next';

import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import {
  listOperatorAgents,
  type OperatorAgentsListDto,
} from '../../_lib/agents';
import { AgentsDashboard } from './_components/AgentsDashboard';

/**
 * US9 — operator-facing multi-orchestrator dashboard.
 *
 * Lists every configured Agent (US4), exposes per-Agent CRUD (T037 REST),
 * shows the runtime memory scope (US8) + active state from the registry,
 * and offers the drain / kill controls (US6 force-invalidate, T041).
 */

export const metadata: Metadata = {
  title: 'Agents · Omadia',
};

export const dynamic = 'force-dynamic';

export default async function OperatorAgentsPage(): Promise<React.ReactElement> {
  let initial: OperatorAgentsListDto | null = null;
  let loadError: string | null = null;
  try {
    initial = await listOperatorAgents();
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError = err instanceof Error ? err.message : 'Failed to load agents';
  }

  return (
    <main className="mx-auto w-full max-w-[1400px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-2 max-w-2xl text-sm text-neutral-600">
          Multi-orchestrator runtime — create, edit, disable, drain, or kill
          Agents and watch the registry react in real time via the
          LISTEN/NOTIFY hot-reload bus.
        </p>
      </header>
      {loadError ? (
        <div className="rounded border border-red-400 bg-red-50 p-4 text-sm text-red-800">
          {loadError}
        </div>
      ) : (
        <AgentsDashboard initial={initial!} />
      )}
    </main>
  );
}
