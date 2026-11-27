import { describe, expect, it } from 'vitest';

import { providerAdminLink } from '../providerAdminLink';

/** #1814 — the blocked-install box links to the page of THIS capability. */
describe('providerAdminLink', () => {
  it('sends an embedding collision to the embedding provider page', () => {
    expect(providerAdminLink('embeddingClient@1')).toEqual({
      href: '/admin/embedding-provider',
      ctaKey: 'alreadyProvidedCtaEmbedding',
    });
  });

  it('sends a transcription collision to the transcription provider page', () => {
    expect(providerAdminLink('transcription@1').href).toBe('/admin/transcription-provider');
  });

  it('keeps the LLM providers page for every other capability', () => {
    expect(providerAdminLink('llmProvider@1')).toEqual({
      href: '/admin/providers',
      ctaKey: 'alreadyProvidedCta',
    });
  });
});
