/**
 * #1016 — end-to-end composition: real guard, real AsyncLocalStorage, real
 * `CliChatAgent`.
 *
 * The two other tests cover the halves (the guard's decision table, and the
 * fact that `buildOrchestratorForAgent` forwards it). This one proves the
 * pieces compose: a stale `routineTurnContext` chain reaches the loopback
 * server's `assertTurnOwner` hook and refuses, instead of dispatching under
 * the previous principal.
 *
 * It drives the same two calls the real `tools/call` handler makes —
 * `runInTurnContext(() => { assertTurnOwner?.(); dispatch(...) })`, see
 * `loopbackMcpServer.ts` — against the deps the agent actually handed the
 * server, rather than opening a socket.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';

import {
  CliChatAgent,
  type CliChatAgentDeps,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import { routineTurnContext } from '../../src/plugins/routines/routineTurnContext.js';
import {
  TurnOwnerMismatchError,
  createRoutineTurnOwnerGuard,
} from '../../src/plugins/routines/turnOwnerGuard.js';

interface CapturedLoopbackDeps {
  readonly runInTurnContext?: <T>(fn: () => T) => T;
  readonly assertTurnOwner?: () => void;
}

/** A child process that exits cleanly the moment the prompt is written. */
function cleanExitSpawn(): CliChatAgentDeps['spawnFn'] {
  return (() => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new PassThrough(), {
      stdin,
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    stdin.on('finish', () => {
      stdout.end();
      child.exitCode = 0;
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as CliChatAgentDeps['spawnFn'];
}

/**
 * Runs one turn for `turnUserId` and returns the deps the agent gave the
 * loopback server. The turn itself always rejects (the fake CLI produces no
 * terminal result line) — the loopback server is constructed before the spawn,
 * so the capture is complete either way.
 */
async function runTurnCapturingLoopback(
  turnUserId: string | undefined,
): Promise<CapturedLoopbackDeps> {
  let captured: CapturedLoopbackDeps | undefined;

  const agent = new CliChatAgent({
    dispatch: {
      listDispatchableToolSpecs: () => [],
    } as unknown as CliChatAgentDeps['dispatch'],
    turnOwnerGuard: createRoutineTurnOwnerGuard({ log: () => {} }),
    createLoopbackServer: (deps) => {
      captured = deps;
      return {
        start: async () => ({
          url: 'http://127.0.0.1:1/mcp',
          port: 1,
          bearer: 'bearer',
        }),
        stop: async () => {},
      } as never;
    },
    spawnFn: cleanExitSpawn(),
  });

  await assert.rejects(
    agent.chat({
      userMessage: 'schedule something for me',
      ...(turnUserId === undefined ? {} : { userId: turnUserId }),
    }),
  );

  assert.ok(captured, 'the agent must construct a loopback server for the turn');
  return captured;
}

/** Exactly what the real `tools/call` handler does around a dispatch. */
function dispatchUnderGuard(deps: CapturedLoopbackDeps): void {
  const run = deps.runInTurnContext ?? ((fn: () => void) => fn());
  run(() => {
    deps.assertTurnOwner?.();
  });
}

describe('turn-owner guard composition on the CLI path (#1016)', () => {
  it('refuses a dispatch whose restored context belongs to an earlier turn', async () => {
    // A channel adapter entered the context for user A and never scoped out —
    // `enterWith` has no scope exit, so it persists onto the next turn.
    routineTurnContext.enter({
      tenant: 'acme',
      userId: 'aad-oid-A',
      channel: 'teams',
      conversationRef: {},
      canTargetOthers: false,
    });

    // The next turn belongs to user B and carries no context of its own.
    const captured = await runTurnCapturingLoopback('aad-oid-B');

    assert.ok(
      captured.assertTurnOwner,
      'the guard must be installed on the loopback server for this turn',
    );
    assert.throws(() => dispatchUnderGuard(captured), TurnOwnerMismatchError);
  });

  it('allows a dispatch whose restored context is the turn it belongs to', async () => {
    routineTurnContext.enter({
      tenant: 'acme',
      userId: 'aad-oid-SAME',
      channel: 'teams',
      conversationRef: {},
      canTargetOthers: false,
    });

    const captured = await runTurnCapturingLoopback('aad-oid-SAME');
    dispatchUnderGuard(captured);
  });
});
