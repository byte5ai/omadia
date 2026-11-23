import {
  UNRESTRICTED_TOOL_CAPABILITY,
  type Capability,
  type GrantStore,
  type Principal,
} from '@omadia/channel-sdk';

import {
  ATTACHMENT_READ_CAPABILITY,
  CROSS_SCOPE_RECALL_CAPABILITY,
  MEMORY_RECALL_CAPABILITY,
} from './audienceFloorGuard.js';
import { fieldCapability, PERSONAL_FIELD_CLASS } from './discretion/fieldRights.js';

/**
 * #2048 (spec 2042 G15, §5.4 step 5) — the audience floor is on by default, so
 * it needs a default answer to "what may a person in this room do?".
 *
 * Before this, the floor only ran when an operator had seeded a grant table,
 * and an empty table meant "nobody may do anything" — which is why it shipped
 * off. Default-on therefore needs a baseline that keeps an ordinary room
 * working while still bounding it:
 *
 *  - every **resolved** person (a `user:` principal in omadia's id space) holds
 *    the member baseline below — any tool the agent itself was granted, recall,
 *    attachment reads and the right to see personal fields the privacy shield
 *    masked (`privacy:field:personal`, spec 2042 criteria 3c / 18);
 *  - explicit prohibitions (`/api/v1/admin/audience-grants/.../deny`) still
 *    bind the whole room, and a prohibition beats the baseline;
 *  - a participant nobody can resolve still closes the floor: the baseline is
 *    granted to principals, and an unresolved member has none. That is the
 *    fail-closed "least-privileged audience" the issue asks for.
 *
 * What a person may make the agent do never exceeds what the agent may do
 * (INV-8): the baseline's `tool:*` is intersected with the agent's own tool set
 * by construction, because the floor is only consulted for tools the agent
 * already holds.
 *
 * Operators who want the strict #575 reading (only explicit grants count) set
 * `AUDIENCE_BASELINE_GRANTS=none`.
 */
export const MEMBER_BASELINE_CAPABILITIES: readonly Capability[] = Object.freeze([
  UNRESTRICTED_TOOL_CAPABILITY,
  MEMORY_RECALL_CAPABILITY,
  CROSS_SCOPE_RECALL_CAPABILITY,
  ATTACHMENT_READ_CAPABILITY,
  fieldCapability(PERSONAL_FIELD_CLASS),
]);

/**
 * A {@link GrantStore} that adds {@link MEMBER_BASELINE_CAPABILITIES} to every
 * `user:` principal's direct grants, on top of whatever `inner` stores.
 *
 * Denials are passed through untouched, and an `inner` store that throws still
 * throws: an unreadable grant table must close the floor with a reason, never
 * degrade to "the baseline only" (see `postgresGrantStore.ts`).
 */
export class MemberBaselineGrantStore implements GrantStore {
  constructor(private readonly inner?: GrantStore) {}

  async directGrants(principal: Principal): Promise<readonly Capability[]> {
    const stored = this.inner ? await this.inner.directGrants(principal) : [];
    if (principal.kind !== 'user') return stored;
    return [...new Set([...stored, ...MEMBER_BASELINE_CAPABILITIES])];
  }

  async roleGrants(roleKey: string): Promise<readonly Capability[]> {
    return this.inner ? this.inner.roleGrants(roleKey) : [];
  }

  async directDenials(principal: Principal): Promise<readonly Capability[]> {
    return (await this.inner?.directDenials?.(principal)) ?? [];
  }

  async roleDenials(roleKey: string): Promise<readonly Capability[]> {
    return (await this.inner?.roleDenials?.(roleKey)) ?? [];
  }
}
