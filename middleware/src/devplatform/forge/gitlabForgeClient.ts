/**
 * Epic #470 W4 — GitLabForgeClient STUB (spec §6).
 *
 * A placeholder `ForgeClient` for GitLab so the onboarding surface can list GitLab
 * behind an "experimental" badge without pretending the integration works. Every
 * method throws `NotImplementedError` — the dev platform NEVER silently degrades a
 * GitLab repo into a half-working job; it refuses loudly until the real client lands.
 *
 * TODO (deferred to a dedicated GitLab wave — documented here so the gaps are
 * explicit, per spec §6):
 *   - GitLab webhook triggers (`X-Gitlab-Token` header verification).
 *   - Project access tokens as a scoped credential mode (the GitLab analogue of the
 *     GitHub App installation token).
 *   - Branch-protection preflight (refuse a push target the project protects).
 *   - Merge-request approval-rule awareness (a job's MR must satisfy the project's
 *     required approvals).
 *   - Clone-credential user forms (`oauth2` / `gitlab-ci-token`).
 *   - REST pagination over issues / MRs.
 *
 * The applyDiff path (blobs → tree → commit → fresh ref via the git-data API) has a
 * GitLab equivalent (the Commits API `POST /projects/:id/repository/commits` with a
 * batch of actions), but it is NOT a mechanical port of the GitHub client and is
 * out of scope for this stub.
 */

import { NotImplementedError, type ForgeClient } from '../forgeClient.js';
import type {
  ApplyDiffInput,
  ApplyDiffResult,
  CommentIssueInput,
  CreateIssueInput,
  CreatePrInput,
  CreatePrResult,
  ForgeIssue,
} from '../forgeClient.js';

/** The single message every stubbed method throws — names the missing capability. */
function unsupported(op: string): never {
  throw new NotImplementedError(
    `GitLabForgeClient.${op} is not implemented — GitLab support is experimental (epic #470 W4 §6). Use a github_app repo, or wait for the dedicated GitLab wave.`,
  );
}

/**
 * A `ForgeClient` whose every operation refuses. Registered only so the onboarding
 * UI can offer GitLab as an EXPERIMENTAL option; a job on a GitLab repo fails fast
 * and visibly rather than producing a broken apply.
 */
export class GitLabForgeClient implements ForgeClient {
  async applyDiff(_input: ApplyDiffInput): Promise<ApplyDiffResult> {
    return unsupported('applyDiff');
  }

  async getRef(_owner: string, _repo: string, _ref: string): Promise<string> {
    return unsupported('getRef');
  }

  async createPR(_input: CreatePrInput): Promise<CreatePrResult> {
    return unsupported('createPR');
  }

  async getIssue(_owner: string, _repo: string, _issueNumber: number): Promise<ForgeIssue> {
    return unsupported('getIssue');
  }

  async listOpenIssues(_owner: string, _repo: string): Promise<ForgeIssue[]> {
    return unsupported('listOpenIssues');
  }

  async createIssue(_input: CreateIssueInput): Promise<ForgeIssue> {
    return unsupported('createIssue');
  }

  async commentIssue(_input: CommentIssueInput): Promise<void> {
    return unsupported('commentIssue');
  }
}
