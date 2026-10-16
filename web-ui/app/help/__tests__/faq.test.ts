import { describe, expect, it } from 'vitest';

import de from '../../../messages/de.json';
import en from '../../../messages/en.json';
import { FAQ } from '../faq';

describe('help FAQ (#1395)', () => {
  it('opens the Subscriptions tab for the subscription-CLI answer', () => {
    const entry = FAQ.find((f) => f.key === 'cliNotInstalled');
    expect(entry?.href).toBe('/admin/providers?tab=subscriptions');
  });

  it('calls the plugin catalogue by its nav name, "Hub", in both locales', () => {
    for (const messages of [en, de]) {
      const { faq } = messages.help;
      const texts = [
        faq.pluginNeedsConfig.answer,
        faq.pluginNeedsConfig.action,
        faq.noModels.answer,
      ];
      for (const text of texts) {
        expect(text).toContain(messages.nav.store);
        expect(text).not.toMatch(/\bstore\b/i);
      }
    }
  });

  it('labels the first docs link differently from the section heading', () => {
    for (const messages of [en, de]) {
      expect(messages.help.docs.documentation).not.toBe(messages.help.docs.heading);
    }
  });
});
