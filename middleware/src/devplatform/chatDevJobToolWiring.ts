/**
 * Epic #470 W3 — boot wiring for the chat orchestrator dev-job tools.
 *
 * The `nativeToolRegistry` is a GLOBAL singleton with UNIQUE tool names, and a
 * `NativeToolHandler` is `(input) => Promise<string>` with NO caller argument.
 * So the three dev-job tools (`dev_job_start` / `dev_job_status` /
 * `dev_job_list`) are registered ONCE at boot (mirroring
 * `requestSelfExtensionTool`), and the operator identity is resolved PER CALL —
 * not injected once at registration.
 *
 * The seam is `getCallerUserId()`, which boot binds to
 * `turnContext.current()?.userId` — the Omadia user id of the human driving the
 * active turn (set by the orchestrator at turn start; undefined for
 * system/ad-hoc turns). Every handler builds a fresh {@link ChatDevJobService}
 * bound to THAT caller and delegates. When there is no `userId` (no human turn),
 * the service refuses — no caller ⇒ no launch, no read, no list (fail closed).
 *
 * Launch envelope: the operator's OWN launchable repos. `allowedRepoIds` is set
 * to every repo id, so the sole authority is `isPermittedLauncher` (repo creator
 * OR holder of an `allowed_launchers` role) — exactly the admin `POST /jobs`
 * gate. This is the fail-closed reading: chat can never launch a job the
 * operator could not launch through the admin surface.
 *
 * NOTE (documented limitation): `turnContext` carries only the operator's
 * `userId` (their `sub`), not their session `role`. So the per-call caller is
 * `{ sub: userId, email: '', role: '' }`, which makes the `allowed_launchers`
 * role branch inert — chat launch resolves to CREATOR-launch only. Threading the
 * turn's role into `turnContext` would light up role-based launch; until then
 * this is a strict, safe subset. See the delivery report.
 */

import type {
  ChatDevJobCaller,
  ChatDevJobJobStore,
  ChatDevJobRepoStore,
} from './chatDevJobService.js';
import { createChatDevJobService } from './chatDevJobService.js';
import {
  createDevJobOrchestratorTools,
  type ChatDevJobService,
  type DevJobOrchestratorToolRegistrations,
} from './devJobOrchestratorTool.js';
import type { DevJobAuthMode, DevRepo, RunnerBackendKind } from './types.js';

export interface ChatDevJobToolWiringDeps {
  /** The real `DevRepoStore` (satisfies the narrow read surface). */
  repoStore: ChatDevJobRepoStore;
  /** The real `DevJobStore` (satisfies the narrow create/read surface). */
  jobStore: ChatDevJobJobStore;
  /**
   * W0 launch-authorization predicate (`devPlatformShared.isPermittedLauncher`).
   * Injected by boot so this module never imports the routes layer.
   */
  isPermittedLauncher: (repo: DevRepo, caller: ChatDevJobCaller) => boolean;
  /**
   * Runner backend for chat-launched jobs — the same backend the platform's
   * worker runs (`config.DEV_PLATFORM_BACKEND`), so a chat job is claimable by
   * the very worker that is running.
   */
  defaultBackend: RunnerBackendKind;
  /**
   * Reads the Omadia user id of the human driving the CURRENT turn. Boot binds
   * this to `turnContext.current()?.userId`. `undefined` ⇒ no human turn ⇒ the
   * tools refuse (fail closed).
   */
  getCallerUserId: () => string | undefined;
}

/**
 * Build the per-call {@link ChatDevJobService} bound to the CURRENT turn's
 * operator, or `null` when there is no operator (no `userId`). A fresh service
 * per call keeps the authorization strictly turn-scoped despite the single
 * global tool instance.
 */
async function buildServiceForTurn(
  deps: ChatDevJobToolWiringDeps,
): Promise<ChatDevJobService | null> {
  const userId = deps.getCallerUserId();
  if (!userId) return null;

  // Envelope = the operator's launchable repos: allow every repo id, so
  // `isPermittedLauncher` is the sole gate (matches admin POST /jobs).
  const repos = await deps.repoStore.listRepos();
  const caller: ChatDevJobCaller = { sub: userId, email: '', role: '' };

  return createChatDevJobService({
    repoStore: deps.repoStore,
    jobStore: deps.jobStore,
    caller,
    allowedRepoIds: repos.map((r) => r.id),
    isPermittedLauncher: deps.isPermittedLauncher,
    // Chat jobs carry no request body, so placement is a fixed policy: the
    // platform's configured backend + `api_key` auth (subscription auth is
    // admin-only, spec §6b). `createChatDevJobService` also hard-pins
    // `authMode:'api_key'` at create time; this keeps the read/host path aligned.
    resolveJobPlacement: (_repo: DevRepo): {
      backend: RunnerBackendKind;
      authMode?: DevJobAuthMode;
    } => ({ backend: deps.defaultBackend, authMode: 'api_key' }),
  });
}

/**
 * A turn-scoped {@link ChatDevJobService} facade. Every method resolves the
 * caller from `getCallerUserId()` at call time and delegates to a freshly built
 * per-turn service; with no caller it fails closed (refuse / empty / throw).
 */
function createTurnScopedChatDevJobService(
  deps: ChatDevJobToolWiringDeps,
): ChatDevJobService {
  return {
    async resolveLaunchableRepo(ref) {
      const svc = await buildServiceForTurn(deps);
      if (!svc) return null; // no operator ⇒ no oracle
      return svc.resolveLaunchableRepo(ref);
    },
    async startJob(input) {
      const svc = await buildServiceForTurn(deps);
      if (!svc) {
        // No human turn ⇒ no caller ⇒ no launch. The tool handler turns this
        // into an `Error: …` string the model sees (the orchestrator contract).
        throw new Error(
          'dev jobs can only be launched from a human chat turn (no operator identity on this turn)',
        );
      }
      return svc.startJob(input);
    },
    async getJob(jobId) {
      const svc = await buildServiceForTurn(deps);
      if (!svc) return null;
      return svc.getJob(jobId);
    },
    async listJobs(filter) {
      const svc = await buildServiceForTurn(deps);
      if (!svc) return [];
      return svc.listJobs(filter);
    },
  };
}

/**
 * Boot entry point: build the three chat orchestrator dev-job tool
 * registrations, bound to a turn-scoped, fail-closed authorization surface.
 * The caller registers each via
 * `nativeToolRegistry.register(r.name, { handler, spec, promptDoc })`.
 */
export function createChatDevJobOrchestratorTools(
  deps: ChatDevJobToolWiringDeps,
): DevJobOrchestratorToolRegistrations {
  return createDevJobOrchestratorTools(createTurnScopedChatDevJobService(deps));
}
