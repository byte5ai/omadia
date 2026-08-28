/**
 * Teams app-package asset loader (epic byte5ai/omadia#860, wave W1a wiring).
 *
 * The provisioning job runner's `loadPackageAssets` seam: gathers the three
 * inputs the connector's PURE `buildAppPackage` needs to render one Teams
 * app package per agent identity —
 *
 *   1. the manifest TEMPLATE + icon PNGs, read from the installed
 *      `@omadia/channel-teams` package (`appPackage/manifest.json.template`,
 *      `color.png`, `outline.png` — the canonical, versioned template of
 *      wave W0a; deliberately NOT vendored into the middleware),
 *   2. one param per `{{PLACEHOLDER}}` occurring in that template (the
 *      connector refuses a render with missing or unused placeholders, so
 *      the fill is driven by scanning the template, not by a fixed list),
 *   3. the stable `externalId` (the Teams app id / catalog idempotency key):
 *      a deterministic name-based UUID derived from the agent id, so every
 *      re-run of the chain targets the same catalog entry.
 *
 * NO network, NO Graph/ARM — pure filesystem reads; rendering and uploading
 * happen behind the `teamsProvisioner@1` accessor.
 *
 * Fails LOUDLY with actionable messages: a missing channel-teams package or
 * an unknown placeholder surfaces in the identity row's `last_error` via the
 * runner instead of producing a package Teams would reject.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type {
  TeamsAppPackageAssetLoader,
  TeamsAppPackageParams,
  TeamsIdentityJobRecord,
} from './teamsProvisioningJob.js';

/** The plugin whose package ships the canonical app-package template. */
export const CHANNEL_TEAMS_PLUGIN_ID = '@omadia/channel-teams';

/** Placeholder syntax of the channel-teams template (`{{UPPER_SNAKE}}`). */
const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export class TeamsAppPackageAssetsError extends Error {
  public readonly code = 'teams_app_package_assets_unavailable';

  constructor(problem: string) {
    super(`teams_app_package_assets_unavailable: ${problem}`);
    this.name = 'TeamsAppPackageAssetsError';
  }
}

/**
 * Deterministic Teams app id (`externalId`, manifest `id`) for one agent:
 * RFC-4122 name-based (v5-style, SHA-1) UUID in a fixed W1a namespace. Same
 * agent → same GUID on every run, which is exactly what makes the catalog
 * upload idempotent; distinct from the bot's Entra `appId` by construction
 * (the manifest's `id` and `bots[0].botId` are different GUIDs).
 */
