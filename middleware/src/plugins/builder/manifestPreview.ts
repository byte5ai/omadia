import type { AgentSpecSkeleton } from './types.js';
import { parseAgentSpec, type AgentSpec } from './agentSpec.js';
import { generate } from './codegen.js';

/** Generate the reviewed manifest without a sandbox build. */
export async function renderManifestPreview(
  skeleton: AgentSpecSkeleton,
  slots?: Record<string, string>,
): Promise<string> {
  const manifest = await generateManifestPreview(parseAgentSpec(skeleton), slots);
  if (manifest === undefined) throw new Error('Template generated no manifest');
  return manifest;
}

export async function generateManifestPreview(spec: AgentSpec, slots?: Record<string, string>): Promise<string | undefined> {
  const files = await generate({ spec, ...(slots ? { slots } : {}) });
  return files.get('manifest.yaml')?.toString('utf8');
}
