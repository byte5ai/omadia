/**
 * `claude-cli` wire-format adapter (#309, Shape 2 — keyless, tool-less).
 *
 * Drives the local official `claude` CLI as a single-shot completion endpoint on
 * the operator's subscription, so high-volume tool-less calls (session summary,
 * fact extraction, classifier, verifier-judge) can run on a Claude Pro/Max plan
 * instead of a metered API key. omadia keeps its own orchestration loop; this
 * provider only answers one prompt at a time.
 *
 * It is NOT an HTTP adapter: `build()` returns an `LlmProvider` whose
 * `complete()` spawns `claude -p --output-format json` with the API-key env
 * scrubbed (subscription path, #309 §2) and the prompt on stdin (never argv).
 * Tools are not supported — full-tool subscription agents are the separate
 * CLI-owns-loop path (Shape 3). Streaming is emulated as a single delta.
 *
 * Auth is host capability: if the CLI is not logged in, `complete()` rejects and
 * `classifyError` reports a non-retryable auth error.
 */
import { spawn } from 'node:child_process';

import type {
  LlmAdapter,
  LlmAdapterBuildOptions,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmErrorClassification,
  ProviderCapabilities,
  ChatMessage,
  ContentPart,
  SystemBlock,
  ToolSpec,
} from '@omadia/llm-provider';

import { scrubbedEnv } from './cliBackendDetector.js';

const CLI_BIN = 'claude';
const COMPLETE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const CAPABILITIES: ProviderCapabilities = {
  // No general agent-loop tool use over this single-shot provider — that path
  // is Shape 3 (CliChatAgent owns the loop). But the FORCED single-tool
  // structured-output pattern (verifier claimExtractor / evidenceJudge:
  // `toolChoice:{type:'tool'}`) IS supported via a JSON-schema prompt (below).
  tools: false,
  vision: false,
  streaming: false,
  promptCaching: false,
  forcedToolChoice: true,
  parallelToolCalls: false,
};

function textOfContent(content: ReadonlyArray<ContentPart>): string {
  return content
    .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? stringifyToolResult(p) : ''))
    .filter(Boolean)
    .join('\n');
}

