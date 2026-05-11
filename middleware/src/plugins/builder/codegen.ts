import yaml from 'yaml';

import { type AgentSpec, validateSpecForCodegen } from './agentSpec.js';
import {
  loadBoilerplate,
  type BoilerplateBundle,
  type SlotDef,
  type TemplateManifest,
} from './boilerplateSource.js';
import { lookupServiceType } from './serviceTypeRegistry.js';

/**
 * CodegenEngine — turns an AgentSpec + slot map into a `Map<relPath, Buffer>`
 * that the build sandbox (B.2) feeds to `tsc + zip`.
 *
 * Pipeline per file:
 *   1. (manifest.yaml only) clone the capability template once per
 *      `spec.tools[i]` via YAML-AST manipulation, before any string
 *      substitution runs.
 *   2. Slot injection: replace the body between
 *      `// #region builder:<key>` (or `<!-- #region builder:<key> -->`)
 *      and `// #endregion` with the user-provided slot text. Markers
 *      themselves are preserved so the next codegen round still finds
 *      them; missing required slot → throw before we get this far.
 *      Marker missing while a slot was supplied → throw (fail-loud).
 *   3. Placeholder substitution: replace `{{TOKEN}}` against the map
 *      derived from `template.placeholders` (per spec) plus the per-tool
 *      placeholders if `spec.tools.length === 1`.
 *   4. Path placeholders: filenames like `skills/{{AGENT_SLUG}}-expert.md`
 *      get rewritten using the same map.
 *   5. No-residue check: any `{{TOKEN}}` left in any text file is an error.
 */

export interface GenerateOptions {
  spec: AgentSpec;
  /** Slot contents; merged on top of `spec.slots`. Required slots must
   *  resolve from this combined map. */
  slots?: Record<string, string>;
}

export interface CodegenIssue {
  code:
    | 'spec_validation'
    | 'missing_required_slot'
    | 'missing_marker'
    | 'placeholder_residue';
  detail: string;
}

export class CodegenError extends Error {
  readonly issues: readonly CodegenIssue[];
  constructor(issues: readonly CodegenIssue[]) {
    super(`Codegen failed (${issues.length} issue${issues.length === 1 ? '' : 's'})`);
    this.name = 'CodegenError';
    this.issues = issues;
  }
}

const TEXT_FILE_EXTS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.txt',
  // S+7.7 — Operator-Admin-UI bundle. HTML lives under
  // `assets/admin-ui/` and carries `<!-- #region builder:... -->` markers
  // plus `{{TOKEN}}` placeholders. Without this the file would be copied
  // as a binary buffer and the agent's slot content would never reach disk.
  '.html',
]);

function isTextFile(relPath: string): boolean {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return false;
  return TEXT_FILE_EXTS.has(relPath.slice(dot).toLowerCase());
}

function deriveAgentSlug(spec: AgentSpec): string {
  // Split on `.` (legacy `de.byte5.agent.X`) or `/` (post-Welle-1 `@omadia/X`)
  // so the npm-scope namespace doesn't end up in generated filenames.
  return spec.id.split(/[./]/).pop() ?? spec.id;
}

function resolveSource(spec: AgentSpec, source: string): string | undefined {
  if (source.startsWith('__derived__/')) {
    const key = source.slice('__derived__/'.length);
    if (key === 'agentSlug') return deriveAgentSlug(spec);
    return undefined;
  }

  // dotted path with optional `[i]` indexing per token.
  const tokens = source.split('.');
  let cur: unknown = spec;
  for (const token of tokens) {
    if (cur === undefined || cur === null) return undefined;
    const idxMatch = /^([a-z_]+)\[(\d+)\]$/.exec(token);
    if (idxMatch) {
      const key = idxMatch[1] as string;
      const idx = Number(idxMatch[2]);
      const arr = (cur as Record<string, unknown>)[key];
      if (!Array.isArray(arr)) return undefined;
      cur = arr[idx];
    } else {
      cur = (cur as Record<string, unknown>)[token];
    }
  }

  if (cur === undefined || cur === null) return undefined;
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return undefined;
}

