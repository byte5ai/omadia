/**
 * The permission gate for every `claude` CLI process omadia spawns (#1007).
 *
 * Two call sites spawn the official CLI on the operator's subscription:
 *
 *   1. `cliChatAgent.ts` — Shape 3, the CLI owns the agent loop and reaches
 *      omadia's tools over a loopback MCP server.
 *   2. `platform/claudeCliAdapter.ts` — Shape 2, a single-shot completion
 *      endpoint for session summary, fact extraction, the classifier and the
 *      verifier-judge. It serves NO tools at all.
 *
 * OM-81 (#991) closed the gate on the first path only. The second kept the
 * CLI's full default tool set, the operator's `settings.json` (including
 * `hooks`, which run shell commands whenever a tool fires) and the operator's
 * MCP servers — while its prompts are assembled from end-user chat text and
 * uploaded documents. Read-only built-ins never prompt for permission, so
 * injected text could read host files and return them inside a "summary"
 * omadia then persists. This module is the single definition of the gate so a
 * new spawn site cannot forget half of it.
 *
 * The flags, and what each one is actually for (all verified against
 * `claude --help` on 2.1.259):
 *
 *   --tools ""             Documented as "Use \"\" to disable all tools".
 *                          Removes the built-in set; MCP tools are a separate
 *                          namespace and stay available.
 *   --disallowedTools …    Denies the built-ins by name as well. Belt to the
 *                          braces above, and the layer that has to hold if a
 *                          CLI version reads `--tools` differently — which is
 *                          exactly the failure mode that produced OM-81
 *                          (`--allowedTools` pre-approves, it never restricted).
 *   --permission-mode      `dontAsk` — the binary's own help says "Don't prompt
 *                          for permissions, deny if not pre-approved". A
 *                          prompting mode would hang: nobody is watching a
 *                          spawned process's stdin.
 *   --setting-sources ""   Load no user/project/local `settings.json`, so the
 *                          host user's `hooks` and personal allow rules cannot
 *                          re-open what the flags above closed.
 *   --restricted           Removes the code-running built-ins and WebFetch
 *                          unless `--tools` names them, ignores user, project
 *                          and local settings files, and confines the file
 *                          tools. Safe for the subscription path: it does not
 *                          touch authentication (unlike `--bare`, which reads
 *                          neither OAuth nor keychain and would break the
 *                          keyless subscription login outright).
 *   --strict-mcp-config    Only the MCP servers in `--mcp-config` — never the
 *                          operator's own.
 *
 * Credentials are unaffected by all of this: the CLI reads them from
 * `CLAUDE_CONFIG_DIR` / the keychain, not from settings files, and
 * {@link buildGatedCliEnv} keeps `CLAUDE_CONFIG_DIR` and `HOME` in the child
 * env for exactly that reason.
 *
 * NOT closed by these flags, and deliberately recorded here rather than left
 * implied: the CLI hardcodes `CLAUDE.md` / `AGENTS.md` discovery, and only
 * `--bare` skips it. Both call sites therefore spawn with `cwd` set to an
 * empty temp directory so no project memory file is in scope. A
 * `~/.claude/CLAUDE.md` in the operator's home directory can still be read;
 * with the built-ins gone that is instruction injection rather than code
 * execution, but it is a residual, not a solved problem.
 */

/**
 * The CLI's built-in tool inventory, denied by name at spawn time.
 *
 * Mined from the installed binary's own inventory (2.1.259 keeps it as one
 * minified array, 183 entries: 105 `mcp__…` names and 78 built-ins) rather
 * than hand-collected, because the hand-collected version missed 40 names,
 * `Tmux` among them — a terminal, exactly the class this gate exists to
 * remove. This list is a deliberate SUPERSET of that inventory: it also names
 * tools from neighbouring CLI versions, so an upgrade cannot open a hole
 * between releases. `JavaScript` is one of those extras and is not a tool in
 * 2.1.259; the only `"JavaScript"` strings in the binary belong to bundled
 * highlight.js language metadata.
 *
 * Aliases are listed alongside their canonical names on purpose, because
 * denying only one spelling may match nothing depending on how the CLI
 * resolves names. 2.1.259 declares exactly ten, all covered here:
 * `KillShell`/`KillBash`, `AgentOutputTool`/`BashOutputTool`/`AgentOutput`/
 * `BashOutput`, `ListMcpResources`, `ReadMcpResource`, `ReadMcpResourceDir`,
 * and `RunWorkflow` — that last one is the alias of `Workflow` and its
 * metadata declares `enablesCodeExecution`.
 *
 * The drift guard in `test/cliBridge/cliSpawnGate.test.ts` mines the installed
 * binary's inventory AND its alias arrays, then subtracts this list; anything
 * left over fails. It works in that direction on purpose: its first version
 * built its candidate set out of this constant and so could not detect a
 * deletion at all.
 */
