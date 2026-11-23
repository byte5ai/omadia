/**
 * Diagnostic of the Plugin Builder's tool bridge (`bridgeBuilderTool` in
 * builderAgent). Fires when the bridged
 * `input_schema.properties` ends up empty even though the source Zod
 * schema looks structurally rich. The most common trigger is a Zod schema
 * crossing a module boundary (plugin loads its own `zod` instance) where
 * the walker fails to recognise the constructor/typeName and falls into
 * the `return {}` branch — surfacing the case here means the next
 * suspicious plugin call leaves a breadcrumb in the kernel log instead
 * of silently delivering an empty parameter list to Claude.
 *
 * `z.object({})` is a legitimate "no parameters" schema (some tools
 * intentionally take no arguments) so we don't warn when `_def.shape`
 * was explicitly empty — only when the Zod input claims to have shape
 * but the walker couldn't extract it.
 */
export function warnIfEmptyInputSchema(
  toolId: string,
  zodInput: unknown,
  bridgedProperties: Record<string, unknown>,
): void {
  if (Object.keys(bridgedProperties).length > 0) return;
  const def = (zodInput as { _def?: { typeName?: string; shape?: () => unknown } })._def;
  const typeName = def?.typeName ?? '(no typeName)';
  // If this really is a ZodObject and its shape is genuinely empty (e.g.
  // `z.object({})`), that's intentional — no warning.
  if (typeName === 'ZodObject') {
    try {
      const shape = def?.shape?.() ?? {};
      if (Object.keys(shape as Record<string, unknown>).length === 0) return;
    } catch {
      // Walking the shape threw — that itself is suspicious, fall through
      // to the warning.
    }
  }
  const ctor =
    (zodInput as { constructor?: { name?: string } } | null)?.constructor
      ?.name ?? '(unknown)';
  console.warn(
    `[tool-bridge] tool '${toolId}' bridged with empty input_schema.properties — ` +
      `Zod typeName='${typeName}' ctor='${ctor}'. ` +
      `Claude will see a tool with no parameters; either the walker doesn't ` +
      `support this Zod type or the schema was lost crossing a module boundary.`,
  );
}