interface PlaceholderMapResult {
  map: Map<string, string>;
  /** Tokens declared in the template manifest whose source path resolved
   *  to undefined. The codegen step bails before per-file processing so
   *  the user gets one actionable error per missing source instead of
   *  one residue-warning per file the placeholder appears in. */
  unresolved: Array<{ token: string; source: string }>;
}

function buildPlaceholderMap(
  spec: AgentSpec,
  manifest: TemplateManifest,
): PlaceholderMapResult {
  const map = new Map<string, string>();
  const unresolved: Array<{ token: string; source: string }> = [];
  for (const [token, source] of Object.entries(manifest.placeholders)) {
    const value = resolveSource(spec, source);
    if (value !== undefined) {
      map.set(token, value);
    } else {
      unresolved.push({ token, source });
    }
  }
  // Per-tool placeholders. Manifest.yaml's `capabilities[]` is reproduced
  // via YAML-AST (see reproduceManifestCapabilities) before string sub
  // runs; toolkit.ts has its `{{CAPABILITY_ID}}` inside the toolkit-impl
  // marker region (replaced by slot content). What's left is incidental
  // doc references (README.md "example placeholders" list, comments) — we
  // back those with the first tool so the build still succeeds. Multi-
  // tool agents are documented via the manifest, not the README.
  const firstTool = spec.tools[0];
  if (firstTool) {
    map.set('CAPABILITY_ID', firstTool.id);
    map.set('CAPABILITY_DESCRIPTION_DE', firstTool.description);
  }
  return { map, unresolved };
}

/**
 * Friendly hint per known placeholder source. Maps the manifest source
 * path (e.g. `depends_on[0]`) to a "do this" instruction the user can
 * action without reading the codegen internals.
 */
function placeholderHintFor(source: string): string {
  if (source === 'depends_on[0]') {
    return 'Set spec.depends_on to an integration plugin id (e.g. ' +
      'de.byte5.integration.confluence) — the agent-integration template ' +
      'requires at least one entry to wire the vault scope.';
  }
  if (source === 'id') return 'Set spec.id to a reverse-FQDN (e.g. de.byte5.agent.example).';
  if (source === 'name') return 'Set spec.name to a human-readable agent name.';
  if (source === 'category') return 'Set spec.category (e.g. "communication", "analytics").';
  if (source === 'skill.role') return 'Set spec.skill.role to describe the agent\'s persona.';
  if (source === 'description') return 'Set spec.description to a one-line summary.';
  if (source.startsWith('playbook.')) {
    return `Fill spec.${source} so the playbook section in README.md/manifest.yaml has content.`;
  }
  if (source.startsWith('network.outbound')) {
    return 'Add the outbound host(s) the agent calls to spec.network.outbound.';
  }
  return `Set spec.${source} so the placeholder can be resolved.`;
}

function substitutePlaceholders(
  text: string,
  map: ReadonlyMap<string, string>,
): string {
  let result = text;
  for (const [token, value] of map) {
    result = result.split(`{{${token}}}`).join(value);
  }
  return result;
}

// Matches both TS-style `// #region builder:<key>` + `// #endregion` and
// HTML/MD-style `<!-- #region builder:<key> -->` + `<!-- #endregion -->`.
// Capturing groups: 1 = key, 2 = body.
const REGION_RE =
  /(?:\/\/|<!--)\s*#region\s+builder:([a-z][a-z0-9_-]*)\s*(?:-->\s*)?\n([\s\S]*?)\n[ \t]*(?:\/\/|<!--)\s*#endregion(?:\s*-->)?/g;

interface RegionMatch {
  key: string;
  start: number;
  end: number;
  openLine: string;
  closeLine: string;
}

