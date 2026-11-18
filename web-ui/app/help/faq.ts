/** FAQ entries. `href` points at the page that actually resolves the state. */
export const FAQ = [
  { key: 'invalidKey', href: '/admin/providers' },
  { key: 'pluginNeedsConfig', href: '/store' },
  // The answer points at the Subscriptions tab, so open it directly (#1395).
  { key: 'cliNotInstalled', href: '/admin/providers?tab=subscriptions' },
  { key: 'noModels', href: '/admin/providers' },
] as const;
