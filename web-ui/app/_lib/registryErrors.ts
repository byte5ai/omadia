/**
 * #1482 — a registry fetch failure as a localized reason.
 *
 * The middleware's `error.message` is English by construction (it has no
 * request locale) and may name internal hosts, so the UI leads with a catalog
 * line chosen by the stable `error.code` and shows the message only as the
 * technical detail behind it (web-ui/CLAUDE.md, checklist item 3).
 */
export type RegistryErrorKey =
  | 'timeout'
  | 'network'
  | 'http'
  | 'badIndex'
  | 'tooLarge'
  | 'unknown';

const BY_CODE: Readonly<Record<string, RegistryErrorKey>> = {
  'registry.timeout': 'timeout',
  'registry.network': 'network',
  'registry.index_http': 'http',
  'registry.index_parse': 'badIndex',
  'registry.index_shape': 'badIndex',
  'registry.index_version': 'badIndex',
  'registry.too_large': 'tooLarge',
};

/** Leaf under `registryStatus.errors` for a `registry.*` code. */
export function registryErrorKey(code: string | undefined): RegistryErrorKey {
  return (code && BY_CODE[code]) || 'unknown';
}