function findRegions(text: string): RegionMatch[] {
  const out: RegionMatch[] = [];
  let m: RegExpExecArray | null;
  REGION_RE.lastIndex = 0;
  while ((m = REGION_RE.exec(text)) !== null) {
    const matchText = m[0] ?? '';
    const lines = matchText.split('\n');
    const openLine = lines[0] ?? '';
    const closeLine = lines[lines.length - 1] ?? '';
    out.push({
      key: m[1] ?? '',
      start: m.index,
      end: m.index + matchText.length,
      openLine,
      closeLine,
    });
  }
  return out;
}

/**
 * Public slot-region extractor used by the OB-46 ESLint persist-back
 * pass. Given a (post-codegen, post-ESLint) file body, returns one entry
 * per `// #region builder:<key>` / `// #endregion` (or HTML-comment
 * equivalent) marker pair, with `body` being the lines between the
 * markers (exclusive). The body matches the convention used by
 * `injectSlots()`: no trailing newline, but newlines preserved between
 * lines inside the slot.
 *
 * Distinct shape from `RegionMatch` (private) on purpose: the persist-
 * back pass doesn't care about `start`/`end`/`openLine` — it just needs
 * the slot text.
 */
export interface SlotRegionMatch {
  key: string;
  body: string;
}

export function extractSlotRegions(text: string): SlotRegionMatch[] {
  return findRegions(text).map((r) => {
    const inner = text.slice(r.start, r.end);
    // Drop the opening marker line + its newline, and the closing marker
    // line + the newline before it. The match is greedy enough that
    // both marker lines are present in the slice.
    const afterOpen = inner.slice(r.openLine.length + 1);
    const closeLineWithLeadingNewline = `\n${r.closeLine}`;
    const idx = afterOpen.lastIndexOf(closeLineWithLeadingNewline);
    const body = idx >= 0 ? afterOpen.slice(0, idx) : afterOpen;
    return { key: r.key, body };
  });
}

function injectSlots(
  text: string,
  fileTargetSlots: readonly SlotDef[],
  providedSlots: Readonly<Record<string, string>>,
  filePath: string,
  issues: CodegenIssue[],
): string {
  let result = text;
  for (const slot of fileTargetSlots) {
    const provided = providedSlots[slot.key];
    const regions = findRegions(result).filter((r) => r.key === slot.key);
    if (regions.length === 0) {
      if (provided !== undefined) {
        issues.push({
          code: 'missing_marker',
          detail: `Slot '${slot.key}' provided but no marker region found in '${filePath}'`,
        });
      }
      continue;
    }
    if (provided === undefined) continue; // marker present, no slot → keep default
    const region = regions[0]!;
    const before = result.slice(0, region.start);
    const after = result.slice(region.end);
    const body = provided.endsWith('\n') ? provided.slice(0, -1) : provided;
    result = `${before}${region.openLine}\n${body}\n${region.closeLine}${after}`;
  }
  return result;
}

