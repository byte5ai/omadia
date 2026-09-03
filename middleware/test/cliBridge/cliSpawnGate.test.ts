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
  cliEnvAllowlistFor,
} from '../../packages/harness-orchestrator/src/cliSpawnGate.js';

/**
 * The gate that keeps a spawned `claude` CLI away from its own built-in tools
 * (#991, #1007, #1014, #1017).
 *
 * These are argv- and env-shape assertions, which is exactly what #1017 says
 * is not enough on its own — the original incident was a flag that did not
 * mean what we thought. Two things make this file more than shape-checking:
 * the deletion guard below (a literal list of the dangerous tool classes, so
 * shrinking the constant fails the suite) and the drift guard at the bottom of
 * this file, which mines the installed binary's own inventory and subtracts
 * the constant from it.
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
      // Superset cover, not a 2.1.259 tool: the only `"JavaScript"` strings in
      // the binary are bundled highlight.js language metadata.
      'JavaScript',
      'Tmux',
      'Cd',
      // Alias of `Workflow` whose metadata declares `enablesCodeExecution`.
      'RunWorkflow',
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

  it('denies every alias 2.1.259 declares, in both spellings', () => {
    // Denying only one spelling may match nothing depending on how the CLI
    // resolves names, so alias and canonical name are both listed. These are
    // all ten alias names the 2.1.259 tool metadata declares; the drift guard
    // below re-mines them from the binary so this cannot silently fall behind.
    const aliases = [
      'KillShell',
      'KillBash',
      'BashOutput',
      'BashOutputTool',
      'AgentOutput',
      'AgentOutputTool',
      'ListMcpResources',
      'ReadMcpResource',
      'ReadMcpResourceDir',
      // Alias of `Workflow`; its metadata declares `enablesCodeExecution`, so
      // this one was a code-execution path left open.
      'RunWorkflow',
    ];
    const missing = aliases.filter((name) => !CLI_BUILTIN_TOOL_DENYLIST.includes(name));
    assert.deepEqual(missing, [], `deny list is missing aliases: ${missing.join(', ')}`);

    // And the canonical names those aliases stand for.
    for (const canonical of ['Workflow', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool']) {
      assert.ok(CLI_BUILTIN_TOOL_DENYLIST.includes(canonical), `deny list must name ${canonical}`);
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

    /**
     * The allowlist was POSIX-only, which was a regression against the scrub
     * list it replaced. Windows is a shipped target (`electron-builder.yml`
     * builds an NSIS x64 installer, `cliInstallService.ts` branches on
     * `win32`), and `HOME`/`TMPDIR` do not exist there: the child would have
     * got no home and `os.tmpdir()` would have fallen through to a `C:\temp`
     * that need not exist. A missing `SystemRoot` alone breaks spawned Node.
     */
    it('keeps the Windows essentials on win32', () => {
      const windowsEnv = {
        Path: 'C:\\Windows\\system32',
        SystemRoot: 'C:\\Windows',
        windir: 'C:\\Windows',
        APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\tester',
        TEMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
        TMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
        PATHEXT: '.COM;.EXE;.BAT',
        COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
        CLAUDE_CONFIG_DIR: 'C:\\Users\\tester\\.claude',
        NODE_OPTIONS: '--require C:\\evil.js',
      };

      const env = buildGatedCliEnv(windowsEnv, 'win32');
      for (const key of [
        'SystemRoot',
        'windir',
        'APPDATA',
        'LOCALAPPDATA',
        'USERPROFILE',
        'TEMP',
        'TMP',
        'PATHEXT',
        'COMSPEC',
      ]) {
        assert.equal(env[key], windowsEnv[key as keyof typeof windowsEnv], `${key} must survive on win32`);
      }
      assert.equal(env.CLAUDE_CONFIG_DIR, 'C:\\Users\\tester\\.claude');
      // The gate still holds on Windows.
      assert.equal(env.NODE_OPTIONS, undefined);
    });

    it('does not leak the Windows keys onto posix', () => {
      const env = buildGatedCliEnv(
        { PATH: '/usr/bin', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\x' },
        'darwin',
      );
      assert.equal(env.PATH, '/usr/bin');
      assert.equal(env.SystemRoot, undefined);
      assert.equal(env.APPDATA, undefined);
    });

    it('exposes the platform branch it applies', () => {
      const posix = cliEnvAllowlistFor('linux');
      const win = cliEnvAllowlistFor('win32');
      assert.equal(posix.includes('SystemRoot'), false);
      assert.ok(win.includes('SystemRoot'));
      // win32 is a superset: nothing the posix branch needs is dropped.
      for (const key of posix) assert.ok(win.includes(key), `win32 allowlist must keep ${key}`);
    });

    it('keeps the allowlist and the deny list disjoint', () => {
      // The deny list is a backstop for a later widening of the allowlist. If
      // the two ever overlap, one of them is lying about the policy.
      const overlap = CLI_ENV_ALLOWLIST_KEYS.filter((key) => CLI_ENV_SCRUB_KEYS.includes(key));
      assert.deepEqual(overlap, []);
    });
  });

  /**
   * #1014 — the completeness guard: does the deny list still cover everything
   * the installed CLI ships?
   *
   * The first attempt at this could not detect drift at all. It built its
   * candidate set from `CLI_BUILTIN_TOOL_DENYLIST` plus a handful of extras
   * that were themselves already in the deny list, then filtered for names
   * NOT in the deny list — empty by construction. A reviewer replayed it with
   * `Read` removed, with `WebFetch` removed, and with 40 other names removed,
   * and it stayed green every time: 55 of 100 entries were deletable with
   * nothing going red. That is the same self-referential defect #1017 set out
   * to remove, rebuilt in a different shape.
   *
   * The direction is now the other way round: mine the CLI's OWN inventory out
   * of the binary, then subtract the deny list. Anything left over is drift and
   * fails the test. The deny list is never an input to the candidate set.
   *
   * Skips only when no binary is installed (CI has none). It deliberately does
   * NOT skip on a version mismatch: a new version is exactly when this matters.
   */
  describe('deny-list drift against the installed CLI', () => {
    /** Newest installed CLI, by SEMVER order — `2.1.30` must not beat `2.1.259`. */
    function installedBinary(): { readonly path: string; readonly version: string } | undefined {
      const base = join(homedir(), '.local/share/claude/versions');
      if (!existsSync(base)) return undefined;
      const entries = readdirSync(base)
        .filter((name) => statSync(join(base, name)).isFile())
        .map((name) => ({
          name,
          parts: name.split('.').map((part) => Number.parseInt(part, 10) || 0),
        }))
        .sort((left, right) => {
          for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
            const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
            if (diff !== 0) return diff;
          }
          return 0;
        });
      const newest = entries[entries.length - 1];
      return newest ? { path: join(base, newest.name), version: newest.name } : undefined;
    }

    /**
     * Every built-in tool name the binary declares, plus every alias attached
     * to tool metadata.
     *
     * The CLI keeps its tool inventory as one array literal of quoted names
     * (in 2.1.259 it is minified to `var mEo=[...]`, 183 entries, of which 105
     * are `mcp__…` and 78 are built-ins). The variable name is minified and
     * will change between versions, so we look for the ARRAY rather than the
     * name: a literal of 50+ quoted identifiers that contains the anchors any
     * plausible inventory must contain.
     *
     * Aliases live in `aliases:[...]` arrays. Those also appear in bundled
     * third-party data (highlight.js language definitions carry them too), so
     * only arrays whose surrounding window looks like tool metadata count —
     * `searchHint`, `isReadOnly`, `enablesCodeExecution`, `isConcurrencySafe`.
     * In 2.1.259 that yields exactly ten alias names.
     */
    function mineToolNames(text: string): {
      readonly builtins: readonly string[];
      readonly aliases: readonly string[];
    } {
      // The entry class allows `.` and `-` because MCP server names carry them
      // (`mcp__claude-code-remote`). Without that the literal match truncates
      // at the first hyphen and can miss the anchors below — which is how the
      // first version of this parser silently mined zero names.
      const arrayLiteral = /\[((?:"[A-Za-z_][A-Za-z0-9_.-]*",){49,}"[A-Za-z_][A-Za-z0-9_.-]*")\]/g;
      let builtins: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = arrayLiteral.exec(text)) !== null) {
        const body = match[1] ?? '';
        const names = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
        const anchors = ['Bash', 'Read', 'WebFetch', 'Grep'];
        if (!anchors.every((anchor) => names.includes(anchor))) continue;
        const nonMcp = names.filter((name) => !name.startsWith('mcp__'));
        if (nonMcp.length > builtins.length) builtins = nonMcp;
      }

      const aliases = new Set<string>();
      const aliasArray = /aliases:\[((?:"[^"]*",?)+)\]/g;
      while ((match = aliasArray.exec(text)) !== null) {
        const window = text.slice(Math.max(0, match.index - 600), match.index + 600);
        if (!/searchHint|isReadOnly|enablesCodeExecution|isConcurrencySafe/.test(window)) continue;
        for (const m of (match[1] ?? '').matchAll(/"([^"]+)"/g)) aliases.add(m[1] as string);
      }

      return { builtins, aliases: [...aliases].sort() };
    }

    it('names every built-in tool and alias the installed binary declares', (t) => {
      const binary = installedBinary();
      if (!binary) {
        t.skip('no CLI installed under ~/.local/share/claude/versions');
        return;
      }

      const { builtins, aliases } = mineToolNames(readFileSync(binary.path).toString('latin1'));

      // The mining has to have worked, or the subtraction below proves nothing.
      // This is the assertion the previous version was missing: it could not
      // tell "nothing drifted" from "nothing was found".
      assert.ok(
        builtins.length >= 50,
        `expected to mine the tool inventory from ${binary.version}, found ${builtins.length} names`,
      );
      assert.ok(
        aliases.length >= 5,
        `expected to mine tool aliases from ${binary.version}, found ${aliases.length}`,
      );
      for (const anchor of ['Bash', 'Read', 'Write', 'WebFetch', 'Tmux']) {
        assert.ok(builtins.includes(anchor), `mined inventory must contain ${anchor}`);
      }

      const denied = new Set(CLI_BUILTIN_TOOL_DENYLIST);
      const undeniedBuiltins = builtins.filter((name) => !denied.has(name));
      const undeniedAliases = aliases.filter((name) => !denied.has(name));

      assert.deepEqual(
        undeniedBuiltins,
        [],
        `CLI ${binary.version} declares built-in tools the deny list does not name: ` +
          `${undeniedBuiltins.join(', ')}`,
      );
      // #1015 review — `RunWorkflow` (alias of `Workflow`, and its metadata
      // declares `enablesCodeExecution`) and the three MCP-resource short
      // forms were missing here, beside their `…Tool` canonical names.
      assert.deepEqual(
        undeniedAliases,
        [],
        `CLI ${binary.version} declares tool aliases the deny list does not name: ` +
          `${undeniedAliases.join(', ')}`,
      );
    });
  });
});