export const CLI_BUILTIN_TOOL_DENYLIST: readonly string[] = [
  // Shell and code execution — the OM-81 finding itself.
  'Bash',
  'BashOutput',
  'BashOutputTool',
  'KillShell',
  'KillBash',
  'PowerShell',
  'REPL',
  // Not a tool in 2.1.259 (highlight.js metadata is the only match); kept as
  // superset cover in case a future version ships a JS runner by this name.
  'JavaScript',
  'Tmux',
  'Cd',
  // Sub-agents and task runners: a denied tool is worthless if a sub-agent can
  // be spawned to call it.
  'Agent',
  'AgentOutput',
  'AgentOutputTool',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskOutput',
  'TaskStop',
  'Explore',
  'Plan',
  // Filesystem.
  'Edit',
  'MultiEdit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookEdit',
  'NotebookRead',
  // Network egress.
  'WebFetch',
  'WebSearch',
  'WebBrowser',
  // Skills, plugins and the registries that install them.
  'Skill',
  'SlashCommand',
  'ToolSearch',
  'Workflow',
  // Alias of `Workflow`, and its metadata declares `enablesCodeExecution`.
  'RunWorkflow',
  'propose_skills',
  'RefreshMcpTools',
  'SuggestPluginInstall',
  'SuggestConnectors',
  'SuggestSkills',
  'ListConnectors',
  'ListPlugins',
  'ListSkills',
  'SearchMcpRegistry',
  'SearchPlugins',
  'SearchSkills',
  'ShareOnboardingGuide',
  // Scheduling and background work.
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Monitor',
  // Messaging: an omadia turn must not reach anyone outside its own channel.
  'ListAgents',
  'ListPeers',
  'SendMessage',
  'SendUserMessage',
  'PushNotification',
  'RemoteTrigger',
  'SendFeedback',
  'SendFile',
  'SendUserFile',
  'Brief',
  'ObserverReport',
  'SubscribePR',
  // Artifacts, design surfaces and account-level integrations.
  'Artifact',
  'ArtifactComments',
  'ArtifactData',
  'ArtifactCheck',
  'DesignSync',
  'ClaudeDesign',
  'Snip',
  'Projects',
  'ConnectGitHub',
  'StatusLine',
  // Session control and interactive prompts nobody is watching.
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'ReportFindings',
  'EndConversation',
  'AskUserQuestion',
  'TodoWrite',
  'LSP',
  // MCP resource readers (the tools, not the servers). Each canonical `…Tool`
  // name has a short-form alias in 2.1.259; both spellings are denied.
  'ListMcpResourcesTool',
  'ListMcpResources',
  'ReadMcpResourceTool',
  'ReadMcpResource',
  'ReadMcpResourceDirTool',
  'ReadMcpResourceDir',
  // Self-hosted runner control: `spawn_local` starts local sessions.
  'self_hosted_runner_get_pool',
  'self_hosted_runner_list_runners',
  'self_hosted_runner_list_secrets',
  'self_hosted_runner_list_sessions',
  'self_hosted_runner_path',
  'self_hosted_runner_pool_id',
  'self_hosted_runner_read_health',
  'self_hosted_runner_read_metrics',
  'self_hosted_runner_requeue_session',
  'self_hosted_runner_spawn_local',
  'self_hosted_runner_tail_log',
];

/** Prefix of every tool omadia serves to the CLI over the loopback MCP server. */
export const OMADIA_MCP_TOOL_PREFIX = 'mcp__omadia__';

/**
 * Windows-only environment variables a spawned CLI may keep.
 *
 * The first version of this allowlist was POSIX-only, which was a regression
 * against the scrub list it replaced (that one passed everything through).
 * Windows is a shipped target: `desktop/electron-builder.yml` builds an NSIS
 * x64 installer and `platform/cliInstallService.ts` has explicit `win32`
 * handling. `HOME` and `TMPDIR` do not exist there, so the child would have
 * got no home directory and `os.tmpdir()` would have fallen through to a
 * `C:\temp` that need not exist — and a missing `SystemRoot` alone is enough
 * to break a spawned Node process.
 */
const WINDOWS_ENV_KEYS: readonly string[] = [
  'SystemRoot',
  'windir',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'PATHEXT',
  'COMSPEC',
  'SystemDrive',
  'ProgramData',
  'ProgramFiles',
  'USERNAME',
];

