/**
 * Internal `@byte5/*` packages that are deliberately NOT shipped into the
 * build-template `node_modules` and that plugin slots must NEVER import.
 *
 * Source of truth for two consumers:
 *   - `tools/listPackageTypes.ts` — short-circuits with an actionable hint
 *     when the agent tries to look up the types
 *   - `workspaceImportResolver.ts` — pre-tsc gate that catches the same
 *     specifier when it actually shows up in slot source code
 *
 * Keep this list narrow: only entries whose absence is by-design
 * (Standalone-Compile-Contract, boilerplate CLAUDE.md Checklist Point 1).
 * Cross-plugin integrations (`@omadia/integration-*`) are SHIPPED
 * via `serviceTypeRegistry` and must NOT appear here — they remain
 * importable from slots so `external_reads` codegen works.
 */
export const FORBIDDEN_INTERNAL_PACKAGES: ReadonlyMap<string, string> = new Map([
  [
    '@omadia/plugin-api',
    'PluginContext + ServicesAccessor are duplicated locally in the plugin\'s ' +
      './types.ts (boilerplate Checklist Point 1 — packages must compile ' +
      'standalone after zip-upload). Read ./types.ts via read_reference instead, ' +
      'and import PluginContext / ToolDescriptor from \'./types.js\' in slots.',
  ],
  [
    '@omadia/channel-sdk',
    'Channel SDK types are duplicated locally in agent boilerplates — channel ' +
      'plugins (Teams, Slack, Telegram) live in middleware/packages/ and are not ' +
      'meant to be imported from agent slots.',
  ],
]);
