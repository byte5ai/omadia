/**
 * Epic #470 W3 §3 — built-in orchestrator tools for dev jobs.
 *
 * The chat-agent surface that lets a conversational orchestrator START and
 * OBSERVE dev jobs. This is the parallel of the plugin `ctx.devJobs` accessor
 * (§2) — same underlying stores, different caller identity: a chat turn is
 * driven by a HUMAN operator session, not a plugin.
 *
 * Three tools ship here:
 *   - `dev_job_start`  — create a job on an authorized repo (source `'chat'`).
 *   - `dev_job_status` — the descriptor + the last few event lines.
 *   - `dev_job_list`   — the caller's jobs, scoped to authorized repos.
 *
 * There is deliberately NO `dev_job_resolve_gate` tool. Per spec §4, gate
 * resolution must be attributable to a HUMAN session, never a model turn — the
 * live job card calls the W2 gate API (`POST …/gates/:gateId/resolve`)
 * directly. Withholding it here is the same reason it is withheld from
 * `ctx.devJobs`.
 *
 * Registration mirrors `requestSelfExtensionTool.ts` EXACTLY: this module is a
 * factory returning `KernelToolRegistration[]` (`{ name, spec, promptDoc,
 * handler }`), which boot registers via
 * `nativeToolRegistry.register(name, { handler, spec, promptDoc })` — the
 * full-form path. Per-agent availability is a grant (operator enables dev jobs
 * for the Agent + selects allowed repos); dispatch re-checks fail-closed, so
 * the authorization envelope lives in the injected {@link ChatDevJobService},
 * not in the model-facing tool.
 *
 * Fail-closed contract: every handler routes through the service, which resolves
 * / reads ONLY repos the chat session's operator is authorized to launch on.
 * The tool never creates, reveals, or lists a job the service did not authorize,
 * and it never throws — validation and authorization failures come back as
 * `Error: …` strings so the model sees the denial (the orchestrator contract).
 */

import { z } from 'zod';

import type {
  DevJobDescriptor,
  DevJobEventRecord,
  DevJobKind,
  DevJobStatus,
  NativeToolHandler,
  NativeToolSpec,
} from '@omadia/plugin-api';

import { DEV_JOB_STATUSES, isDevJobStatus } from './types.js';

// ---------------------------------------------------------------------------
// Tool names + schemas (spec §3). `dev_job_start` / `dev_job_status` names and
// schemas are taken verbatim from the spec; `dev_job_list` is the read-listing
// companion (see the module report — the spec §3/§9 name only start + status).
// ---------------------------------------------------------------------------

export const DEV_JOB_START_TOOL_NAME = 'dev_job_start';
export const DEV_JOB_STATUS_TOOL_NAME = 'dev_job_status';
export const DEV_JOB_LIST_TOOL_NAME = 'dev_job_list';

/** Kinds a chat agent may launch (spec §3 enum). */
const DEV_JOB_KIND_VALUES = ['analyze', 'fix_issue', 'implement'] as const;

const DevJobStartInputSchema = z
  .object({
    repo: z.string().min(1).max(200), // dev_repos id or unique name match
    kind: z.enum(DEV_JOB_KIND_VALUES).default('fix_issue'),
    brief: z.string().min(10).max(8000),
    ticket: z.string().max(64).optional(), // sourceRef when the repo has a tracker bound
  })
  .strict();

const DevJobStatusInputSchema = z
  .object({ jobId: z.string().min(1).max(64) })
  .strict();

