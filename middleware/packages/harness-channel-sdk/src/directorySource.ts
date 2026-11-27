/**
 * ADR-0300 — a tenant's directory of people, contributed by a channel plugin.
 *
 * The kernel keeps a directory of the people of an Entra tenant (not
 * accounts: they have no login and no role). It holds no Microsoft Graph
 * credentials; the Teams plugin, which already owns the app registration and
 * its `User.Read.All` grant, reads the directory for it. The kernel stores
 * the people, runs the sync, and deprovisions leavers.
 *
 * A plugin registers one source per tenant with
 * `core.registerDirectorySource?(channelId, source)` (feature-detect; older
 * kernels lack the method). The first plugin to register a tenant owns it.
 */

/** Directory kinds the kernel knows. */
export type DirectorySourceKind = 'entra';

/** One change the source reports for a person. */
export interface DirectoryPersonChange {
  /** Stable id at the source. Entra: the AAD object id. */
  readonly externalId: string;
  /** The person left the directory (Graph delta `@removed`). Other fields may be absent. */
  readonly removed?: boolean;
  readonly displayName?: string;
  readonly upn?: string;
  readonly mail?: string;
  /** `false` deprovisions the person; absent keeps the stored value. */
  readonly accountEnabled?: boolean;
}

/** One page of a directory read. */
export interface DirectoryDeltaPage {
  readonly changes: readonly DirectoryPersonChange[];
  /** More pages follow; pass this back as `cursor`. */
  readonly nextCursor?: string;
  /**
   * Last page: the cursor for the next incremental read (Graph `@odata.deltaLink`).
   * Exactly one of `nextCursor` / `deltaCursor` is set on a well-formed page.
   */
  readonly deltaCursor?: string;
}

/**
 * The answer to one `delta` call. `resync` means the stored cursor is no
 * longer valid (Graph 410 / `syncStateNotFound`): the kernel starts a full read.
 */
export type DirectoryDeltaResult =
  | { readonly outcome: 'page'; readonly page: DirectoryDeltaPage }
  | { readonly outcome: 'resync' }
  | {
      readonly outcome: 'unavailable';
      /** Operator-readable; goes to the sync state and logs, never an HTTP body to a non-operator. */
      readonly message: string;
    };

export interface DirectorySource {
  readonly source: DirectorySourceKind;
  /** The tenant this source reads (Entra tenant id, a GUID). */
  readonly tenantId: string;
  /**
   * Read one page. `cursor` absent = start a full read; otherwise a
   * `nextCursor` or `deltaCursor` this source handed out. Should resolve
   * `unavailable` rather than throw; the kernel defends against throwing.
   */
  delta(cursor?: string): Promise<DirectoryDeltaResult>;
}