function reproduceManifestCapabilities(
  manifestText: string,
  spec: AgentSpec,
): string {
  const doc = yaml.parseDocument(manifestText);

  // depends_on overwrite (B.6-9.1) — the boilerplate ships
  // `depends_on: []` as a static placeholder; we replace it with
  // `spec.depends_on` so self-contained agents (PAT/OAuth in their own
  // setup_fields, no parent integration plugin) ship with `[]` instead of
  // failing the codegen on a residue check, while real-integration agents
  // get the proper block-list. Done at AST level so YAML formatting stays
  // canonical for either shape.
  const dependsOnNode = doc.createNode(spec.depends_on);
  doc.set('depends_on', dependsOnNode);

  // admin_ui_path injection (S+7.7) — when the agent ships an
  // operator-admin UI, the manifest needs the top-level `admin_ui_path`
  // field so manifestLoader.ts:212 picks it up after install and web-ui
  // can iframe the URL. Boilerplate's manifest.yaml does not contain the
  // field by default (most agents don't have a UI), so we ADD it here
  // only when the spec carries a value. Done at AST level after
  // depends_on so the field lands at the document's top level, not
  // nested under depends_on.
  if (spec.admin_ui_path) {
    doc.set('admin_ui_path', spec.admin_ui_path);
  }

  // setup.fields overwrite (live-fix 2026-05-01) — previously the
  // boilerplate's `setup: { fields: [] }` shipped as-is, so a self-
  // contained agent that asks for github_org + github_token in the
  // builder ended up with NO declared setup_fields after install.
  // The store-detail page reads these from the installed manifest and
  // had nothing to render. Now we map spec.setup_fields → manifest
  // setup.fields with the manifest's expected shape (key/type/label/
  // help/required/default + enum-with-{value,label}-shape).
  const setupNode = doc.get('setup', true);
  if (yaml.isMap(setupNode)) {
    const fieldsForManifest = spec.setup_fields.map((f) =>
      mapSetupFieldSpecToManifest(f),
    );
    setupNode.set('fields', doc.createNode(fieldsForManifest));
  } else {
    // No setup block in template — create one so the install path can
    // still surface required_secrets.
    doc.set(
      'setup',
      doc.createNode({
        fields: spec.setup_fields.map((f) => mapSetupFieldSpecToManifest(f)),
        self_test: false,
      }),
    );
  }

  const capsNode = doc.get('capabilities', true);
  if (!yaml.isSeq(capsNode) || capsNode.items.length === 0) {
    return doc.toString();
  }

  if (spec.tools.length <= 1) {
    // 0 tools: clear the array (placeholder cap is meaningless without a tool).
    // 1 tool:  default boilerplate already shapes one cap; placeholder
    //          substitution finishes the job.
    if (spec.tools.length === 0) capsNode.items = [];
    return doc.toString();
  }

  // Multi-tool: clone the first cap once per tool, baking each tool's id +
  // description into the per-clone copy. Placeholder substitution still runs
  // afterwards over the resulting YAML to handle anything else in the block.
  const templateNode = capsNode.items[0] as yaml.Node;
  const templateJson = templateNode.toJSON() as unknown;
  const newItems = spec.tools.map((tool) => {
    const cloneJson = JSON.parse(JSON.stringify(templateJson)) as unknown;
    const baked = bakePerToolPlaceholders(cloneJson, tool.id, tool.description);
    return doc.createNode(baked);
  });
  capsNode.items = newItems as typeof capsNode.items;
  return doc.toString();
}

/**
 * Maps an AgentSpec.setup_fields[] entry to the shape expected by the
 * platform manifest schema (`docs/harness-platform/manifest-schema.v1.yaml`):
 *   spec.description       → manifest.help
 *   spec.enum_values        → manifest.enum: [{ value, label }]
 *   manifest.label          → derived from spec.key when not set in spec
 *                             (Title-Case, underscores → spaces)
 * Required-flag defaults to true (matches boilerplate convention).
 */
function mapSetupFieldSpecToManifest(
  field: AgentSpec['setup_fields'][number],
): Record<string, unknown> {
  const label = humanizeKey(field.key);
  const out: Record<string, unknown> = {
    key: field.key,
    type: field.type,
    label,
    required: field.required ?? true,
  };
  if (field.description) out['help'] = field.description;
  if (field.default !== undefined) out['default'] = field.default;
  if (field.enum_values && field.enum_values.length > 0) {
    out['enum'] = field.enum_values.map((value) => ({ value, label: value }));
  }
  return out;
}

function humanizeKey(key: string): string {
  return key
    .split('_')
    .map((part) =>
      part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1),
    )
    .join(' ');
}

function bakePerToolPlaceholders(
  node: unknown,
  toolId: string,
  toolDescription: string,
): unknown {
  if (typeof node === 'string') {
    return node
      .split('{{CAPABILITY_ID}}')
      .join(toolId)
      .split('{{CAPABILITY_DESCRIPTION_DE}}')
      .join(toolDescription);
  }
  if (Array.isArray(node)) {
    return node.map((item) => bakePerToolPlaceholders(item, toolId, toolDescription));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = bakePerToolPlaceholders(v, toolId, toolDescription);
    }
    return out;
  }
  return node;
}