const DevJobListInputSchema = z
  .object({
    repoId: z.string().min(1).max(200).optional(),
    status: z
      .string()
      .max(32)
      .refine(isDevJobStatus, { message: 'not a valid dev job status' })
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Injected service seam — the authorization + store surface. The concrete impl
// (see `chatDevJobService.ts`) is bound per chat session with the operator
// identity + the agent's granted repos, so the tool itself is caller-agnostic
// and enforces fail-closed purely by refusing whatever the service withholds.
// ---------------------------------------------------------------------------

/** The live job card yielded into the chat stream after a `dev_job_start`
 *  (spec §4 `dev_job_card`). Drained by the orchestrator loop — the card + SSE
 *  wiring is a separate W3 unit. */
export interface DevJobCardPayload {
  readonly jobId: string;
  readonly repoId: string;
  readonly repoName: string;
  readonly kind: DevJobKind;
  readonly status: DevJobStatus;
  readonly phase: string;
  /** `/api/dev-platform/jobs/${jobId}/events` — where the card subscribes. */
  readonly eventsUrl: string;
}

/** Descriptor + the tail of the event log, returned by `dev_job_status`. */
export interface DevJobStatusResult {
  readonly descriptor: DevJobDescriptor;
  readonly recentEvents: readonly DevJobEventRecord[];
}

/**
 * The authorized dev-job surface a chat orchestrator may use. Every method is
 * already scoped to the current session's operator identity and the agent's
 * granted repos — the tool trusts the service to have applied the launch
 * authorization and treats any `null`/empty result as a refusal (no existence
 * oracle: "not found", "not granted", and "not a permitted launcher" are
 * indistinguishable to the model).
 */
export interface ChatDevJobService {
  /** Resolve a repo reference (id or unique name) the caller may launch on,
   *  within the agent's granted set. `null` ⇒ refuse (no oracle). */
  resolveLaunchableRepo(
    ref: string,
  ): Promise<{ repoId: string; repoName: string } | null>;
  /** Create a `source:'chat'` job attributed to the operator session. */
  startJob(input: {
    repoId: string;
    kind: DevJobKind;
    brief: string;
    sourceRef?: string;
  }): Promise<DevJobDescriptor>;
  /** Authorized read of one job; `null` ⇒ not found or not accessible. */
  getJob(jobId: string): Promise<DevJobStatusResult | null>;
  /** The caller's jobs, already narrowed to authorized repos. */
  listJobs(filter: {
    repoId?: string;
    status?: DevJobStatus;
  }): Promise<readonly DevJobDescriptor[]>;
}

/** Registration shape consumed by `nativeToolRegistry.register(name, {…})`.
 *  Mirrors `requestSelfExtensionTool.ts`'s `KernelToolRegistration`. */
export interface KernelToolRegistration {
  readonly name: string;
  readonly spec: NativeToolSpec;
  readonly promptDoc: string;
  readonly handler: NativeToolHandler;
}

// ---------------------------------------------------------------------------
// Native tool specs (system-prompt tool list). JSON-schema form — the whole
// spec is sent verbatim into the Anthropic tools list, so only the documented
// fields appear.
// ---------------------------------------------------------------------------

const START_SPEC: NativeToolSpec = {
  name: DEV_JOB_START_TOOL_NAME,
  description:
    'Start an autonomous dev job (analyze / fix an issue / implement a change) on a registered repository the user has enabled for this agent. Returns immediately with a job id; the job then runs asynchronously and a live status card streams into the conversation. Only usable on repos the operator authorized — a denial comes back as an "Error: …" string.',
  input_schema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description:
          'The target repository: its dev-platform id, or its unique registered name.',
      },
      kind: {
        type: 'string',
        enum: [...DEV_JOB_KIND_VALUES],
        description:
          "What the job should do. 'analyze' inspects without changing code; 'fix_issue' addresses a tracked ticket; 'implement' builds a described change. Default: fix_issue.",
      },
      brief: {
        type: 'string',
        description:
          'A clear description of the task for the dev agent (10–8000 chars).',
      },
      ticket: {
        type: 'string',
        description:
          'Optional tracker ticket key (e.g. "123" or "PROJ-45") when the repo has a tracker bound.',
      },
    },
    required: ['repo', 'brief'],
  },
};

const STATUS_SPEC: NativeToolSpec = {
  name: DEV_JOB_STATUS_TOOL_NAME,
  description:
    'Look up the current status of a dev job you started: its lifecycle status, pipeline phase, branch/PR when present, and the last few event lines. Returns "Error: …" if the job is unknown or not accessible to this session.',
  input_schema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'The dev job id.' },
    },
    required: ['jobId'],
  },
};

