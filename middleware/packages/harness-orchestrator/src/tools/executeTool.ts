import { z } from 'zod';

import {
  decideCommand,
  defaultCommandPolicy,
  formatSessionScope,
  parseSessionScope,
  type CommandPolicy,
} from '@omadia/channel-sdk';
import type { NativeToolHandler, NativeToolSpec } from '@omadia/plugin-api';
import {
  resolveAgentComputerProfile,
  type AgentComputerProfile,
  type SandboxBackend,
} from '@omadia/sandbox';

import { recordCommandPolicyOutcome } from '../commandPolicyMetrics.js';
import { turnContext } from '../turnContext.js';

/**
 * Issue #576 P2 — the `execute` native tool: runs a shell command inside the
 * calling turn's scope sandbox (see `@omadia/sandbox`).
 *
 * ## Security boundary — belt AND braces
 *
 * `orchestrator.ts`'s `dispatchTool` already runs EVERY tool dispatch through
 * `guardToolCommands` (#580), which gates on a top-level `command`-shaped
 * input field — this tool's input schema uses exactly that key (`command`),
 * so it is gated automatically by the existing choke point WHENEVER a
 * deployment has installed a `commandPolicy` provider on the turn context.
 *
 * No deployment does that today (the seam is honest-inert until an operator
 * config UI lands — see `commandPolicyGuard.ts`'s module doc). Relying SOLELY
 * on an opt-in seam for the one tool whose entire job is running arbitrary
 * commands would mean `execute` ships fully open in every deployment that
 * hasn't separately configured a policy — the "#748 lesson" the phase-4b
 * prompt calls out (fail-open + no evidence = an invisible outage, applied
 * here to a much sharper edge than a security screener).
 *
 * So this handler ALSO runs its own policy check before ever touching a
 * sandbox — `resolveCommandPolicy` defaults to `defaultCommandPolicy()`,
 * i.e. the `DEFAULT_ORG_FLOOR` (recursive rm, force-push, destructive SQL,
 * fork bombs, pipe-to-shell) plus a permissive default, exactly the posture
 * the org floor's own module doc says applies "in EVERY posture — there is
 * no caller flag that disables it, by design". A deployment that separately
 * installs a stricter turn-context `commandPolicy` provider (scope rules, a
 * narrower default) gets BOTH checks — this one first (the org floor, always
 * on), the dispatch-time one second (org floor + allowlist + scope cascade).
 * Redundant on the floor rules by design; the floor is exactly the layer
 * that must never depend on whether an operator remembered to configure
 * anything.
 *
 * `resolveCommandPolicy` throwing is FAIL-CLOSED: the command is refused,
 * never run. This is the same posture `guardToolCommands` takes for a
 * provider that throws, applied here as the tool's own default rather than
 * something an operator must separately wire up.
 *
 * `require_approval` is surfaced as an explicit refusal naming why — never
 * silently escalated to a run, per the phase-4b prompt's requirement.
 */

export const EXECUTE_TOOL_NAME = 'execute';

const ExecuteInputSchema = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().min(1).max(1000).optional(),
  timeoutSeconds: z.number().int().min(1).max(600).optional(),
});

export const executeToolSpec: NativeToolSpec = {
  name: EXECUTE_TOOL_NAME,
  description:
    'Run a shell command inside this scope\'s durable sandbox (a persistent Linux container — installed tools stay installed across calls). Every command is checked against the org command policy BEFORE it runs; a denied or approval-requiring command is refused with a reason instead of executing. Returns {exitCode, stdout, stderr, durationMs, timedOut, outputTruncated} as JSON.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to run (POSIX sh). Required.',
      },
      cwd: {
        type: 'string',
        description:
          'Optional working directory, relative to the sandbox root. A path that escapes the sandbox root is rejected and the default working directory is used instead.',
      },
      timeoutSeconds: {
        type: 'integer',
        description:
          'Optional wall-clock budget for this call. Clamped down to the sandbox profile\'s ceiling — never up.',
      },
    },
    required: ['command'],
  },
};

export interface ExecuteToolAuditEvent {
  readonly kind: 'denied' | 'require_approval' | 'truncated' | 'resolve_failed';
  readonly reason: string;
  readonly ruleId?: string;
  readonly scopeKey?: string;
}

