/**
 * Spec 2042 §5.10 — model access for a system module that runs a model loop
 * outside the kernel's own turn (the dev platform's coding jobs, where the
 * Claude CLI inside a job container speaks the Anthropic Messages API).
 *
 * Such a module holds no model credentials and calls no model API itself.
 * It opens an OPERATOR JOB for its work (`operatorJobs@1`: budget, deadline,
 * cancel, recorded like every operator job) and forwards each model request
 * through the kernel (`modelPassthrough@1`), which takes the instance's
 * provider credentials, admits the call inside the job's execution context
 * and returns the provider's response as it is (streamed).
 *
 * Both services are given only to plugins of kind `system-module`.
 */

/** One operator job, opened by the kernel for a system module. */
export interface OperatorJob {
  readonly id: string;
  /** Aborted when an operator cancels the job and at its deadline. */
  readonly signal: AbortSignal;
  /** End the job. Idempotent; a job not ended ends at its deadline. */
  end(outcome?: { readonly failed?: boolean; readonly message?: string }): Promise<void>;
}

export interface OperatorJobsService {
  /**
   * Open one operator job. `kind` names it in the operator's list (it is
   * prefixed with the plugin id); `budgetCalls` and `deadlineMs` bound it
   * and are capped by the kernel. Rejects when the instance's daily
   * operator-tools budget is used up.
   */
  open(input: {
    readonly kind: string;
    readonly startedBy?: string;
    readonly budgetCalls: number;
    readonly deadlineMs: number;
    readonly effects: readonly string[];
  }): Promise<OperatorJob>;
}

export interface ModelPassthroughService {
  /**
   * Forward one Anthropic Messages request (`POST /v1/messages`) to the
   * instance's Anthropic provider inside `job`. Only the headers
   * `anthropic-version`, `anthropic-beta`, `accept` and `content-type` are
   * taken; the kernel adds the credentials. Resolves with the provider's
   * response; rejects when the job may make no further model call (budget,
   * deadline, cancel, kill switch) or no Anthropic credentials are set.
   */
  forwardAnthropicMessages(input: {
    readonly job: OperatorJob;
    /** The query string of the client's request, e.g. `?beta=true`. */
    readonly query?: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body: Uint8Array | string;
    readonly signal?: AbortSignal;
  }): Promise<Response>;
}

export const OPERATOR_JOBS_SERVICE_NAME = 'operatorJobs';
export const MODEL_PASSTHROUGH_SERVICE_NAME = 'modelPassthrough';
