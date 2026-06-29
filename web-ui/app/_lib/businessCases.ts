/**
 * Business-case onboarding presets. Each case maps to a curated set of Hub
 * plugins, grouped into four operator-facing categories. Names/descriptions are
 * NOT here — they live in i18n (`dashboard.onboarding.cases.*`) so the config
 * stays pure data and translatable.
 *
 * Plugin ids use the canonical reverse-DNS form the catalog + bootstrap
 * profiles use (`middleware/profiles/*.yaml`). At render time the dashboard
 * resolves each id against the live catalog (`listStorePlugins`): present +
 * installed, present + installable, or missing → route to Builder / request.
 * Most byte5 business connectors live in a private repo today, so the
 * missing→Builder/request path is the common case until a registry advertises
 * them, at which point the same ids resolve to "available" with no code change.
 */

export type PluginCategory = 'channels' | 'erp' | 'knowledge' | 'devtools';

export const PLUGIN_CATEGORIES: readonly PluginCategory[] = [
  'channels',
  'erp',
  'knowledge',
  'devtools',
] as const;

export interface RecommendedPlugin {
  readonly id: string;
  readonly category: PluginCategory;
}

export interface BusinessCase {
  readonly id: string;
  readonly plugins: readonly RecommendedPlugin[];
}

export const BUSINESS_CASES: readonly BusinessCase[] = [
  {
    id: 'sales',
    plugins: [
      { id: '@omadia/channel-teams', category: 'channels' },
      { id: '@omadia/channel-telegram', category: 'channels' },
      { id: '@omadia/integration-odoo', category: 'erp' },
      { id: '@omadia/integration-microsoft365', category: 'knowledge' },
      { id: '@omadia/integration-confluence', category: 'knowledge' },
    ],
  },
  {
    id: 'hr',
    plugins: [
      { id: '@omadia/channel-teams', category: 'channels' },
      { id: '@omadia/agent-odoo-hr', category: 'erp' },
      { id: '@omadia/integration-odoo', category: 'erp' },
      { id: '@omadia/integration-confluence', category: 'knowledge' },
      { id: '@omadia/integration-microsoft365', category: 'knowledge' },
    ],
  },
  {
    id: 'finance',
    plugins: [
      { id: '@omadia/channel-teams', category: 'channels' },
      { id: '@omadia/agent-odoo-accounting', category: 'erp' },
      { id: '@omadia/integration-odoo', category: 'erp' },
      { id: '@omadia/integration-microsoft365', category: 'knowledge' },
    ],
  },
  {
    id: 'devteam',
    plugins: [
      { id: '@omadia/channel-teams', category: 'channels' },
      { id: '@omadia/channel-telegram', category: 'channels' },
      { id: '@omadia/integration-confluence', category: 'knowledge' },
      { id: '@omadia/integration-github', category: 'devtools' },
      { id: '@omadia/agent-github', category: 'devtools' },
    ],
  },
] as const;

/**
 * Human labels for recommended plugin ids. Used as the display name + the
 * GitHub-request title when a plugin is NOT in the live catalog (so we have no
 * catalog `name` to show). When the plugin IS in the catalog, the catalog name
 * wins. Falls back to the raw id for anything unmapped.
 */
export const PLUGIN_LABELS: Readonly<Record<string, string>> = {
  '@omadia/channel-teams': 'Microsoft Teams',
  '@omadia/channel-telegram': 'Telegram',
  '@omadia/integration-odoo': 'Odoo',
  '@omadia/agent-odoo-hr': 'Odoo HR',
  '@omadia/agent-odoo-accounting': 'Odoo Accounting',
  '@omadia/integration-microsoft365': 'Microsoft 365',
  '@omadia/integration-confluence': 'Confluence',
  '@omadia/integration-github': 'GitHub',
  '@omadia/agent-github': 'GitHub Agent',
};

export function pluginLabel(id: string): string {
  return PLUGIN_LABELS[id] ?? id;
}

/**
 * Normalize a plugin id for catalog matching. The catalog/hub publishes
 * npm-style ids (`@omadia/channel-teams`); some sources use the canonical
 * reverse-DNS form (`de.byte5.channel.teams`). Both reduce to the same key
 * (`channel-teams`) so a recommendation resolves regardless of which form the
 * catalog returns.
 */
export function normalizePluginId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^@omadia\//, '')
    .replace(/^de\.byte5\./, '')
    .replace(/\./g, '-');
}
