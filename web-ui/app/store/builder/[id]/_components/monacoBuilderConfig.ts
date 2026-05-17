/**
 * Shared Monaco-editor configuration for Builder-workspace TypeScript /
 * TSX slots. Monaco's TypeScript service is GLOBAL — settings applied
 * by the first editor that mounts win until another mount overrides them.
 *
 * Without this configuration:
 *   - JSX is unrecognised (every `<div>` flagged as syntax error)
 *   - Strict-mode diagnostics fire on intentional any-casts in operator
 *     prototypes
 *   - File-extension handling assumes plain .ts (TSX paths lose JSX mode
 *     until compiler options enable it)
 *
 * `SlotEditor` (full pane) and `InlineSlotEditor` (per-page TSX/HTML slot)
 * both call `configureMonacoForBuilder(monaco)` on mount so the operator
 * sees clean diagnostics regardless of which editor opens first.
 *
 * The settings here are deliberately MORE permissive than the codegen-side
 * tsconfig (which is strict + NodeNext + `jsx: react-jsx`). The build-time
 * tsc gate is authoritative for correctness; the in-browser Monaco service
 * is a typing aid, not a verdict.
 */

interface MonacoTypescriptNS {
  languages: {
    typescript: {
      typescriptDefaults: {
        setCompilerOptions: (opts: Record<string, unknown>) => void;
        setDiagnosticsOptions: (opts: Record<string, unknown>) => void;
      };
      ScriptTarget: { ES2022: number };
      ModuleKind: { ESNext: number };
      ModuleResolutionKind: { NodeJs: number };
      JsxEmit: { Preserve: number };
    };
  };
}

/**
 * Apply Builder-wide TypeScript settings to a Monaco namespace. Idempotent
 * across multiple calls — Monaco's defaults object replaces options on each
 * call, not merges, so re-applying the same settings is safe.
 */
export function configureMonacoForBuilder(monaco: unknown): void {
  const m = monaco as MonacoTypescriptNS;
  m.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: m.languages.typescript.ScriptTarget.ES2022,
    module: m.languages.typescript.ModuleKind.ESNext,
    moduleResolution: m.languages.typescript.ModuleResolutionKind.NodeJs,
    // JsxEmit.Preserve keeps JSX tokens intact rather than emitting
    // createElement calls — Monaco only needs to PARSE them, not emit.
    // This is what unblocks the editor for react-ssr `ui-<id>-component`
    // slots (the slot body is pure TSX with no React-import).
    jsx: m.languages.typescript.JsxEmit.Preserve,
    strict: false,
    noImplicitAny: false,
    esModuleInterop: true,
    allowJs: true,
    skipLibCheck: true,
  });
  m.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
}
