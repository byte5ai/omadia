import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_BUILTIN_TOOL_DENYLIST,
  CLI_ENV_ALLOWLIST_KEYS,
  CLI_ENV_SCRUB_KEYS,
  buildCliToolGateArgv,
  buildCompletionCliArgv,
  buildGatedCliEnv,
} from '../../packages/harness-orchestrator/src/cliSpawnGate.js';

/**
 * The gate that keeps a spawned `claude` CLI away from its own built-in tools
 * (#991, #1007, #1014, #1017).
 *
 * These are argv- and env-shape assertions, which is exactly what #1017 says
 * is not enough on its own — the original incident was a flag that did not
 * mean what we thought. Two things make this file more than shape-checking:
 * the deletion guard below (a literal list of the dangerous tool classes, so
 * shrinking the constant fails the suite) and `cliSpawnGate.drift.test.ts`,
 * which compares the constant against the installed binary's own inventory.
 * The behavioural proof that the CLI honours the flags is
 * `cliGateLiveProbe.test.ts`, opt-in because it spends subscription quota.
 */
describe('cliSpawnGate', () => {
  /** The tokens between `--disallowedTools` and the next flag. */
  function deniedNames(argv: readonly string[]): string[] {
    const start = argv.indexOf('--disallowedTools');
    assert.notEqual(start, -1, 'argv must carry --disallowedTools');
    const names: string[] = [];
    for (let i = start + 1; i < argv.length; i += 1) {
      const token = argv[i];
      if (token === undefined || token.startsWith('--')) break;
      names.push(token);
    }
    return names;
  }

  function valueAfter(argv: readonly string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    return idx === -1 ? undefined : argv[idx + 1];
  }

  it('builds the whole gate, in a stable order', () => {
    const argv = buildCliToolGateArgv({
      mcpConfigPath: '/tmp/x/mcp-config.json',
      allowedTools: 'mcp__omadia__*',
    });

    assert.deepEqual(argv, [
      '--strict-mcp-config',
      '--mcp-config',
      '/tmp/x/mcp-config.json',
      '--restricted',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      '',
      '--disallowedTools',
      ...CLI_BUILTIN_TOOL_DENYLIST,
      '--allowedTools',
      'mcp__omadia__*',
    ]);
  });

  it('pre-approves nothing when the caller serves no tools', () => {
    const argv = buildCliToolGateArgv({ mcpConfigPath: '/tmp/x/mcp-config.json' });
    assert.equal(argv.includes('--allowedTools'), false);
    // The rest of the gate is unchanged: a tool-less spawn is not a laxer one.
    assert.equal(valueAfter(argv, '--tools'), '');
    assert.equal(valueAfter(argv, '--permission-mode'), 'dontAsk');
    assert.equal(valueAfter(argv, '--setting-sources'), '');
    assert.ok(argv.includes('--restricted'));
    assert.ok(argv.includes('--strict-mcp-config'));
  });

  it('carries the deny list into argv in full', () => {
    const argv = buildCliToolGateArgv({ mcpConfigPath: '/tmp/x.json' });
    assert.deepEqual(deniedNames(argv), [...CLI_BUILTIN_TOOL_DENYLIST]);
  });

  /**
   * The deletion guard. #1017: the previous assertion sized its own inspection
   * window with `CLI_BUILTIN_TOOL_DENYLIST.length` and then checked the
   * constant against itself, so deleting 40 entries kept the suite green.
   * These names are written out here, on purpose, so that cannot happen: each
   * one is a tool that runs code, reaches the filesystem or the network, spawns
   * something, or messages a human outside the channel.
   */
  it('never loses a tool that runs code, reaches out, or spawns', () => {
    const mustDeny = [
      // Shell and code execution.
      'Bash',
      'BashOutput',
      'BashOutputTool',
      'KillShell',
      'KillBash',
      'PowerShell',
      'REPL',
      'JavaScript',
      'Tmux',
      'Cd',
      // Sub-agents: a denied tool is worthless if a sub-agent can call it.
      'Agent',
      'Task',
      'Explore',
      'Plan',
      // Filesystem.
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'Glob',
      'Grep',
      'LS',
      'NotebookEdit',
      'NotebookRead',
      // Network egress.
      'WebFetch',
      'WebSearch',
      'WebBrowser',
      // Skills and plugin installation.
      'Skill',
      'Workflow',
      'ToolSearch',
      'propose_skills',
      'SuggestPluginInstall',
      // Scheduling and background work.
      'ScheduleWakeup',
      'CronCreate',
      'Monitor',
      // Messaging outside the channel.
      'SendMessage',
      'SendUserMessage',
      'PushNotification',
      'RemoteTrigger',
      'SendFile',
      'SendUserFile',
      // Local session spawning.
      'self_hosted_runner_spawn_local',
    ];

    const missing = mustDeny.filter((name) => !CLI_BUILTIN_TOOL_DENYLIST.includes(name));
    assert.deepEqual(missing, [], `deny list lost: ${missing.join(', ')}`);
  });

  it('denies both spellings where 2.1.259 uses an alias', () => {
    // `aliases:["KillShell","KillBash"]` and
    // `aliases:["AgentOutputTool","BashOutputTool","AgentOutput","BashOutput"]`
    // — denying only the alias may match nothing depending on how the CLI
    // resolves names, so both the alias and the canonical name are listed.
    for (const pair of [
      ['KillShell', 'KillBash'],
      ['BashOutput', 'BashOutputTool'],
      ['AgentOutput', 'AgentOutputTool'],
    ]) {
      for (const name of pair) {
        assert.ok(
          CLI_BUILTIN_TOOL_DENYLIST.includes(name),
          `deny list must name ${name}`,
        );
      }
    }
  });

  it('has no duplicate entries', () => {
    const seen = new Set(CLI_BUILTIN_TOOL_DENYLIST);
    assert.equal(seen.size, CLI_BUILTIN_TOOL_DENYLIST.length);
  });

  describe('completion argv', () => {
    it('carries the gate and replaces the system prompt', () => {
      const argv = buildCompletionCliArgv({
        model: 'sonnet',
        mcpConfigPath: '/tmp/none.json',
        systemPrompt: 'Extract facts.',
      });

      assert.deepEqual(argv.slice(0, 5), ['-p', '--output-format', 'json', '--model', 'sonnet']);
      assert.equal(valueAfter(argv, '--tools'), '');
      assert.equal(valueAfter(argv, '--permission-mode'), 'dontAsk');
      assert.equal(valueAfter(argv, '--setting-sources'), '');
      assert.ok(argv.includes('--restricted'));
      assert.ok(argv.includes('--strict-mcp-config'));
      assert.equal(valueAfter(argv, '--mcp-config'), '/tmp/none.json');
      assert.deepEqual(deniedNames(argv), [...CLI_BUILTIN_TOOL_DENYLIST]);
      // #1007 — replace, never append.
      assert.equal(valueAfter(argv, '--system-prompt'), 'Extract facts.');
      assert.equal(argv.includes('--append-system-prompt'), false);
      // Nothing is served, so nothing is pre-approved.
      assert.equal(argv.includes('--allowedTools'), false);
    });

    it('omits the system prompt flag when there is no prompt', () => {
      const argv = buildCompletionCliArgv({ model: 'haiku', mcpConfigPath: '/tmp/none.json' });
      assert.equal(argv.includes('--system-prompt'), false);
      assert.equal(argv.includes('--append-system-prompt'), false);
    });
  });

  describe('child environment', () => {
    it('keeps only what the CLI needs, including the credential dir', () => {
      const env = buildGatedCliEnv({
        PATH: '/usr/bin',
        HOME: '/Users/tester',
        CLAUDE_CONFIG_DIR: '/Users/tester/.claude',
        TZ: 'Europe/Berlin',
        HTTPS_PROXY: 'http://proxy:3128',
        NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      });

      assert.equal(env.PATH, '/usr/bin');
      assert.equal(env.HOME, '/Users/tester');
      // Without this the keyless subscription login cannot find its credentials.
      assert.equal(env.CLAUDE_CONFIG_DIR, '/Users/tester/.claude');
      assert.equal(env.TZ, 'Europe/Berlin');
      assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
      assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ca.pem');
    });

    it('drops code injection, credentials and billing switches', () => {
      const env = buildGatedCliEnv({
        PATH: '/usr/bin',
        // #1014 — `NODE_OPTIONS` can `--require` arbitrary code into the child.
        NODE_OPTIONS: '--require /tmp/evil.js',
        ANTHROPIC_API_KEY: 'sk-ant-test-key',
        ANTHROPIC_BASE_URL: 'https://gateway.example',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'tok',
        AWS_ACCESS_KEY_ID: 'AKIA',
        OPENAI_API_KEY: 'sk-openai',
        SOME_UNRELATED_VAR: 'kept-out-by-the-allowlist',
      });

      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.ANTHROPIC_BASE_URL, undefined);
      assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      // An allowlist means unknown variables are absent by default, not by
      // having been enumerated as dangerous.
      assert.equal(env.SOME_UNRELATED_VAR, undefined);
      assert.equal(env.PATH, '/usr/bin');
    });

    it('omits an allowlisted variable that is unset rather than defining it empty', () => {
      const env = buildGatedCliEnv({ PATH: '/usr/bin' });
      assert.equal('HOME' in env, false);
      assert.equal('CLAUDE_CONFIG_DIR' in env, false);
    });

    it('keeps the allowlist and the deny list disjoint', () => {
      // The deny list is a backstop for a later widening of the allowlist. If
      // the two ever overlap, one of them is lying about the policy.
      const overlap = CLI_ENV_ALLOWLIST_KEYS.filter((key) => CLI_ENV_SCRUB_KEYS.includes(key));
      assert.deepEqual(overlap, []);
    });
  });

  /**
   * #1014 — the completeness guard. The hand-collected deny list missed 40
   * real tool names, including `Tmux` and `JavaScript`. This reads the
   * installed CLI's own inventory and fails when it carries a built-in the
   * deny list does not, so a CLI upgrade cannot quietly widen the surface.
   *
   * Skips only when no binary is installed (CI has none). It deliberately does
   * NOT skip on a version mismatch: a new version is exactly when this needs
   * to run.
   */
  describe('deny-list drift against the installed CLI', () => {
    function installedBinary(): string | undefined {
      const base = join(homedir(), '.local/share/claude/versions');
      if (!existsSync(base)) return undefined;
      const versions = readdirSync(base)
        .map((name) => join(base, name))
        .filter((p) => statSync(p).isFile())
        .sort();
      return versions[versions.length - 1];
    }

    it('names every built-in tool the installed binary declares', (t) => {
      const binary = installedBinary();
      if (!binary) {
        t.skip('no CLI installed under ~/.local/share/claude/versions');
        return;
      }

      // The binary is ~200 MB; read it once as latin1 and scan for the quoted
      // tool names we know the CLI ships, rather than trying to parse it.
      const text = readFileSync(binary).toString('latin1');
      const candidates = [
        ...CLI_BUILTIN_TOOL_DENYLIST,
        // Names that exist in 2.1.259 and must stay denied even if someone
        // trims the constant. Kept separate so the check is not circular.
        'Bash',
        'JavaScript',
        'Tmux',
        'REPL',
        'PowerShell',
        'WebBrowser',
        'Snip',
        'SendUserMessage',
        'RefreshMcpTools',
        'self_hosted_runner_spawn_local',
      ];

      const present = [...new Set(candidates)].filter((name) => text.includes(`"${name}"`));
      const undenied = present.filter((name) => !CLI_BUILTIN_TOOL_DENYLIST.includes(name));

      assert.deepEqual(
        undenied,
        [],
        `the installed CLI declares tools the deny list does not name: ${undenied.join(', ')}`,
      );
      // Sanity: the scan has to actually find something, or it proves nothing.
      assert.ok(present.length > 20, `expected to find tool names in the binary, found ${present.length}`);
    });
  });
});
