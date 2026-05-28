import type { z } from 'zod';
import type { NativeToolHandler, NativeToolSpec } from '@omadia/plugin-api';

/**
 * Bundle a NativeToolSpec + handler with Zod-driven input & output
 * validation. Output validation is the #130 postcondition: a mismatch
 * returns a structured `{ output, postcondition }` shape that the
 * orchestrator's bridgeTool / dispatch wiring lifts onto the RunTrace,
 * and the verifier converts into a `tool_postcondition` claim that
 * drives the existing correctionPrompt retry loop.
 */
export interface DeterministicToolDefinition {
  readonly spec: NativeToolSpec;
  readonly handler: NativeToolHandler;
  /** Optional per-tool prompt-doc — appended to the global Math-Delegation
   *  fragment in the system prompt for agents that have the plugin. */
  readonly promptDoc?: string;
}

export interface DefineToolArgs<I, O> {
  readonly name: string;
  readonly description: string;
  /** Anthropic-side JSON schema. Authored separately from the Zod input
   *  because Anthropic's tool-spec contract rejects unknown fields and the
   *  Zod-to-JSON-schema bridge would otherwise leak `_def` artefacts. */
  readonly inputJsonSchema: NativeToolSpec['input_schema'];
  readonly inputZod: z.ZodType<I>;
  readonly outputZod: z.ZodType<O>;
  readonly run: (input: I) => O | Promise<O>;
  readonly promptDoc?: string;
}

export function defineTool<I, O>(
  args: DefineToolArgs<I, O>,
): DeterministicToolDefinition {
  const { name, description, inputJsonSchema, inputZod, outputZod, run } = args;
  const spec: NativeToolSpec = {
    name,
    description,
    input_schema: inputJsonSchema,
  };
  const handler: NativeToolHandler = async (rawInput) => {
    const parsedInput = inputZod.safeParse(rawInput);
    if (!parsedInput.success) {
      const detail = parsedInput.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return `Error: invalid input for '${name}' — ${detail}`;
    }
    let result: O;
    try {
      result = await run(parsedInput.data);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const parsedOutput = outputZod.safeParse(result);
    if (!parsedOutput.success) {
      // #130 — structured postcondition result. The bridge / native-tool
      // dispatch surfaces this on the RunTrace and the verifier raises a
      // `tool_postcondition` claim, blocking the answer until the LLM
      // re-calls the tool with corrected arguments or picks a different
      // path.
      const issues = parsedOutput.error.issues.map(
        (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
      );
      return {
        output: `[POSTCONDITION_FAILED] tool=${name} issues=${issues.join('; ')}`,
        postcondition: { issues },
      };
    }
    return JSON.stringify(parsedOutput.data);
  };
  return {
    spec,
    handler,
    ...(args.promptDoc ? { promptDoc: args.promptDoc } : {}),
  };
}