const RESIDUE_RE = /\{\{[A-Z][A-Z0-9_]*\}\}/g;

function collectResidue(text: string): string[] {
  const matches = text.match(RESIDUE_RE);
  if (!matches) return [];
  return [...new Set(matches)];
}

// --- External-reads (Theme A) --------------------------------------------
// Synthesises code chunks the LLM used to write by hand (and got wrong —
// see lessons-learned 2026-05-04: invented `odoo.execute_kw(...)` from
// training memory). Two artefacts:
//   - imports: top-of-file `import { z }` + `import type { Service } …`
//     lines, slotted into `external-reads-imports`
//   - body: `ctx.services.get(...)` lookups + tool descriptors that get
//     pushed onto the toolkit, slotted into `external-reads-init`
// Plus a `peerDependencies` map merged into package.json so the
// `import type` lines resolve at tsc time (B.7 gate).

interface ExternalReadsArtifacts {
  imports: string;
  body: string;
  peerDependencies: Record<string, string>;
}

function svcVarName(serviceName: string): string {
  return '__svc_' + serviceName.replace(/[^a-z0-9]/gi, '_');
}

function buildExternalReadsArtifacts(spec: AgentSpec): ExternalReadsArtifacts {
  const empty: ExternalReadsArtifacts = {
    imports: '',
    body: '',
    peerDependencies: {},
  };
  if (spec.external_reads.length === 0) return empty;

  // Resolve services + collect unique typeImports per package. Unknown
  // services are surfaced as a CodegenIssue so the user gets feedback at
  // the same gate where slot/placeholder issues land — instead of seeing a
  // garbage `undefined` lookup at activate-time. ManifestLinter already
  // catches this earlier when it runs (patch_spec / fill_slot path), but
  // generate() is also called by `lint_spec` and other paths that bypass
  // the linter, so we re-check here defensively.
  const serviceToReg = new Map<
    string,
    { providedBy: string; typeFrom: string; typeName: string }
  >();
  for (const er of spec.external_reads) {
    if (serviceToReg.has(er.service)) continue;
    const reg = lookupServiceType(er.service);
    if (!reg) {
      throw new CodegenError([
        {
          code: 'spec_validation',
          detail:
            `external_reads references unknown service '${er.service}'. ` +
            'See `serviceTypeRegistry.ts` for the supported names.',
        },
      ]);
    }
    serviceToReg.set(er.service, {
      providedBy: reg.providedBy,
      typeFrom: reg.typeImport.from,
      // Strip array suffix for the `import type` statement; kept verbatim
      // for the variable type annotation below.
      typeName: reg.typeImport.name.endsWith('[]')
        ? reg.typeImport.name.slice(0, -2)
        : reg.typeImport.name,
    });
  }

  // --- Imports ---
  const importLines: string[] = [];
  importLines.push("import { z } from 'zod';");
  importLines.push("import type { ToolDescriptor } from './toolkit.js';");
  // Group typed imports by package, deterministic order.
  const importsByPkg = new Map<string, Set<string>>();
  for (const reg of serviceToReg.values()) {
    const set = importsByPkg.get(reg.typeFrom) ?? new Set<string>();
    set.add(reg.typeName);
    importsByPkg.set(reg.typeFrom, set);
  }
  const sortedPkgs = [...importsByPkg.keys()].sort();
  for (const pkg of sortedPkgs) {
    const names = [...(importsByPkg.get(pkg) ?? new Set())].sort();
    importLines.push(`import type { ${names.join(', ')} } from '${pkg}';`);
  }

  // --- Body ---
  const bodyLines: string[] = [];
  bodyLines.push('// Service lookups — one per unique service in spec.external_reads.');
  // Sort services for deterministic generated output.
  const sortedServices = [...serviceToReg.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [serviceName, reg] of sortedServices) {
    const v = svcVarName(serviceName);
    const fullType = reg.typeName;
    bodyLines.push(
      `const ${v} = ctx.services.get<${fullType}>('${serviceName}');`,
      `if (!${v}) {`,
      `  throw new Error(`,
      `    "external_reads: service '${serviceName}' is not registered — " +`,
      `      "ensure '${reg.providedBy}' is in spec.depends_on and installed.",`,
      `  );`,
      `}`,
    );
  }
  bodyLines.push('');
  bodyLines.push(
    '// Tool descriptors generated from spec.external_reads. The Toolkit',
    '// interface marks `tools` readonly; codegen casts to mutable to push',
    '// because the underlying array is mutable and adding entries here is',
    '// the supported extension point for declarative reads.',
  );
  bodyLines.push(
    'const __externalReadsTools = toolkit.tools as Array<ToolDescriptor<unknown, unknown>>;',
  );

  for (const er of spec.external_reads) {
    const v = svcVarName(er.service);
    const positional = er.args.map((a) => JSON.stringify(a)).join(', ');
    const hasKwargs = Object.keys(er.kwargs).length > 0;
    const kwargsLiteral = hasKwargs ? JSON.stringify(er.kwargs) : '';
    const callArgs =
      positional && hasKwargs
        ? `${positional}, ${kwargsLiteral}`
        : positional || kwargsLiteral;

    bodyLines.push('');
    bodyLines.push(`__externalReadsTools.push({`);
    bodyLines.push(`  id: ${JSON.stringify(er.id)},`);
    bodyLines.push(`  description: ${JSON.stringify(er.description)},`);
    bodyLines.push(`  input: z.object({}) as z.ZodType<unknown>,`);
    bodyLines.push(`  async run(_input: unknown): Promise<unknown> {`);
    bodyLines.push(
      `    const __raw: unknown = await (${v} as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[${JSON.stringify(er.method)}]!(${callArgs});`,
    );
    if (er.result_mapping && Object.keys(er.result_mapping).length > 0) {
      bodyLines.push(`    const __src = __raw as Record<string, unknown>;`);
      bodyLines.push(`    const __mapped: Record<string, unknown> = {};`);
      for (const [outKey, srcPath] of Object.entries(er.result_mapping)) {
        bodyLines.push(
          `    __mapped[${JSON.stringify(outKey)}] = __src?.[${JSON.stringify(srcPath)}];`,
        );
      }
      bodyLines.push(`    return __mapped;`);
    } else {
      bodyLines.push(`    return __raw;`);
    }
    bodyLines.push(`  },`);
    bodyLines.push(`});`);
  }

  // --- peerDependencies ---
  const peerDependencies: Record<string, string> = {};
  for (const pkg of sortedPkgs) {
    peerDependencies[pkg] = '*';
  }

  return {
    imports: importLines.join('\n'),
    body: bodyLines.join('\n'),
    peerDependencies,
  };
}

