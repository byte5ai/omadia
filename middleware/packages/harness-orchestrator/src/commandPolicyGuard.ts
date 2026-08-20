import { decideCommand, type CommandPolicy } from '@omadia/channel-sdk';

import { recordCommandPolicyOutcome } from './commandPolicyMetrics.js';
import { turnContext } from './turnContext.js';

/**
 * #580 — the command-policy enforcement seam: the orchestrator half of the
 * shell-normalizing command policy.
 *
 * `commandPolicy.ts` in the channel SDK computes *whether a command is allowed*.
 * This is where that answer is enforced at tool dispatch, and — exactly like the
 * #575 audience-floor guard next door — it is HONEST-INERT: a no-op until a
 * deployment installs a policy provider, so introducing it changes nothing for
 * any existing turn.
 *
 * ## Why the seam exists before the tool it gates
 *
 * omadia has no shell-execute tool yet (the durable-sandbox issue). The
 * reusable, hard-to-get-right 80% — the normalizer, tokenizer and rule cascade —
 * ships now as a pure primitive; this seam is the wiring that primitive plugs
 * into the moment an execute tool (or a write-capable connector tool that takes
 * a command-shaped argument) lands. Until then {@link extractCommandArguments}
 * finds nothing on today's tool inputs and the guard returns "proceed" — the
 * same shape as `guardToolEgress` returning `undefined` when no audience source
 * is installed. The active path is exercised by the #580 guard tests with a stub
 * provider, so it is wired-and-tested, not speculative.
 *
 * ## Absent provider means OFF, not DENY
 *
 * Same distinction, and same reasoning, as the audience-floor guard: no provider
 * → the policy is not enforced (nobody asked for it). A provider that is present
 * but THROWS is treated as a refusal, because a deployment that opted into a
 * command policy and whose policy resolution blew up has not established that the
 * command is safe. Today that only ever affects a command-carrying tool, of
 * which there are none — so the fail-safe is free.
 *
 * ## require_approval has no gate yet → it fails safe to a refusal
 *
 * A rule may resolve `require_approval`, but the cross-channel human-in-the-loop
 * approval UX is a separate surface (the two-phase-confirmation ADR covers it and
 * it is not built here). Until it ships, a command that needs approval cannot be
 * waved through — that would be an unsafe no-op — so it is refused with a reason
 * that says approval is required. This is the same honest-inert fallback the #579
 * posture uses when `strict` cannot rely on an approvals gate that does not exist
 * yet; flip the behaviour when the gate lands, nothing else changes.
 *
 * ## A normalization that truncated is refused, not cleared
 *
 * `normalizeCommand` flags `truncated` when substitution nesting exceeded the
 * depth cap and it stopped descending — an honest "the view below here is
 * incomplete" signal. A command whose normalization truncated could be hiding a
 * floored command below the cap, so the guard refuses it rather than clear it on
 * the strength of a partial view. This is the seam acting on the signal the pure
 * layer only *raises*; the normalizer's docstring points here for who consumes it.
 *
 * ## A refusal is a tool result, not an exception
 *
 * Like the audience-floor guard, it reads back to the model as a plain `Error: …`
 * string in the tool's result slot, so a policy decision is a route the model can
 * explain or work around — not a turn-aborting outage.
 */

/**
 * Resolves the command policy in force for the current turn, or `undefined` when
 * the deployment has not installed one. Installed by whatever translates operator
 * config into a {@link CommandPolicy} (the operator rule UI — a documented
 * follow-up); absent in every deployment that has not opted in.
 */
export type CommandPolicyProvider = () => CommandPolicy | undefined;

/**
 * Conventional argument keys that carry a shell command on a tool input. The
 * shape a shell-execute / durable-sandbox tool is expected to use. Only TOP-LEVEL
 * string values are inspected — no recursion into nested objects (a documented
 * bound; the seam gates the command the tool will run, which lives at the top of
 * its input by convention).
 */
const COMMAND_ARG_KEYS: readonly string[] = ['command', 'cmd', 'script', 'shell', 'shellCommand'];

/**
 * Pull candidate command strings out of a tool input. Returns the top-level
 * string values under {@link COMMAND_ARG_KEYS}, in key order. Empty for every
 * tool omadia ships today (none declare a command field) — which is exactly why
 * the guard is inert until an execute tool exists.
 */
export function extractCommandArguments(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const record = input as Record<string, unknown>;
  const out: string[] = [];
  for (const key of COMMAND_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) out.push(value);
  }
  return out;
}

/**
 * Check whether the current command policy permits the command(s) a tool
 * dispatch would run.
 *
 * Returns `undefined` when the call may proceed — including when no provider is
 * installed and when the tool input carries no command — or the refusal string to
 * hand back as the tool's result when a command is denied or requires approval
 * that cannot be granted yet.
 */
export async function guardToolCommands(name: string, input: unknown): Promise<string | undefined> {
  const provider = turnContext.current()?.commandPolicy;
  if (!provider) return undefined;

  let policy: CommandPolicy | undefined;
  try {
    policy = provider();
  } catch (err) {
    // Opted-in deployment whose policy resolution threw: fail safe. Only ever
    // reachable for a command-carrying tool, of which there are none today.
    // #576 P2 — count it: a run of `resolveFailed` means the GATE is broken,
    // which reads identically to "nothing to gate" in a log grep but is the
    // opposite condition operationally (the #748 lesson this metrics module
    // exists to prevent recurring for this gate too).
    recordCommandPolicyOutcome('resolve_failed');
    return commandRefusal(
      name,
      'the command policy could not be resolved',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!policy) return undefined;

  const commands = extractCommandArguments(input);
  if (commands.length === 0) return undefined;

  for (const raw of commands) {
    const result = decideCommand(policy, raw);
    if (result.decision === 'deny') {
      recordCommandPolicyOutcome('denied', result.ruleId);
      return commandRefusal(name, result.reason, `command: ${JSON.stringify(raw)}`);
    }
    if (result.decision === 'require_approval') {
      recordCommandPolicyOutcome('require_approval', result.ruleId);
      return commandRefusal(
        name,
        `${result.reason} — this command requires human approval, which is not yet available in this build`,
        `command: ${JSON.stringify(raw)}`,
      );
    }
    // A truncated normalization means substitution nesting blew past the depth
    // cap and the view below it is INCOMPLETE — a floored command could be
    // hiding there unseen (`$($($(…rm -rf…)))`). The normalizer flags this as
    // suspicious-not-clean; the seam closes that loop by refusing rather than
    // clearing a command it could not fully read. No legitimate agent command
    // nests substitutions eight deep, so this costs nothing real.
    if (result.normalized.truncated) {
      recordCommandPolicyOutcome('truncated');
      return commandRefusal(
        name,
        'the command could not be fully normalized — substitution nesting exceeded the depth cap, so a denied command may be hidden below it and the command cannot be cleared',
        `command: ${JSON.stringify(raw)}`,
      );
    }
    recordCommandPolicyOutcome('allowed');
  }
  return undefined;
}

/**
 * The refusal text. Names the tool and the reason, tells the model it is a
 * policy boundary rather than a transient failure, and points it at the next
 * move — mirrors {@link audienceRefusal} so both guards read back the same way.
 */
function commandRefusal(name: string, reason: string, detail: string): string {
  return `Error: tool \`${name}\` was refused by the command policy — ${reason} (${detail}). This is a policy boundary, not a transient failure: retrying the same command will not help. Adjust the command, or tell the user which command would need to be permitted.`;
}
