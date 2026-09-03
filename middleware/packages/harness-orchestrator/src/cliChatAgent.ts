import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatAgent,
  ChatTurnInput,
  ChatStreamEvent,
  ChatStreamObserver,
  SemanticAnswer,
} from '@omadia/channel-sdk';
import type {
  DispatchableToolSpec,
  ToolDispatchService,
} from './toolDispatchService.js';
import { LoopbackMcpServer } from './loopbackMcpServer.js';
import type { LoopbackMcpServerHandle } from './loopbackMcpServer.js';

const DEFAULT_CLI_BINARY = 'claude';
const DEFAULT_MODEL = 'sonnet';
const DEFAULT_SPAWN_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const FORCE_KILL_DELAY_MS = 2_000;
const DEFAULT_MAX_CONCURRENT_TURNS = 3;

const EMPTY_USAGE: CliUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0,
  numTurns: 0,
};

export const CLI_ENV_SCRUB_KEYS: readonly string[] = [
  // Direct API keys / tokens — would switch the CLI off the subscription.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  // Routing/header overrides — could redirect to a metered gateway/proxy.
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  // Alternate-backend switches — would bill Bedrock/Vertex, not the sub.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
];

/**
 * OM-81 (#991) — the CLI's built-in tool set, denied by name at spawn time.
 *
 * `--allowedTools mcp__omadia__*` only pre-approves omadia's loopback tools; it
 * never restricted the CLI's own Bash/Edit/Write/Read/WebFetch. A beta tester
 * asked the omadia chat to run `whoami && hostname` and the CLI did, with the
 * user's OS permissions and none of omadia's gates (plugin grants, audience
 * floor, privacy guard, `sandbox_execute_enabled`) involved. `--tools ""`
 * removes the built-in set; this list is the belt to that braces for a CLI
 * that ignores `--tools`, and the contract a test can assert against.
 */
export const CLI_BUILTIN_TOOL_DENYLIST: readonly string[] = [
  'Agent',
  'Task',
  'Bash',
  'BashOutput',
  'KillShell',
  'PowerShell',
  'REPL',
  'Edit',
  'MultiEdit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookEdit',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'Skill',
  'SlashCommand',
  'ToolSearch',
  'Workflow',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskOutput',
  'TaskStop',
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ListAgents',
  'SendMessage',
  'PushNotification',
  'RemoteTrigger',
  'ReportFindings',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'LSP',
  'Monitor',
  'Artifact',
  'AskUserQuestion',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
];

/** Prefix of every tool omadia serves to the CLI over the loopback MCP server. */
export const OMADIA_MCP_TOOL_PREFIX = 'mcp__omadia__';

/**
 * OM-83 (#992) — the runtime context every CLI-backed turn carries in its
 * system prompt. Appended AFTER the caller's persona so identity stays with
 * omadia's text; it exists because `--system-prompt` drops the CLI's default
 * prompt entirely (intended: the CLI's self-description made the model believe
 * it was "Claude Code in the middleware repo" and route users out of omadia),
 * so the model has to be told here what runtime it is in and which tools it has.
 */
const CLI_RUNTIME_CONTEXT = [
  'You are running inside omadia, an enterprise agent platform, as the assistant of an omadia chat channel.',
  'You are not Claude Code and you are not in a terminal, repository or IDE; the person you talk to is already inside omadia.',
  `Your only tools are the omadia tools served over MCP (names starting with ${OMADIA_MCP_TOOL_PREFIX}).`,
  'You have no shell, file, web or scheduling tools of your own; never claim to run commands or to act in another system.',
].join(' ');

const DEFAULT_CLI_SYSTEM_PROMPT = 'You are a helpful, precise assistant.';

/**
 * Compose the `--system-prompt` value: the caller's persona (or a neutral
 * default when none is configured) followed by the omadia runtime context.
 */
