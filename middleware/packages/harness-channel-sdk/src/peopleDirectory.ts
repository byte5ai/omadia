/**
 * People-directory contract — opt-in per channel-kind plugin.
 *
 * Conductor human steps address a person by `principal.ref`. Operators know
 * people by name ("Eskalation an Teresita Biel"), the platform knows them by
 * routing key (Teams: email/UPN, Slack: member id, Discord: user id). The
 * channel plugin is the only party that can translate one into the other —
 * it owns the identity provider, the permissions and the canonical key — so
 * it contributes a searchable directory and the kernel aggregates them, in
 * the mould of `conversationRoster.ts` / `channelKeyDirectory.ts`.
 *
 * **No platform-level discovery via Graph / external APIs.** Same rule as the
 * channel-key directory: a Teams plugin MAY call Graph `/users`; the kernel
 * never does. Hosts without any registered provider behave correctly: the
 * search answers `people: []`, `partial: false` — a real "nobody known".
 */

/** One person a channel can route to. */
export interface PeopleDirectoryEntry {
  /**
   * The principal id Conductor writes into `human.principal.ref` for
   * `kind: 'user'`. It MUST equal the channel's binding key for that person
   * (the `principalRef` the channel hands the kernel on inbound turns, falling
   * back to the channel-native userId — see the kernel's `bindingKeyForTurn`),
   * and it must be canonicalizable via `canonicalizePrincipalRef('user', …)`
   * (trim + lowercase), otherwise reminders and await matching miss the
   * person. Teams: the user's email/UPN. Never a display name.
   */
  readonly principalRef: string;
  /** Human-readable name for the picker. */
  readonly displayName: string;
  /** Email, when the channel knows it and it differs from `principalRef`. */
  readonly email?: string;
  /** Channel-native stable id (e.g. the AAD object id), when it differs. */
  readonly channelUserId?: string;
  /** Free-form disambiguation shown beside the name (department, site). */
  readonly hint?: string;
}

/** Why a provider could not answer. Never means "no such person". */
export type PeopleDirectoryUnavailableCode =
  /** The backing directory/API failed, timed out or refused the read. */
  | 'source_error'
  /** Registered but missing config/permissions (e.g. no `User.Read.All`). */
  | 'not_configured'
  /** The channel has no searchable directory at all. */
  | 'not_supported';

/**
 * A provider's answer to one search. `resolved` with `people: []` is a real
 * answer (nobody matches); `partial: true` means the provider could only read
 * part of its directory (page cap, throttling) so an absence proves nothing.
 * Same "absence is a type" discipline as `roleHolderSource.ts`.
 */
export type PeopleDirectoryLookup =
  | { readonly outcome: 'resolved'; readonly people: readonly PeopleDirectoryEntry[]; readonly partial: boolean }
  | {
      readonly outcome: 'unavailable';
      readonly code: PeopleDirectoryUnavailableCode;
      /** Operator-readable. Belongs in logs, never in an HTTP body. */
      readonly message: string;
    };

/**
 * Optional per-channel people-directory capability. A channel plugin registers
 * one via `core.registerPeopleDirectoryProvider?.(channelId, provider)`
 * (feature-detect — older kernels do not define the method).
 *
 * `search` matches `query` case-insensitively against display name and
 * email/UPN (substring or prefix — the provider's choice; Graph `$search`
 * semantics are fine) and returns at most `limit` entries. Implementations
 * should RETURN `unavailable` rather than throw; the kernel registry defends
 * against throwing anyway.
 */
export interface PeopleDirectoryProvider {
  /** The `channel_bindings.channel_type` this provider serves (e.g. 'teams'). */
  readonly channelType: string;
  search(query: string, opts: { readonly limit: number }): Promise<PeopleDirectoryLookup>;
}
