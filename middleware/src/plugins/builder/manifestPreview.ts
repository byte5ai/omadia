import type { AgentSpecSkeleton } from './types.js';
import { parseAgentSpec } from './agentSpec.js';
import { generate } from './codegen.js';

/**
 * B.11-9: Renders manifest.yaml as it would appear in the next codegen
 * run. Wraps `generate()` and extracts only the manifest file from
 * the returned bundle so the workspace ManifestDiffSidebar can show
 * the operator the result of their form edits without triggering a
 * full build.
 *
 * If the spec fails strict validation we surface a placeholder yaml
 * comment instead of throwing — the sidebar is informational, the
 * operator already sees real validation errors via the spec-editor
 * inline tier (B.6-10) and the manifestLinter bus events (B.8).
 */
export async function renderManifestPreview(
  skeleton: AgentSpecSkeleton,
  /** The draft's slot code (`draft.slots`). #1726 — the Builder stores slots
   *  on the draft, not in `spec.slots`; without them every required slot is
   *  "missing" and codegen throws, so the preview passes them like the
   *  build does. */
  slots: Readonly<Record<string, string>> = {},
): Promise<string> {
  let parsed;
  try {
    parsed = parseAgentSpec(skeleton);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      '# manifest.yaml — preview unavailable',
      '#',
      '# spec.yaml ist noch nicht vollständig — der Codegen würde',
      '# folgenden Fehler werfen:',
      ...msg.split('\n').map((line) => `#   ${line}`),
    ].join('\n');
  }
  const out = await generate({ spec: parsed, slots: { ...slots } });
  const manifestBuf = out.get('manifest.yaml');
  if (!manifestBuf) {
    return '# manifest.yaml not produced by template';
  }
  return manifestBuf.toString('utf8');
}
