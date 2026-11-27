import type { AgentSpec } from './agentSpec.js';
import { lookupServiceType } from './serviceTypeRegistry.js';

/**
 * #1779 — the `requires:` entries a generated manifest needs for its
 * `external_reads`.
 *
 * The generated toolkit calls `ctx.services.get('<service>')` for every
 * service in `spec.external_reads`. An installed plugin only gets a service
 * its manifest declares (ADR-0053, `pluginServiceGrants.ts`), and the preview
 * applies the same gate to the draft's manifest (ADR-0059,
 * `previewServices.ts`). So codegen declares each such service as
 * `<service>@^<major>`, with the major the provider declares under `provides:`.
 *
 * A service whose provider declares no major cannot be declared: the install
 * would fail to resolve it either way, so codegen says so instead of writing a
 * manifest that only works in a preview.
 */
export interface ServiceRequiresResult {
  requires: string[];
  /** One message per external_reads service that cannot be declared. */
  problems: string[];
}

export function deriveServiceRequires(spec: AgentSpec): ServiceRequiresResult {
  const requires: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  spec.external_reads.forEach((er, i) => {
    if (seen.has(er.service)) return;
    seen.add(er.service);
    const reg = lookupServiceType(er.service);
    // Unknown services are reported by buildExternalReadsArtifacts.
    if (!reg) return;
    if (reg.major === undefined) {
      problems.push(
        `external_reads[${String(i)}].service '${er.service}': the provider ` +
          `'${reg.providedBy}' declares no '${er.service}@<major>' under provides:, ` +
          "so the generated manifest cannot declare it in requires: and the " +
          'installed plugin could not resolve it. Update the provider plugin.',
      );
      return;
    }
    requires.push(`${er.service}@^${String(reg.major)}`);
  });
  return { requires: requires.sort(), problems };
}
