/**
 * #1814 — where the store sends an operator whose install is blocked because
 * the capability is already provided.
 *
 * The blocked-install box used to link every capability to `/admin/providers`,
 * which lists LLM providers (#671 added it for those). For an embedding or a
 * transcription provider that page cannot help; each has its own admin page
 * that names the active provider and the steps to change it.
 */
export interface ProviderAdminLink {
  readonly href: string;
  /** Message key in the `store.detail` namespace. */
  readonly ctaKey:
    | 'alreadyProvidedCta'
    | 'alreadyProvidedCtaEmbedding'
    | 'alreadyProvidedCtaTranscription';
}

/** `embeddingClient@1` → `embeddingClient`; a bare name passes through. */
function capabilityName(capability: string): string {
  const at = capability.indexOf('@');
  return at === -1 ? capability : capability.slice(0, at);
}

export function providerAdminLink(capability: string): ProviderAdminLink {
  switch (capabilityName(capability)) {
    case 'embeddingClient':
      return { href: '/admin/embedding-provider', ctaKey: 'alreadyProvidedCtaEmbedding' };
    case 'transcription':
      return {
        href: '/admin/transcription-provider',
        ctaKey: 'alreadyProvidedCtaTranscription',
      };
    default:
      return { href: '/admin/providers', ctaKey: 'alreadyProvidedCta' };
  }
}