const LIST_SPEC: NativeToolSpec = {
  name: DEV_JOB_LIST_TOOL_NAME,
  description:
    'List dev jobs visible to this session, optionally filtered by repository and/or lifecycle status. Only jobs on repos the operator authorized for this agent are returned.',
  input_schema: {
    type: 'object',
    properties: {
      repoId: {
        type: 'string',
        description: 'Optional — restrict to one repository id.',
      },
      status: {
        type: 'string',
        enum: [...DEV_JOB_STATUSES],
        description: 'Optional — restrict to one lifecycle status.',
      },
    },
    required: [],
  },
};

const START_PROMPT_DOC =
  `${DEV_JOB_START_TOOL_NAME}: launch an autonomous dev job on a repository the ` +
  `operator enabled for this agent. Supply the repo (id or unique name), the ` +
  `kind (analyze | fix_issue | implement), a clear brief, and optionally a ` +
  `tracker ticket. The call returns at once with a job id; progress streams as a ` +
  `live card. You cannot start a job on a repo the operator did not authorize — ` +
  `such a call returns an "Error: …" string, not a job.`;

const STATUS_PROMPT_DOC =
  `${DEV_JOB_STATUS_TOOL_NAME}: fetch the current status + recent events of a dev ` +
  `job by id. Use it to answer "how is that job doing?" between card updates.`;

const LIST_PROMPT_DOC =
  `${DEV_JOB_LIST_TOOL_NAME}: list the dev jobs this session may see, optionally ` +
  `filtered by repo id and/or status.`;

// ---------------------------------------------------------------------------
// Handler class — holds the injected service + the per-turn card buffer.
// ---------------------------------------------------------------------------

/** Compact, model-facing view of a descriptor (keeps the tool return small). */
function compactDescriptor(d: DevJobDescriptor): Record<string, unknown> {
  return {
    jobId: d.id,
    repoId: d.repoId,
    kind: d.kind,
    status: d.status,
    phase: d.phase,
    ...(d.branch ? { branch: d.branch } : {}),
    ...(d.prUrl ? { prUrl: d.prUrl } : {}),
    createdAt: d.createdAt,
  };
}

function compactEvent(e: DevJobEventRecord): Record<string, unknown> {
  return { at: e.at, type: e.type };
}

function eventsUrlFor(jobId: string): string {
  return `/api/dev-platform/jobs/${jobId}/events`;
}