export interface CreateExecuteHandlerOptions {
  readonly backend: SandboxBackend;
  readonly profile?: AgentComputerProfile;
  /** Defaults to `defaultCommandPolicy()` — the org floor, always on. See the
   *  module doc for why this check exists independently of the turn-context
   *  `commandPolicy` seam. */
  readonly resolveCommandPolicy?: () => CommandPolicy;
  /** Best-effort audit hook, called synchronously and never allowed to throw
   *  out of the handler. Defaults to a `console.warn` line so a deployment
   *  that wires nothing still gets SOME trace of a refusal, matching
   *  `securityScreenMetrics.ts`'s `defaultAlert` precedent. */
  readonly auditSink?: (event: ExecuteToolAuditEvent) => void;
}

function defaultAuditSink(event: ExecuteToolAuditEvent): void {
  console.warn(`[execute-tool] ${event.kind}: ${event.reason}${event.ruleId ? ` (rule=${event.ruleId})` : ''}`);
}

function audit(sink: (event: ExecuteToolAuditEvent) => void, event: ExecuteToolAuditEvent): void {
  try {
    sink(event);
  } catch {
    /* an audit sink that throws must not break the tool call it audits */
  }
}

/** Resolves the scope key `execute` provisions its sandbox under. Falls back
 *  to a turn-unique key for an unscoped turn rather than a shared literal —
 *  the #445 lesson: two unrelated unscoped turns must not land in the same
 *  bucket. */
function resolveScopeKey(): string {
  const raw = turnContext.current()?.sessionScope;
  const scope = parseSessionScope(raw);
  if (scope.kind !== 'unscoped') return formatSessionScope(scope);
  const turnId = turnContext.current()?.turnId;
  return `unscoped:${turnId && turnId.length > 0 ? turnId : 'no-turn'}`;
}

export function createExecuteHandler(options: CreateExecuteHandlerOptions): NativeToolHandler {
  const resolvePolicy = options.resolveCommandPolicy ?? defaultCommandPolicy;
  const auditSink = options.auditSink ?? defaultAuditSink;
  const profile = options.profile ?? resolveAgentComputerProfile();

  return async (input) => {
    const parsed = ExecuteInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return `Error: invalid execute input — ${detail}`;
    }

    let policy: CommandPolicy;
    try {
      policy = resolvePolicy();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordCommandPolicyOutcome('resolve_failed');
      audit(auditSink, { kind: 'resolve_failed', reason: detail });
      return `Error: execute — the command policy could not be resolved; refusing to run (fail-closed). ${detail}`;
    }

    const decision = decideCommand(policy, parsed.data.command);
    if (decision.decision === 'deny') {
      recordCommandPolicyOutcome('denied', decision.ruleId);
      audit(auditSink, { kind: 'denied', reason: decision.reason, ...(decision.ruleId ? { ruleId: decision.ruleId } : {}) });
      return `Error: execute — refused by the command policy: ${decision.reason}. This is a policy boundary, not a transient failure: retrying the same command will not help.`;
    }
    if (decision.decision === 'require_approval') {
      recordCommandPolicyOutcome('require_approval', decision.ruleId);
      audit(auditSink, {
        kind: 'require_approval',
        reason: decision.reason,
        ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
      });
      return `Error: execute — this command requires human approval (${decision.reason}), which is not yet available in this build. It was NOT run.`;
    }
    if (decision.normalized.truncated) {
      recordCommandPolicyOutcome('truncated');
      audit(auditSink, {
        kind: 'truncated',
        reason: 'substitution nesting exceeded the normalizer depth cap',
      });
      return 'Error: execute — the command could not be fully normalized (substitution nesting too deep); refusing rather than running a command that could not be fully checked.';
    }
    recordCommandPolicyOutcome('allowed');

    const scopeKey = resolveScopeKey();
    try {
      const sandbox = await options.backend.provision({ scopeKey, profile });
      const result = await sandbox.run(parsed.data.command, {
        ...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {}),
        ...(parsed.data.timeoutSeconds !== undefined ? { timeoutSeconds: parsed.data.timeoutSeconds } : {}),
      });
      return JSON.stringify({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
      });
    } catch (err) {
      return `Error: execute — sandbox failure: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

export const EXECUTE_SYSTEM_PROMPT_DOC = `### Execute (\`execute\`)
Runs a shell command inside this scope's durable sandbox — a persistent container, not a fresh throwaway environment. Tools you install in one call are still there in the next. Every command is checked against the org command policy before it runs: a denied command (recursive delete, force-push, destructive SQL, a fork bomb, piping a download into a shell) is refused with a reason instead of executing, and that refusal is not something you can talk your way around by rephrasing — pick a different command, or tell the user which command would need to be permitted.`;