function stringifyToolResult(part: Extract<ContentPart, { type: 'tool_result' }>): string {
  if (typeof part.content === 'string') return part.content;
  return part.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function systemText(system: LlmRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return (system as ReadonlyArray<SystemBlock>).map((b) => b.text).join('\n\n');
}

function buildPrompt(messages: ReadonlyArray<ChatMessage>): string {
  // Tool-less single-shot: render the turns as a plain transcript. Most callers
  // send one user message (summary/classify/judge), so this stays compact.
  return messages
    .map((m) => {
      const text = textOfContent(m.content).trim();
      if (!text) return '';
      const label = m.role === 'assistant' ? 'Assistant' : 'Human';
      return `${label}: ${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

interface CliResultJson {
  result?: string;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

/** Parse the first top-level JSON object in the CLI output (tolerates a stray
 *  leading progress/warning line). Returns undefined if none parses. */
function parseResultJson(out: string): CliResultJson | undefined {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(out.slice(start, end + 1)) as CliResultJson;
  } catch {
    return undefined;
  }
}

/** Registry modelIds are `<alias>-cli` to avoid alias collisions; the CLI wants
 *  the bare alias (`opus`/`sonnet`/`haiku`) or a full model id. */
function toCliModel(model: string): string {
  return model.replace(/-cli$/, '');
}

/** The FORCED single-tool structured-output pattern: `toolChoice:{type:'tool'}`
 *  naming a tool present in `tools` (the verifier's claimExtractor/evidenceJudge),
 *  or `required` with exactly one tool. Returns that spec, else undefined.
 *  General/auto multi-tool use is NOT this — it stays rejected (needs Shape 3). */
function forcedTool(req: LlmRequest): ToolSpec | undefined {
  const tc = req.toolChoice;
  if (!req.tools || req.tools.length === 0 || !tc) return undefined;
  if (tc.type === 'tool' && tc.name) return req.tools.find((t) => t.name === tc.name);
  if (tc.type === 'required' && req.tools.length === 1) return req.tools[0];
  return undefined;
}

/** Instruction appended to the prompt so `claude -p` emits ONLY the tool's
 *  arguments as JSON — which we parse back into a synthetic tool_call. */
function structuredSuffix(tool: ToolSpec): string {
  return [
    '',
    `You MUST produce the arguments for the tool \`${tool.name}\`${tool.description ? ` (${tool.description})` : ''}.`,
    'Respond with ONLY a single JSON object — no prose, no markdown fences — whose',
    'shape matches this JSON schema exactly:',
    JSON.stringify(tool.inputSchema),
  ].join('\n');
}

/** Parse the first top-level JSON object out of arbitrary text. */
function parseFirstJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function runClaude(req: LlmRequest): Promise<LlmResponse> {
  const forced = forcedTool(req);
  // Fail CLOSED on GENERAL/auto tool use — only the forced single-tool
  // structured-output pattern is served (via JSON-schema prompt). General
  // tool loops need the CLI to own the loop (Shape 3 / CliChatAgent).
  if (req.tools && req.tools.length > 0 && !forced) {
    return Promise.reject(
      new Error(
        'claude-cli provider supports only forced single-tool structured output, not general tool use',
      ),
    );
  }

  const args = ['-p', '--output-format', 'json', '--model', toCliModel(req.model)];
  const sys = systemText(req.system);
  if (sys) args.push('--append-system-prompt', sys);
  const prompt = forced
    ? `${buildPrompt(req.messages)}\n${structuredSuffix(forced)}`
    : buildPrompt(req.messages);

  return new Promise<LlmResponse>((resolve, reject) => {
    const child = spawn(CLI_BIN, args, { env: scrubbedEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let tooBig = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude-cli completion timed out'));
    }, COMPLETE_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        tooBig = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (tooBig) {
        reject(new Error('claude-cli output exceeded the size limit'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude-cli exited ${code}: ${(stderr || stdout).slice(0, 500).trim()}`));
        return;
      }
      // Be tolerant of a stray progress/warning line on stdout: parse the first
      // top-level JSON object rather than assuming the whole stream is clean JSON.
      const parsed = parseResultJson(stdout);
      if (!parsed) {
        reject(new Error(`claude-cli returned non-JSON output: ${stdout.slice(0, 300)}`));
        return;
      }
      if (parsed.is_error) {
        reject(new Error(`claude-cli reported an error: ${(parsed.result ?? '').slice(0, 300)}`));
        return;
      }
      const text = parsed.result ?? '';
      const usage = {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        ...(parsed.usage?.cache_read_input_tokens !== undefined
          ? { cacheReadTokens: parsed.usage.cache_read_input_tokens }
          : {}),
      };
      if (forced) {
        const argsObj = parseFirstJsonObject(text);
        if (!argsObj) {
          reject(
            new Error(
              `claude-cli forced-tool '${forced.name}': model did not return parseable JSON args`,
            ),
          );
          return;
        }
        resolve({
          content: [
            { type: 'tool_call', id: `call_${forced.name}`, name: forced.name, input: argsObj },
          ],
          finishReason: 'tool_calls',
          providerFinishReason: 'tool_use',
          model: req.model,
          usage,
        });
        return;
      }
      resolve({
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: req.model,
        usage,
      });
    });

    if (prompt) child.stdin.write(prompt);
    child.stdin.end();
  });
}

function classifyError(err: unknown): LlmErrorClassification {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/not logged in|logged out|unauthorized|credential|please run.*login|\/login/.test(msg)) {
    return { retryable: false, kind: 'auth' };
  }
  if (/rate.?limit|429|too many/.test(msg)) return { retryable: true, kind: 'rate_limit' };
  if (/overload|529|capacity/.test(msg)) return { retryable: true, kind: 'overloaded' };
  return { retryable: false, kind: 'other' };
}

function createClaudeCliProvider(opts: LlmAdapterBuildOptions): LlmProvider {
  return {
    id: opts.id ?? 'claude-cli',
    capabilities: CAPABILITIES,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      return runClaude(req);
    },
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      // The CLI completes in one shot; surface it as a single delta + final.
      const response = await runClaude(req);
      const text = response.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      if (text) yield { type: 'text_delta', text };
      yield { type: 'final', response };
    },
    classifyError,
  };
}

export const claudeCliAdapter: LlmAdapter = {
  wireFormat: 'claude-cli',
  build: createClaudeCliProvider,
};

/** Register the claude-cli adapter into a registry (call at boot). */
export function registerClaudeCliAdapter(registry: {
  register(a: LlmAdapter): void;
}): void {
  registry.register(claudeCliAdapter);
}