function errString(prefix: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Error: ${prefix}: ${msg}`;
}

export class DevJobOrchestratorTool {
  private readonly service: ChatDevJobService;
  private pendingCards: DevJobCardPayload[] = [];

  constructor(service: ChatDevJobService) {
    this.service = service;
  }

  /** `dev_job_start` handler — never throws; returns the orchestrator contract
   *  string `{status:'job_started', jobId, repoId, phase:'queued'}` on success. */
  async handleStart(raw: unknown): Promise<string> {
    const parsed = DevJobStartInputSchema.safeParse(raw);
    if (!parsed.success) {
      return `Error: invalid ${DEV_JOB_START_TOOL_NAME} input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    const { repo, kind, brief, ticket } = parsed.data;
    try {
      const resolved = await this.service.resolveLaunchableRepo(repo);
      if (!resolved) {
        // Single no-oracle refusal: absent / not-granted / not-a-launcher are
        // indistinguishable so the model cannot probe for repo existence.
        return `Error: repository "${repo}" is not available to this agent — it does not exist, is not enabled for dev jobs on this agent, or you are not a permitted launcher.`;
      }
      const descriptor = await this.service.startJob({
        repoId: resolved.repoId,
        kind,
        brief,
        ...(ticket ? { sourceRef: ticket } : {}),
      });
      this.pendingCards.push({
        jobId: descriptor.id,
        repoId: descriptor.repoId,
        repoName: resolved.repoName,
        kind: descriptor.kind,
        status: descriptor.status,
        phase: descriptor.phase,
        eventsUrl: eventsUrlFor(descriptor.id),
      });
      // Documented §3 result contract. `phase:'queued'` mirrors the freshly
      // created job's lifecycle status; the live card carries the real,
      // evolving status/phase from here on.
      return JSON.stringify({
        status: 'job_started',
        jobId: descriptor.id,
        repoId: descriptor.repoId,
        phase: 'queued',
      });
    } catch (err: unknown) {
      return errString(`${DEV_JOB_START_TOOL_NAME} failed`, err);
    }
  }

  /** `dev_job_status` handler — descriptor JSON plus the last 5 event lines. */
  async handleStatus(raw: unknown): Promise<string> {
    const parsed = DevJobStatusInputSchema.safeParse(raw);
    if (!parsed.success) {
      return `Error: invalid ${DEV_JOB_STATUS_TOOL_NAME} input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    try {
      const res = await this.service.getJob(parsed.data.jobId);
      if (!res) {
        return `Error: dev job "${parsed.data.jobId}" was not found or is not accessible to this session.`;
      }
      return JSON.stringify({
        ...compactDescriptor(res.descriptor),
        recentEvents: res.recentEvents.slice(-5).map(compactEvent),
      });
    } catch (err: unknown) {
      return errString(`${DEV_JOB_STATUS_TOOL_NAME} failed`, err);
    }
  }

  /** `dev_job_list` handler — the caller's jobs, scoped by the service. */
  async handleList(raw: unknown): Promise<string> {
    const parsed = DevJobListInputSchema.safeParse(raw);
    if (!parsed.success) {
      return `Error: invalid ${DEV_JOB_LIST_TOOL_NAME} input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    try {
      const filter: { repoId?: string; status?: DevJobStatus } = {};
      if (parsed.data.repoId) filter.repoId = parsed.data.repoId;
      if (parsed.data.status) filter.status = parsed.data.status as DevJobStatus;
      const jobs = await this.service.listJobs(filter);
      return JSON.stringify({ jobs: jobs.map(compactDescriptor) });
    } catch (err: unknown) {
      return errString(`${DEV_JOB_LIST_TOOL_NAME} failed`, err);
    }
  }

  /**
   * Returns and clears the cards queued by `dev_job_start` calls this turn.
   * Mirrors `AskUserChoiceTool.takePending()` but accumulates (a turn may start
   * more than one job) and does NOT short-circuit the turn — the orchestrator
   * loop drains this after the tool batch and yields each as a `dev_job_card`
   * stream event (that wiring is a separate W3 unit).
   */
  takePendingCards(): DevJobCardPayload[] {
    const cards = this.pendingCards;
    this.pendingCards = [];
    return cards;
  }

  hasPendingCards(): boolean {
    return this.pendingCards.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Factory — the boot-facing surface. Returns the shared tool instance (for the
// orchestrator loop's card drain) + the three registrations to hand to
// `nativeToolRegistry.register`.
// ---------------------------------------------------------------------------

export interface DevJobOrchestratorToolRegistrations {
  readonly tool: DevJobOrchestratorTool;
  readonly registrations: readonly KernelToolRegistration[];
}

/**
 * Build the dev-job orchestrator tools bound to an authorized {@link
 * ChatDevJobService}. Boot registers each via
 * `nativeToolRegistry.register(r.name, { handler: r.handler, spec: r.spec,
 * promptDoc: r.promptDoc })` — only when the dev platform is configured and only
 * for agents the operator granted dev jobs (fail-closed availability, mirroring
 * `mcpGrantPolicy.ts`). The returned `tool.takePendingCards()` feeds the chat
 * card stream.
 */
export function createDevJobOrchestratorTools(
  service: ChatDevJobService,
): DevJobOrchestratorToolRegistrations {
  const tool = new DevJobOrchestratorTool(service);
  const registrations: KernelToolRegistration[] = [
    {
      name: DEV_JOB_START_TOOL_NAME,
      spec: START_SPEC,
      promptDoc: START_PROMPT_DOC,
      handler: (input: unknown) => tool.handleStart(input),
    },
    {
      name: DEV_JOB_STATUS_TOOL_NAME,
      spec: STATUS_SPEC,
      promptDoc: STATUS_PROMPT_DOC,
      handler: (input: unknown) => tool.handleStatus(input),
    },
    {
      name: DEV_JOB_LIST_TOOL_NAME,
      spec: LIST_SPEC,
      promptDoc: LIST_PROMPT_DOC,
      handler: (input: unknown) => tool.handleList(input),
    },
  ];
  return { tool, registrations };
}