export function stableTeamsAppExternalId(agentId: string): string {
  // Fixed namespace for omadia agent-factory Teams app ids (random constant,
  // never reused elsewhere).
  const namespace = 'de3c2a76-6f1b-4b6a-9d3e-860a1a7c5b21';
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(ns)
    .update(Buffer.from(`omadia-teams-app:${agentId}`, 'utf8'))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC-4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The agent's authored identity as this module needs it (#914) — a PORT, not
 * the store type: this module must not learn about `pg`, and the store must
 * not learn about Teams manifests. `platform/agentIdentityStore.ts` fills it.
 *
 * `displayName` is the AUTHORED name or `null`. Null falls back to the
 * provisioning row's `display_name`, which is where the agent's registry name
 * already landed when the identity was created — so the fallback chain lives
 * in one place instead of being resolved again by every caller.
 */
export interface TeamsAppPackageIdentity {
  readonly displayName: string | null;
  readonly shortDescription: string | null;
  readonly longDescription: string | null;
  /** `#RRGGBB` or null to keep the product default. */
  readonly accentColor: string | null;
  /** Monotonic; rendered as the manifest version `1.0.<revision>`. */
  readonly revision: number;
  /** Uploaded icons. `null` = no avatar; `outline: null` = colour icon only. */
  readonly icons: {
    readonly color: Uint8Array;
    readonly outline: Uint8Array | null;
  } | null;
}

export type TeamsAppPackageIdentityLoader = (
  agentId: string,
) => Promise<TeamsAppPackageIdentity | undefined>;

export interface TeamsAppPackageAssetOptions {
  /** Package root of the installed channel-teams plugin (the directory
   *  holding `manifest.yaml` and `appPackage/`), or undefined while the
   *  plugin is not installed. Resolved per call — an install after boot is
   *  picked up without a restart. */
  readonly getChannelTeamsPackageRoot: () => string | undefined;
  /** The deployment's public base URL (TEAMS_PUBLIC_BASE_URL ??
   *  PUBLIC_BASE_URL) — host for validDomains / webApplicationInfo and base
   *  of the plugin's tab pages. */
  readonly getPublicBaseUrl: () => string | undefined;
  /** Manifest `version` (per-package semver). Default `1.0.0`. Used only for
   *  agents without an authored identity — an identity supplies its own
   *  version through its revision, which is what makes a re-publish
   *  acceptable to Teams. */
  readonly version?: string;
  /**
   * #914 — the agent's authored identity. Optional and allowed to answer
   * `undefined`: an agent that was never given an identity renders exactly
   * the package it rendered before this option existed.
   */
  readonly loadIdentity?: TeamsAppPackageIdentityLoader;
  /** Overrides for developer-facing manifest fields. */
  readonly developer?: {
    readonly name?: string;
    readonly websiteUrl?: string;
    readonly privacyUrl?: string;
    readonly termsUrl?: string;
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Build the param map for exactly the placeholders the template uses. */
function paramsForTemplate(
  template: string,
  identity: TeamsIdentityJobRecord,
  authored: TeamsAppPackageIdentity | undefined,
  externalId: string,
  baseUrl: URL,
  opts: TeamsAppPackageAssetOptions,
): TeamsAppPackageParams {
  // #914 — the authored identity names the app; `identity.displayName` (the
  // provisioning row) names the AZURE BOT RESOURCE and stays where it is.
  // They start out identical; when they diverge, the manifest is the surface
  // a human reads and the bot resource is an ARM handle nobody sees.
  const displayName = authored?.displayName ?? identity.displayName;
  const origin = baseUrl.origin;
  const known: Record<string, string | readonly string[]> = {
    // A published package can only be REPLACED by a higher version, so an
    // identity's revision is the version: edit → bump → re-publish accepted.
    VERSION:
      authored !== undefined
        ? `1.0.${authored.revision}`
        : (opts.version ?? '1.0.0'),
    // Teams app id (manifest `id`) — NOT the bot's Entra app id.
    APP_ID: externalId,
    BOT_ID: identity.appId ?? '',
    NAME_SHORT: truncate(displayName, 30),
    NAME_FULL: truncate(displayName, 100),
    DESCRIPTION: truncate(
      authored?.shortDescription ??
        `${displayName} — Omadia agent for Microsoft Teams`,
      80,
    ),
    DESCRIPTION_FULL: truncate(
      authored?.longDescription ??
        authored?.shortDescription ??
        `${displayName} is an Omadia agent provisioned for this tenant. It answers in team channels, group chats and personal scope through the Omadia middleware.`,
      4000,
    ),
    ACCENT_COLOR: authored?.accentColor ?? '#714B67',
    DEVELOPER_NAME: opts.developer?.name ?? 'byte5',
    DEVELOPER_WEBSITE_URL: opts.developer?.websiteUrl ?? 'https://omadia.ai',
    DEVELOPER_PRIVACY_URL: opts.developer?.privacyUrl ?? 'https://omadia.ai/privacy',
    DEVELOPER_TERMS_URL: opts.developer?.termsUrl ?? 'https://omadia.ai/terms',
    // Raw-JSON slots (serialized arrays, per the template README).
    COMMAND_LISTS: [] as readonly string[],
    VALID_DOMAINS: [baseUrl.host] as readonly string[],
    MIDDLEWARE_HOST: baseUrl.host,
    // The channel-teams web-ui surfaces (uiRouter) under the deployment
    // origin — README's documented deployment default.
    TAB_BASE_URL: `${origin}/p/channel-teams`,
  };
  const params: Record<string, string | readonly string[]> = {};
  const unknown: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1] as string;
    if (name in known) {
      params[name] = known[name] as string | readonly string[];
    } else if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }
  if (unknown.length > 0) {
    throw new TeamsAppPackageAssetsError(
      `the channel-teams app-package template uses placeholder(s) [${unknown.join(', ')}] this middleware does not know how to fill — update teamsAppPackageAssets.ts alongside the template`,
    );
  }
  return params;
}

/**
 * The `loadPackageAssets` implementation the boot wiring hands the job
 * runner. Reads template + icons fresh on every call (provisioning is rare;
 * a template shipped by a plugin update is picked up immediately).
 */
export function createTeamsAppPackageAssetLoader(
  opts: TeamsAppPackageAssetOptions,
): TeamsAppPackageAssetLoader {
  return async (identity: TeamsIdentityJobRecord) => {
    const root = opts.getChannelTeamsPackageRoot();
    if (!root) {
      throw new TeamsAppPackageAssetsError(
        `the ${CHANNEL_TEAMS_PLUGIN_ID} plugin (>= 0.20.0, with appPackage/ template) is not installed — its app-package template is required to build the agent's Teams app`,
      );
    }
    const rawBase = opts.getPublicBaseUrl();
    if (!rawBase) {
      throw new TeamsAppPackageAssetsError(
        'no public base URL configured — set TEAMS_PUBLIC_BASE_URL or PUBLIC_BASE_URL so validDomains/webApplicationInfo can name the middleware host',
      );
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(rawBase);
    } catch {
      throw new TeamsAppPackageAssetsError(
        `public base URL ${JSON.stringify(rawBase)} is not a valid URL`,
      );
    }
    if (!identity.appId) {
      throw new TeamsAppPackageAssetsError(
        `agent '${identity.agentId}' has no Entra appId yet — the app registration step must complete before the package is built`,
      );
    }
    const dir = path.join(root, 'appPackage');
    let manifestTemplate: string;
    let color: Uint8Array;
    let outline: Uint8Array;
    try {
      [manifestTemplate, color, outline] = await Promise.all([
        readFile(path.join(dir, 'manifest.json.template'), 'utf8'),
        readFile(path.join(dir, 'color.png')),
        readFile(path.join(dir, 'outline.png')),
      ]);
    } catch (err) {
      throw new TeamsAppPackageAssetsError(
        `cannot read app-package assets from ${dir} — the installed ${CHANNEL_TEAMS_PLUGIN_ID} package must ship appPackage/{manifest.json.template,color.png,outline.png} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    // #914 — the authored identity, if this deployment has one for the agent.
    // A failure here is NOT swallowed: rendering the fallback package after a
    // failed read would ship the wrong name and icon under a version number
    // that claims to be the edited one.
    const authored = opts.loadIdentity
      ? await opts.loadIdentity(identity.agentId)
      : undefined;

    const externalId = stableTeamsAppExternalId(identity.agentId);
    return {
      manifestTemplate,
      params: paramsForTemplate(
        manifestTemplate,
        identity,
        authored,
        externalId,
        baseUrl,
        opts,
      ),
      icons: {
        color: authored?.icons?.color ?? color,
        // The packaged outline stays the fallback: an opaque avatar cannot
        // produce a silhouette, and a white square in the app bar is worse
        // than the product default.
        outline: authored?.icons?.outline ?? outline,
      },
      externalId,
    };
  };
}
