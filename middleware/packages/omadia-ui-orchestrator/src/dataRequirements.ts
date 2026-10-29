import { type DataRequirement } from './composition.js';

/** Scalar/KPI value leaves carry id `${containerId}.${fieldKey}` (the
 *  fields-publish convention). Collect the single-segment fieldKeys of the
 *  scalar leaves (text/heading/status) under `container`. */
function collectFieldLeafKeys(container: Record<string, unknown>, containerId: string): string[] {
  const prefix = `${containerId}.`;
  const keys = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n !== 'object' || n === null) return;
    const node = n as Record<string, unknown>;
    const nid = typeof node['id'] === 'string' ? node['id'] : undefined;
    const type = node['type'];
    if (
      nid &&
      nid.startsWith(prefix) &&
      (type === 'text' || type === 'heading' || type === 'status')
    ) {
      const seg = nid.slice(prefix.length);
      if (seg.length > 0 && !seg.includes('.')) keys.add(seg);
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) walk(value);
    }
  };
  for (const value of Object.values(container)) {
    if (typeof value === 'object' && value !== null) walk(value);
  }
  return [...keys];
}

/** Derive the refreshable data requirements from a canvas tree itself — the
 *  tables' own columns ARE the field contract the original skeleton promised
 *  (deterministic, no LLM; omadia-ui#5). `scope` narrows to one containerId. */
export function deriveDataRequirements(tree: unknown, scope?: string): DataRequirement[] {
  const out: DataRequirement[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (typeof n !== 'object' || n === null) return;
    const node = n as Record<string, unknown>;
    const id = typeof node['id'] === 'string' ? node['id'] : undefined;
    if (id && (!scope || id === scope)) {
      if (node['type'] === 'table' && Array.isArray(node['columns'])) {
        const fields = (node['columns'] as Array<Record<string, unknown>>)
          .filter((c) => typeof c?.['fieldKey'] === 'string')
          .map((c) => ({
            fieldKey: c['fieldKey'] as string,
            label: String(c['label'] ?? c['fieldKey']),
          }));
        if (fields.length > 0) {
          out.push({
            containerId: id,
            description: `refresh: ${String(node['title'] ?? id)}`,
            fields,
          });
        }
      } else if (node['type'] === 'chart') {
        out.push({
          containerId: id,
          description: `refresh chart: ${String(node['title'] ?? id)}`,
          fields: [
            { fieldKey: 'label', label: 'label' },
            { fieldKey: 'value', label: 'value' },
          ],
        });
      } else {
        // Scalar/KPI container: its value leaves carry id `${id}.${fieldKey}`
        // (the fields-publish convention). The leaf ids ARE the field contract.
        const fieldKeys = collectFieldLeafKeys(node, id);
        if (fieldKeys.length > 0) {
          out.push({
            containerId: id,
            description: `refresh fields: ${String(node['title'] ?? id)}`,
            fields: fieldKeys.map((k) => ({ fieldKey: k, label: k })),
          });
        }
      }
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) walk(value);
    }
  };
  walk(tree);
  return out;
}
