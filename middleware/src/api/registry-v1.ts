// ===========================================================================
// Registry API v1 — the `index.json` contract shared between omadia Core and
// a remote plugin registry (hub.omadia.ai and any private/customer hub).
// ---------------------------------------------------------------------------
// The registry is intentionally DUMB (npm-style): it serves a machine-readable
// catalog + ZIP artifacts. The smart client is omadia Core (`RegistryClient`),
// which fetches this index, verifies sha256 on download, and feeds the ZIP
// into the EXISTING `PackageUploadService.ingest` pipeline.
//
// Trust model (MVP): sha256 pinned here + HTTPS/TLS. No per-artifact signing
// yet — `Plugin.signed` stays false for registry-sourced entries.
//
// SOURCE OF TRUTH for this shape: keep in sync with the hub's
// `GET /registry/index.json` implementation.
// ===========================================================================

import type { ISO8601, LocalizedMarkdown, PluginKind } from './admin-v1.js';

/** A single installable version of a plugin, as advertised by a registry. */
export interface RegistryVersionEntry {
  version: string;
  /** Harness-core semver constraint from the manifest's `compat.core`. */
  compat_core: string;
  /** Lowercase hex SHA-256 of the ZIP artifact. Verified post-download. */
  sha256: string;
  size_bytes: number;
  /** Absolute URL to the ZIP. Same-origin with the registry url by convention,
   *  but may point at a CDN/Blob host — only the host allowlist is enforced. */
  download_url: string;
  published_at: ISO8601;
  /** Enough manifest detail for the store UI to render an install preview
   *  WITHOUT downloading the ZIP. Heavy validation still happens at Core
   *  install-time inside `PackageUploadService.ingest`. */
  manifest_summary: RegistryManifestSummary;
}

/** Lightweight manifest projection surfaced in the index. All fields optional
 *  so the contract tolerates older/sparser registries. */
export interface RegistryManifestSummary {
  provides?: string[];
  requires?: string[];
  depends_on?: string[];
  /** Setup fields the operator must fill at install-time. Mirrors
   *  `PluginSetupField` but kept loose here to avoid a hard schema coupling. */
  setup_fields?: Array<Record<string, unknown>>;
  /** Localized markdown installation guide for the plugin's third-party system
   *  (e.g. "how to create a Discord bot", "how to get Microsoft 365
   *  credentials"). A `{ <locale>: markdown }` map from the manifest's
   *  `setup.guide`. Display-only — rendered on the hub detail page and the
   *  Omadia store; never parsed for behaviour. */
  setup_guide?: LocalizedMarkdown;
  permissions?: Record<string, unknown>;
}

/** One plugin (all of its published versions) in a registry index. */
export interface RegistryPluginEntry {
  id: string;
  name: string;
  kind: PluginKind;
  domain: string;
  description: string;
  categories: string[];
  authors: Array<{ name: string; email?: string; url?: string }>;
  license: string;
  icon_url: string | null;
  latest_version: string;
  /** Newest-first by convention; the client does not rely on ordering. */
  versions: RegistryVersionEntry[];
}

/** Top-level shape of `GET /registry/index.json`. */
export interface RegistryIndexV1 {
  schema_version: '1';
  registry: { name: string; url: string };
  generated_at: ISO8601;
  plugins: RegistryPluginEntry[];
}

/**
 * One configured upstream registry. Multi-registry from day one: Core holds a
 * list of these. `token`, when present, is sent as `Authorization: Bearer` on
 * both index and artifact fetches — this is how a private byte5/customer hub
 * is consumed.
 */
export interface RegistryConfigEntry {
  /** Base URL, e.g. `https://hub.omadia.ai`. Doubles as the host allowlist. */
  url: string;
  /** Stable short name used to namespace entries + label the source. */
  name: string;
  /** Optional bearer token for private registries. */
  token?: string;
}

/**
 * Discriminator attached to a `Plugin` whose artifact lives on a remote
 * registry (not yet downloaded/uploaded locally). Its presence is what tells
 * the install flow to fetch-then-ingest rather than activate directly.
 */
export interface RegistrySource {
  /** `name` of the originating `RegistryConfigEntry`. */
  registry: string;
  download_url: string;
  sha256: string;
}