export function composeCliSystemPrompt(persona: string | undefined): string {
  const base = typeof persona === 'string' && persona.trim().length > 0
    ? persona.trimEnd()
    : DEFAULT_CLI_SYSTEM_PROMPT;
  return `${base}\n\n${CLI_RUNTIME_CONTEXT}`;
}

type JsonRecord = Record<string, unknown>;

export interface CliUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly costUsd: number;
  readonly numTurns: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatUnknown(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

function formatTerminalErrorMessage(subtype: string | undefined, result: string): string {
  return `${subtype ?? 'error'}: ${result}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class TurnSemaphore {
  private readonly waiters: Array<() => void> = [];

  private availablePermits: number;

  public constructor(private readonly maxPermits: number) {
    if (!Number.isInteger(maxPermits) || maxPermits < 1) {
      throw new Error('TurnSemaphore: maxPermits must be an integer >= 1');
    }
    this.availablePermits = maxPermits;
  }

  public acquire(): Promise<void> {
    if (this.availablePermits > 0) {
      this.availablePermits -= 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  public release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }

    if (this.availablePermits >= this.maxPermits) {
      throw new Error('TurnSemaphore: release called without a matching acquire');
    }
    this.availablePermits += 1;
  }
}

// The CLI emits NDJSON, not SSE. We intentionally map only the empirically stable shapes:
// text deltas stream the answer, assistant snapshots are the only reliable full tool_use payloads,
// user snapshots carry the canonical tool_result content, and the terminal result line is the
// authoritative source for final text plus usage. Everything else is noise for this contract.
export class StreamJsonParser {
  private readonly now: () => number;

  private readonly textDeltas: string[] = [];

  private readonly seenToolUseIds = new Set<string>();

  private readonly toolUseSeenAt = new Map<string, number>();

  private usageSnapshot: CliUsage = EMPTY_USAGE;

  private messageStartCount = 0;

  private terminalAnswer = '';

  private terminalResultSeen = false;

  private terminalIterations = 0;

  private terminalIsError = false;

  private terminalError = '';

  public constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  public push(line: string): ChatStreamEvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }

    if (!isRecord(parsed)) {
      return [];
    }

    const topLevelType = asString(parsed.type);
    if (topLevelType === 'stream_event') {
      return this.handleStreamEvent(parsed);
    }
    if (topLevelType === 'assistant') {
      return this.handleAssistantSnapshot(parsed);
    }
    if (topLevelType === 'user') {
      return this.handleUserSnapshot(parsed);
    }
    if (topLevelType === 'result') {
      return this.handleTerminalResult(parsed);
    }

    return [];
  }

  public finalAnswer(): string {
    return this.terminalAnswer.length > 0 ? this.terminalAnswer : this.textDeltas.join('');
  }

  public toolCalls(): number {
    return this.seenToolUseIds.size;
  }

  public iterations(): number {
    return this.terminalIterations > 0 ? this.terminalIterations : this.messageStartCount;
  }

  public usage(): CliUsage {
    return { ...this.usageSnapshot };
  }

  public sawTerminalResult(): boolean {
    return this.terminalResultSeen;
  }

  public isError(): boolean {
    return this.terminalIsError;
  }

  public errorMessage(): string {
    return this.terminalError;
  }

  private handleStreamEvent(payload: JsonRecord): ChatStreamEvent[] {
    const event = payload.event;
    if (!isRecord(event)) {
      return [];
    }

    const eventType = asString(event.type);
    if (eventType === 'message_start') {
      this.messageStartCount += 1;
      return [];
    }

    if (eventType !== 'content_block_delta') {
      return [];
    }

    const delta = event.delta;
    if (!isRecord(delta) || asString(delta.type) !== 'text_delta') {
      return [];
    }

    const text = asString(delta.text);
    if (text === undefined) {
      return [];
    }

    this.textDeltas.push(text);
    return [{ type: 'text_delta', text }];
  }

  private handleAssistantSnapshot(payload: JsonRecord): ChatStreamEvent[] {
    const message = payload.message;
    if (!isRecord(message)) {
      return [];
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      return [];
    }

    const events: ChatStreamEvent[] = [];
    for (const block of content) {
      if (!isRecord(block) || asString(block.type) !== 'tool_use') {
        continue;
      }

      const id = asString(block.id);
      const name = asString(block.name);
      if (id === undefined || name === undefined || this.seenToolUseIds.has(id)) {
        continue;
      }

      this.seenToolUseIds.add(id);
      this.toolUseSeenAt.set(id, this.now());
      events.push({
        type: 'tool_use',
        id,
        name,
        input: block.input,
        // OM-81 — a call that did not come through omadia's loopback server is
        // one of the CLI's own tools. They are removed at spawn time; if one
        // still shows up it must never read like an omadia tool in the trace.
        ...(name.startsWith(OMADIA_MCP_TOOL_PREFIX) ? {} : { foreign: true as const }),
      });
    }

    return events;
  }

  private handleUserSnapshot(payload: JsonRecord): ChatStreamEvent[] {
    const message = payload.message;
    if (!isRecord(message)) {
      return [];
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      return [];
    }

    const events: ChatStreamEvent[] = [];
    for (const block of content) {
      if (!isRecord(block) || asString(block.type) !== 'tool_result') {
        continue;
      }

      const id = asString(block.tool_use_id);
      if (id === undefined) {
        continue;
      }

      const seenAt = this.toolUseSeenAt.get(id);
      const durationMs = seenAt === undefined ? 0 : Math.max(0, this.now() - seenAt);
      const output = this.flattenToolResultContent(block.content);
      const isError = block.is_error === true ? true : undefined;

      events.push({
        type: 'tool_result',
        id,
        output,
        durationMs,
        ...(isError === true ? { isError } : {}),
      });
    }

    return events;
  }

  private handleTerminalResult(payload: JsonRecord): ChatStreamEvent[] {
    const subtype = asString(payload.subtype);
    const terminalResult = asString(payload.result) ?? '';
    const usagePayload = isRecord(payload.usage) ? payload.usage : undefined;
    const numTurns = asNumber(payload.num_turns);

    this.terminalResultSeen = true;
    this.terminalAnswer = terminalResult.length > 0 ? terminalResult : this.textDeltas.join('');
    this.terminalIterations = numTurns ?? this.messageStartCount;
    this.terminalIsError = payload.is_error === true;
    this.terminalError = this.terminalIsError
      ? formatTerminalErrorMessage(subtype, terminalResult)
      : '';
    this.usageSnapshot = {
      inputTokens: usagePayload === undefined ? 0 : asNumber(usagePayload.input_tokens) ?? 0,
      outputTokens: usagePayload === undefined ? 0 : asNumber(usagePayload.output_tokens) ?? 0,
      cacheReadInputTokens:
        usagePayload === undefined ? 0 : asNumber(usagePayload.cache_read_input_tokens) ?? 0,
      cacheCreationInputTokens:
        usagePayload === undefined ? 0 : asNumber(usagePayload.cache_creation_input_tokens) ?? 0,
      costUsd: asNumber(payload.total_cost_usd) ?? 0,
      numTurns: numTurns ?? this.messageStartCount,
    };

    return [
      {
        type: 'done',
        answer: this.finalAnswer(),
        toolCalls: this.toolCalls(),
        iterations: this.iterations(),
      },
    ];
  }

  private flattenToolResultContent(content: unknown): string {
    if (!Array.isArray(content)) {
      return content === undefined ? '' : formatUnknown(content);
    }

    return content
      .map((block) => {
        if (isRecord(block) && asString(block.type) === 'text') {
          return asString(block.text) ?? '';
        }
        return formatUnknown(block);
      })
      .join('');
  }
}

export interface CliChatAgentDeps {
  readonly dispatch: ToolDispatchService;
  readonly createLoopbackServer?: (deps: {
    readonly dispatch: ToolDispatchService;
    readonly bearer: string;
    readonly tools: readonly DispatchableToolSpec[];
  }) => LoopbackMcpServer;
  readonly cliBinary?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly buildEnv?: () => NodeJS.ProcessEnv;
  readonly spawnFn?: typeof nodeSpawn;
  readonly spawnTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxConcurrentTurns?: number;
}

// SEAM (M3): boot/resolveChatAgent/provider routing constructs + selects this agent.
export class CliChatAgent implements ChatAgent {
  private readonly turnSemaphore: TurnSemaphore;

  public constructor(private readonly deps: CliChatAgentDeps) {
    this.turnSemaphore = new TurnSemaphore(
      deps.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS,
    );
  }

  public async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
    const lifecycle = this.runLifecycle(input);

    while (true) {
      const step = await lifecycle.next();
      if (step.done) {
        // chat() always drains to natural completion, which returns a real
        // parser; the `undefined` case only arises from chatStream's abort
        // `.return()`, never here. Guard defensively for the widened type.
        const parser = step.value;
        if (!parser) {
          throw new Error('claude-cli turn ended without a result');
        }
        if (parser.isError()) {
          throw new Error(parser.errorMessage());
        }
        return { text: parser.finalAnswer() };
      }
    }
  }

  public async *chatStream(
    input: ChatTurnInput,
    _observer?: ChatStreamObserver,
  ): AsyncGenerator<ChatStreamEvent> {
    const lifecycle = this.runLifecycle(input);
    let finished = false;

    try {
      while (true) {
        const step = await lifecycle.next();
        if (step.done) {
          finished = true;
          return;
        }

        yield step.value;
      }
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (!finished) {
        await lifecycle.return(undefined);
      }
    }
  }

  private composePrompt(input: ChatTurnInput): string {
    const lines: string[] = [];

    if (typeof input.extraSystemHint === 'string' && input.extraSystemHint.trim().length > 0) {
      lines.push(`System Hint: ${input.extraSystemHint}`);
    }

    for (const turn of input.priorTurns ?? []) {
      lines.push(`User: ${turn.userMessage}`);
      lines.push(`Assistant: ${turn.assistantAnswer}`);
    }

    lines.push(`User: ${input.userMessage}`);
    return lines.join('\n');
  }

  private buildMcpConfig(url: string, bearer: string): string {
    return JSON.stringify({
      mcpServers: {
        omadia: {
          type: 'http',
          url,
          headers: {
            Authorization: `Bearer ${bearer}`,
          },
        },
      },
    });
  }

  private async *runLifecycle(
    input: ChatTurnInput,
  ): AsyncGenerator<ChatStreamEvent, StreamJsonParser | undefined> {
    const parser = new StreamJsonParser();
    const tools = this.deps.dispatch.listDispatchableToolSpecs();
    const bearer = randomUUID();
    const createLoopbackServer =
      this.deps.createLoopbackServer ??
      ((serverDeps: {
        readonly dispatch: ToolDispatchService;
        readonly bearer: string;
        readonly tools: readonly DispatchableToolSpec[];
      }) => new LoopbackMcpServer(serverDeps));

    let server: LoopbackMcpServer | undefined;
    let handle: LoopbackMcpServerHandle | undefined;
    let tempDir: string | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let closePromise: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> | undefined;
    let overallTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let pendingFailure: Error | undefined;
    let stderr = '';
    let stdoutBuffer = '';
    let stdoutDone = false;
    let permitAcquired = false;
    let closeInfo: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
    const lineQueue: string[] = [];
    let lineWaiter: (() => void) | undefined;

    const wakeReader = (): void => {
      if (lineWaiter === undefined) {
        return;
      }

      const resolve = lineWaiter;
      lineWaiter = undefined;
      resolve();
    };

    const finishStdout = (): void => {
      if (stdoutDone) {
        return;
      }

      if (stdoutBuffer.length > 0) {
        lineQueue.push(stdoutBuffer);
        stdoutBuffer = '';
      }

      stdoutDone = true;
      wakeReader();
    };

    const resetIdleTimer = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }

      idleTimer = setTimeout(() => {
        const timeoutError = new Error(
          `CLI idle timeout after ${this.deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS}ms`,
        );
        if (pendingFailure === undefined) {
          pendingFailure = timeoutError;
        }
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
        }
        wakeReader();
      }, this.deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    };

    const failRuntime = (error: Error): void => {
      if (pendingFailure !== undefined) {
        return;
      }

      pendingFailure = error;
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      wakeReader();
    };

    try {
      await this.turnSemaphore.acquire();
      permitAcquired = true;

      server = createLoopbackServer({
        dispatch: this.deps.dispatch,
        bearer,
        tools,
      });
      handle = await server.start();

      tempDir = await mkdtemp(join(tmpdir(), 'omadia-cli-'));
      const configPath = join(tempDir, 'mcp-config.json');
      await writeFile(configPath, this.buildMcpConfig(handle.url, bearer), { mode: 0o600 });

      const argv = [
        '-p',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--strict-mcp-config',
        '--mcp-config',
        configPath,
        // OM-81 (#991) — the permission boundary. `--allowedTools` is only a
        // pre-approval of omadia's loopback tools; on its own it left the
        // CLI's Bash/Edit/Write/Read/WebFetch reachable with the user's OS
        // rights and none of omadia's gates in the way. Four flags close it:
        //   --tools ""            remove the built-in tool set (MCP tools stay)
        //   --disallowedTools ... deny the built-ins by name as well, for a CLI
        //                         that ignores `--tools`
        //   --permission-mode dontAsk  deny anything not pre-approved instead of
        //                         prompting a UI nobody is watching
        //   --setting-sources ""  load no user/project/local settings.json.
        //                         Without it the CLI picks up the host user's
        //                         ~/.claude settings, including `hooks`, which
        //                         run shell commands on the machine whenever a
        //                         tool fires, and personal allow rules. `--tools`
        //                         closes the built-ins; this closes the side
        //                         channel. Credentials are unaffected: they are
        //                         read from CLAUDE_CONFIG_DIR, not from settings,
        //                         and the MCP server still comes from
        //                         --mcp-config under --strict-mcp-config.
        '--tools',
        '',
        '--disallowedTools',
        ...CLI_BUILTIN_TOOL_DENYLIST,
        '--permission-mode',
        'dontAsk',
        '--setting-sources',
        '',
        '--allowedTools',
        `${OMADIA_MCP_TOOL_PREFIX}*`,
        '--model',
        this.deps.model ?? DEFAULT_MODEL,
        // OM-83 (#992) — replace, do not append. With `--append-system-prompt`
        // the CLI's own identity stayed primary and the model told users it
        // was "Claude Code in the middleware repo", sending them out of the
        // omadia chat they were already in.
        '--system-prompt',
        composeCliSystemPrompt(this.deps.systemPrompt),
      ];

      child = (this.deps.spawnFn ?? nodeSpawn)(
        this.deps.cliBinary ?? DEFAULT_CLI_BINARY,
        argv,
        {
          env: this.buildEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ) as ChildProcessWithoutNullStreams;

      closePromise = new Promise((resolve) => {
        child!.once('close', (code, signal) => {
          closeInfo = { code, signal };
          finishStdout();
          resolve(closeInfo);
        });
      });

      child.once('error', (error) => {
        failRuntime(error instanceof Error ? error : new Error(String(error)));
      });
      child.stdin.on('error', (error) => {
        failRuntime(error instanceof Error ? error : new Error(String(error)));
      });
      child.stdout.on('error', (error) => {
        failRuntime(error instanceof Error ? error : new Error(String(error)));
      });
      child.stderr.on('error', (error) => {
        failRuntime(error instanceof Error ? error : new Error(String(error)));
      });

      child.stdout.on('data', (chunk: Buffer | string) => {
        resetIdleTimer();
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        lineQueue.push(...lines);
        wakeReader();
      });

      child.stdout.on('end', () => {
        finishStdout();
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      overallTimer = setTimeout(() => {
        failRuntime(
          new Error(`CLI timed out after ${this.deps.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS}ms`),
        );
      }, this.deps.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);

      resetIdleTimer();

      // We send one fully composed plain-text prompt so the child process stays stateless and
      // deterministic for tests; replaying prior turns here mirrors the CLI's single-shot mode.
      child.stdin.end(this.composePrompt(input));

      while (true) {
        while (lineQueue.length > 0) {
          const line = lineQueue.shift();
          if (line === undefined) {
            continue;
          }

          for (const event of parser.push(line)) {
            yield event;
          }
        }

        if (pendingFailure !== undefined) {
          throw pendingFailure;
        }

        if (stdoutDone) {
          break;
        }

        await new Promise<void>((resolve) => {
          lineWaiter = resolve;
        });
      }

      if (closePromise !== undefined && closeInfo === undefined) {
        closeInfo = await closePromise;
      }

      if (pendingFailure !== undefined) {
        throw pendingFailure;
      }

      if (closeInfo?.signal !== null && closeInfo?.signal !== undefined) {
        throw new Error(`CLI exited with signal ${closeInfo.signal}`);
      }

      if ((closeInfo?.code ?? 0) !== 0) {
        const stderrSuffix = stderr.trim().length > 0 ? `: ${stderr.trim()}` : '';
        throw new Error(`CLI exited with code ${String(closeInfo?.code)}${stderrSuffix}`);
      }

      if (!parser.sawTerminalResult()) {
        throw new Error('claude-cli exited without a terminal result line');
      }

      return parser;
    } finally {
      if (overallTimer !== undefined) {
        clearTimeout(overallTimer);
      }
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      // `permitAcquired` flips true only after a successful acquire, and this
      // finally runs exactly once per lifecycle, so the release happens once on
      // every path (success / error / abort) and never without a prior acquire.
      if (permitAcquired) {
        this.turnSemaphore.release();
      }

      if (server !== undefined) {
        try {
          await server.stop();
        } catch {
          // Stop errors are best-effort cleanup only; preserving the primary failure is more useful.
        }
      }

      if (child !== undefined) {
        // Bind to a non-undefined local so the SIGKILL closure below keeps the
        // narrowed type — TS cannot prove the outer `let child` is still defined
        // across the setTimeout callback boundary.
        const liveChild = child;
        if (liveChild.exitCode === null && liveChild.signalCode === null) {
          liveChild.kill('SIGTERM');
        }

        let forceKillTimer: NodeJS.Timeout | undefined;
        if (liveChild.exitCode === null && liveChild.signalCode === null) {
          forceKillTimer = setTimeout(() => {
            if (liveChild.exitCode === null && liveChild.signalCode === null) {
              liveChild.kill('SIGKILL');
            }
          }, FORCE_KILL_DELAY_MS);
        }

        try {
          if (closePromise !== undefined) {
            await Promise.race([closePromise, delay(FORCE_KILL_DELAY_MS + 500)]);
          }
        } finally {
          if (forceKillTimer !== undefined) {
            clearTimeout(forceKillTimer);
          }
        }
      }

      if (tempDir !== undefined) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = this.deps.buildEnv?.() ?? { ...process.env };

    // Subscription-authenticated CLI runs must not inherit API-key or proxy overrides from the
    // host process, otherwise tests become flaky and production can silently switch auth modes.
    for (const key of CLI_ENV_SCRUB_KEYS) {
      delete env[key];
    }

    return env;
  }
}
