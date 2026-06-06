import { z } from 'zod';

import { safeParseAgentSpec } from '../agentSpec.js';
import { CodegenError, generate, type CodegenIssue } from '../codegen.js';
import type { BuilderTool } from './types.js';

/**
 * Issue #227 — `inspect_generated_artifact`.
 *
 * Read-only window onto the Builder draft's *codegen output* — the rendered
 * `manifest.yaml` / `package.json` / `tsconfig.json` (and every other
 * generated file) that the spec + slots produce. Until this tool existed the
 * codegen synthesis path was a blackbox to the Builder agent: it could lint
 * the spec and gate slots through tsc, but it could not see what the manifest
 * synthesiser actually emitted — so verifying a "the fix now lands
 * `permissions.memory` in the manifest" claim required an operator-driven
 * preview round-trip.
 *
 * Implementation note: `generate()` is a pure function of (spec, slots), so
 * this tool re-runs it on-demand against the current draft rather than
 * reading the build pipeline's staging directory (which is cleaned up after
 * every build). A `CodegenError` is itself signal — it carries the exact
 * placeholder-residue / missing-slot issues the agent needs to act on, so we
 * surface those rather than swallowing them.
 */

const DEFAULT_FILE = 'manifest.yaml';

/** Cap on returned content. The headline artefacts (manifest/package/tsconfig)
 *  are tiny; a generous cap keeps a large slot-backed source file from blowing
 *  the tool_result frame while still covering every real artefact. */
const MAX_BYTES = 128 * 1024;

const InputSchema = z
  .object({
    /**
     * Generated file to read, relative to the plugin root (e.g.
     * `manifest.yaml`, `package.json`, `tsconfig.json`, `src/plugin.ts`).
     * Defaults to `manifest.yaml`. Call once with no args to discover the
     * full file listing via the `availableFiles` field.
     */
    file: z.string().min(1).max(400).optional(),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface OkResult {
  ok: true;
  file: string;
  content: string;
  bytes: number;
  /** Every generated file path, so the agent can pick another artefact. */
  availableFiles: ReadonlyArray<string>;
}
interface ErrResult {
  ok: false;
  error: string;
  hint?: string;
  /** Populated on a codegen failure — the exact issues that blocked
   *  synthesis (placeholder residue, missing required slot, …). This is the
   *  whole point: the agent can now cite *why* the manifest is wrong. */
  issues?: ReadonlyArray<CodegenIssue>;
  /** Populated on a file-not-found miss so the agent can pick a real path. */
  availableFiles?: ReadonlyArray<string>;
}
type Result = OkResult | ErrResult;

export const inspectGeneratedArtifactTool: BuilderTool<Input, Result> = {
  id: 'inspect_generated_artifact',
  description:
    'Read a generated artefact for the current draft — the codegen output, ' +
    'not the spec. `file` defaults to "manifest.yaml" (also useful: ' +
    '"package.json", "tsconfig.json", "src/plugin.ts"). Call with no args to ' +
    'list every generated file. Re-runs codegen on demand; if synthesis ' +
    'fails it returns the exact blocking issues (placeholder residue, missing ' +
    'slot) so you can cite what the manifest is actually missing instead of ' +
    'guessing. Read-only.',
  input: InputSchema,
  async run({ file }, ctx) {
    const draft = await ctx.draftStore.load(ctx.userEmail, ctx.draftId);
    if (!draft) {
      return { ok: false, error: `draft '${ctx.draftId}' not found` };
    }

    const parsed = safeParseAgentSpec(draft.spec);
    if (!parsed.success) {
      return {
        ok: false,
        error:
          'spec does not validate — fix the spec (see lint_spec) before the ' +
          'manifest can be generated',
        hint: parsed.error.issues
          .slice(0, 5)
          .map((i) => `/${i.path.map(String).join('/')}: ${i.message}`)
          .join('; '),
      };
    }

    let files: Map<string, Buffer>;
    try {
      files = await generate({ spec: parsed.data, slots: draft.slots });
    } catch (err) {
      if (err instanceof CodegenError) {
        return {
          ok: false,
          error: `codegen failed (${String(err.issues.length)} issue(s)) — the manifest could not be synthesised`,
          issues: err.issues,
        };
      }
      return {
        ok: false,
        error: `codegen threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const availableFiles = [...files.keys()].sort();
    const target = file ?? DEFAULT_FILE;
    const buf = files.get(target);
    if (!buf) {
      return {
        ok: false,
        error: `generated file '${target}' does not exist`,
        hint: `available: ${availableFiles.join(', ')}`,
        availableFiles,
      };
    }
    if (buf.byteLength > MAX_BYTES) {
      return {
        ok: false,
        error: `generated file '${target}' exceeds ${String(MAX_BYTES)} bytes (size: ${String(buf.byteLength)})`,
        availableFiles,
      };
    }

    return {
      ok: true,
      file: target,
      content: buf.toString('utf-8'),
      bytes: buf.byteLength,
      availableFiles,
    };
  },
};