/**
 * Merges codegen-managed peerDependencies into the agent's package.json
 * before placeholder substitution. Idempotent — existing entries with
 * non-`*` versions are left untouched (operator override wins).
 */
function mergePeerDependencies(
  packageJsonText: string,
  toAdd: Record<string, string>,
): string {
  if (Object.keys(toAdd).length === 0) return packageJsonText;
  // The boilerplate package.json contains `{{AGENT_ID}}`-style strings
  // (valid JSON). JSON.parse → mutate → re-stringify keeps placeholders
  // intact for the later substitution pass.
  const obj = JSON.parse(packageJsonText) as Record<string, unknown>;
  const peers = (obj['peerDependencies'] as Record<string, string> | undefined) ?? {};
  for (const [pkg, version] of Object.entries(toAdd)) {
    if (!(pkg in peers)) peers[pkg] = version;
  }
  obj['peerDependencies'] = peers;
  return JSON.stringify(obj, null, 2) + '\n';
}

export async function generate(
  opts: GenerateOptions,
): Promise<Map<string, Buffer>> {
  const { spec, slots = {} } = opts;
  const issues: CodegenIssue[] = [];

  // 1. Cross-field spec validation
  for (const issue of validateSpecForCodegen(spec)) {
    issues.push({ code: 'spec_validation', detail: issue.reason });
  }
  if (issues.length > 0) throw new CodegenError(issues);

  // 2. Load template
  const bundle: BoilerplateBundle = await loadBoilerplate(spec.template);
  const manifest = bundle.manifest;

  // 3. Required-slot check (combine spec.slots + opts.slots)
  const allSlots: Record<string, string> = { ...spec.slots, ...slots };
  for (const slot of manifest.slots) {
    if (slot.required && allSlots[slot.key] === undefined) {
      issues.push({
        code: 'missing_required_slot',
        detail: `Required slot '${slot.key}' missing for template '${manifest.id}'`,
      });
    }
  }
  if (issues.length > 0) throw new CodegenError(issues);

  // 3b. Theme A — codegen-managed slots from spec.external_reads. These
  //     overwrite anything the LLM (or a clone-from-installed) might have
  //     left in the slot map; the slots are auto-managed and the
  //     `external-reads-init` / `external-reads-imports` keys are reserved
  //     for codegen output. When `spec.external_reads` is empty the slot
  //     keys stay unset so the boilerplate's default region (just a
  //     comment) survives the inject pass untouched.
  const externalReadsArtifacts = buildExternalReadsArtifacts(spec);
  if (externalReadsArtifacts.imports.length > 0) {
    allSlots['external-reads-imports'] = externalReadsArtifacts.imports;
  }
  if (externalReadsArtifacts.body.length > 0) {
    allSlots['external-reads-init'] = externalReadsArtifacts.body;
  }

  // 4. Build placeholder map. Unresolved sources fail-fast here with one
  //    issue per missing token — without this the per-file residue check
  //    below emits the same problem N times (N = files containing the
  //    token), which buries the actionable signal in noise.
  const { map: placeholderMap, unresolved } = buildPlaceholderMap(
    spec,
    manifest,
  );
  if (unresolved.length > 0) {
    for (const { token, source } of unresolved) {
      issues.push({
        code: 'placeholder_residue',
        detail:
          `Placeholder {{${token}}} could not be resolved — manifest source ` +
          `'${source}' is empty in the spec. ${placeholderHintFor(source)}`,
      });
    }
    throw new CodegenError(issues);
  }

  // 5. Per-file processing
  const out = new Map<string, Buffer>();
  for (const [origPath, content] of bundle.files) {
    const outPath = substitutePlaceholders(origPath, placeholderMap);

    if (!isTextFile(origPath)) {
      out.set(outPath, content);
      continue;
    }

    let text = content.toString('utf-8');

    // 5a. manifest.yaml — capability reproduction before string mangling
    if (origPath === 'manifest.yaml') {
      text = reproduceManifestCapabilities(text, spec);
    }

    // 5a.2. package.json — peerDependencies merge for Theme A. Done before
    //       slot/placeholder passes so the JSON parse sees a literal
    //       `{{AGENT_ID}}` string (still valid JSON) and the substitution
    //       runs over the re-stringified output.
    if (origPath === 'package.json') {
      text = mergePeerDependencies(text, externalReadsArtifacts.peerDependencies);
    }

    // 5b. Slot injection (uses original-path target_file matching too)
    const fileTargetSlots = manifest.slots.filter((s) => {
      const target = substitutePlaceholders(s.target_file, placeholderMap);
      return target === outPath || target === origPath || s.target_file === origPath;
    });
    if (fileTargetSlots.length > 0) {
      text = injectSlots(text, fileTargetSlots, allSlots, outPath, issues);
    }

    // 5c. Placeholder substitution
    text = substitutePlaceholders(text, placeholderMap);

    // 5d. No-residue check
    const residue = collectResidue(text);
    if (residue.length > 0) {
      issues.push({
        code: 'placeholder_residue',
        detail: `Unresolved placeholders in '${outPath}': ${residue.join(', ')}`,
      });
    }

    out.set(outPath, Buffer.from(text, 'utf-8'));
  }

  if (issues.length > 0) throw new CodegenError(issues);

  return out;
}