/**
 * Environment variables a spawned CLI may keep, on any platform.
 *
 * An allowlist, not a scrub list (#1014). The scrub list it replaces removed
 * credentials and billing switches but passed everything else through,
 * including `NODE_OPTIONS` (which can `--require` arbitrary code into the
 * child) and the whole `CLAUDE_CODE_*` family of feature and auth switches.
 *
 * Each entry earns its place:
 *   PATH, HOME            the CLI resolves helpers and its own config through these
 *   CLAUDE_CONFIG_DIR     where the subscription credentials live; without it
 *                         the keyless login path breaks
 *   TMPDIR                temp files, and the mcp-config we hand it
 *   LANG, LC_ALL, LC_CTYPE, TZ   output formatting only
 *   HTTP_PROXY, …         a corporate install has no egress without them
 *   NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, SSL_CERT_DIR   corporate TLS interception
 *   USER, LOGNAME         some helpers read the current user name
 *
 * See {@link WINDOWS_ENV_KEYS} for what is added on `win32`, and
 * {@link cliEnvAllowlistFor} for the platform branch.
 */
export const CLI_ENV_ALLOWLIST_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'USER',
  'LOGNAME',
];

/**
 * The allowlist that applies on a given platform: the shared keys, plus the
 * Windows ones on `win32`.
 *
 * Exported so a test can assert both platforms without stubbing
 * `process.platform`.
 */
export function cliEnvAllowlistFor(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32'
    ? [...CLI_ENV_ALLOWLIST_KEYS, ...WINDOWS_ENV_KEYS]
    : CLI_ENV_ALLOWLIST_KEYS;
}

/**
 * Environment variables that must never reach a spawned CLI, kept as a second
 * layer behind {@link CLI_ENV_ALLOWLIST_KEYS}.
 *
 * The allowlist already excludes all of these. The explicit deny list stays so
 * that widening the allowlist later cannot silently re-admit a credential or a
 * billing switch: {@link buildGatedCliEnv} applies it after the allowlist, and
 * a test asserts the two never overlap.
 */
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
  // Code injection into the child process.
  'NODE_OPTIONS',
];

export interface CliToolGateOptions {
  /**
   * Path to the mcp-config this spawn should use. Both call sites pass one:
   * the chat agent points at its loopback server, the completion adapter at a
   * config declaring no servers at all.
   */
  readonly mcpConfigPath: string;
  /**
   * Tool pattern to pre-approve, e.g. `mcp__omadia__*`. Omit on a spawn that
   * serves no tools, so nothing is pre-approved.
   */
  readonly allowedTools?: string;
}

/**
 * The gate as argv. Order is stable so a test can assert the exact array.
 *
 * `--disallowedTools` is variadic and therefore expanded last within its own
 * group, immediately followed by the next flag — the CLI's parser stops a
 * variadic list at the next `-`-prefixed token.
 */
export function buildCliToolGateArgv(options: CliToolGateOptions): string[] {
  const argv = [
    '--strict-mcp-config',
    '--mcp-config',
    options.mcpConfigPath,
    '--restricted',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    '',
    '--disallowedTools',
    ...CLI_BUILTIN_TOOL_DENYLIST,
  ];

  if (options.allowedTools !== undefined) {
    argv.push('--allowedTools', options.allowedTools);
  }

  return argv;
}

export interface CompletionCliArgvOptions {
  /** CLI model alias, already mapped by the caller. */
  readonly model: string;
  /** Path to an mcp-config declaring no servers. */
  readonly mcpConfigPath: string;
  /** System prompt, or undefined to leave the CLI's default in place. */
  readonly systemPrompt?: string;
}

/**
 * Full argv for the single-shot completion spawn (`claudeCliAdapter`).
 *
 * Lives here rather than in the adapter so the gate and the argv that carries
 * it are one unit, and so both are unit-testable from this package's source.
 * That matters in a git worktree, where `@omadia/orchestrator` resolves to a
 * prebuilt `dist` and an app-side test cannot see new package exports until
 * CI rebuilds.
 */
export function buildCompletionCliArgv(options: CompletionCliArgvOptions): string[] {
  const argv = [
    '-p',
    '--output-format',
    'json',
    '--model',
    options.model,
    ...buildCliToolGateArgv({ mcpConfigPath: options.mcpConfigPath }),
  ];

  // Replace rather than append, for the same reason as OM-83 (#992) on the
  // chat path: appended text leaves the CLI's own identity primary.
  if (options.systemPrompt !== undefined && options.systemPrompt.length > 0) {
    argv.push('--system-prompt', options.systemPrompt);
  }

  return argv;
}

/**
 * The child environment: allowlist first, then the deny list as a backstop.
 *
 * `base` defaults to `process.env`. Callers that need to inject an env for a
 * test pass their own; the policy applies either way, so a test cannot
 * accidentally prove a laxer environment than production uses.
 */
export function buildGatedCliEnv(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of cliEnvAllowlistFor(platform)) {
    const value = base[key];
    if (typeof value === 'string') {
      env[key] = value;
    }
  }

  for (const key of CLI_ENV_SCRUB_KEYS) {
    delete env[key];
  }

  return env;
}
