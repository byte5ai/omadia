import type { AgentRow, ConfigStore } from '@omadia/orchestrator';

/**
 * Spec 2042 §5.10 — a Plugin Builder preview is a turn of a DRAFT AGENT: an
 * `agents` row with status `draft` (migration 0085). The registry never
 * builds a draft and every channel treats anything but `enabled` as not
 * addressable, so the row is reachable only from the preview route behind
 * the admin session. It holds no grant row: its only capabilities are the
 * draft plugin's tools, which the preview runtime captured and which are
 * never installed (`previewChatService`).
 *
 * One draft agent per Plugin Builder draft, found by its slug. It is removed
 * when its preview closes for good (evicted, draft discarded, logged out,
 * shut down; a rebuild keeps it) and, for a process that ended without
 * closing (crash, kill), by the sweep: at boot, or on the first preview when
 * the agent store was not there at boot (key-less start).
 */

/** Slug prefix of preview draft agents; reserved for them on agent create. */
export const PREVIEW_DRAFT_AGENT_SLUG_PREFIX = 'builder-preview-';

const MAX_SLUG_LENGTH = 64;
const MAX_NAME_LENGTH = 120;
/** `deleted_by` of a removed preview draft agent: finds a tombstone whose
 *  purge failed, so the sweep can finish it. */
const PREVIEW_DELETED_BY = 'plugin-builder-preview';

export type PreviewDraftAgentStore = Pick<
  ConfigStore,
  'getAgentBySlug' | 'createAgent' | 'deleteAgent' | 'purgeAgent' | 'listAgents' | 'listTombstones'
>;

/** The draft agent could not be created; the preview turn does not run. */
export class PreviewDraftAgentUnavailableError extends Error {
  readonly code = 'builder.preview_draft_agent_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'PreviewDraftAgentUnavailableError';
  }
}

export function isPreviewDraftAgentSlug(slug: string): boolean {
  return slug.startsWith(PREVIEW_DRAFT_AGENT_SLUG_PREFIX);
}

/** The slug of the draft agent of one Plugin Builder draft. */
export function previewDraftAgentSlug(draftId: string): string {
  const tail = draftId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!tail) throw new PreviewDraftAgentUnavailableError(`draft id '${draftId}' yields no slug`);
  return `${PREVIEW_DRAFT_AGENT_SLUG_PREFIX}${tail}`.slice(0, MAX_SLUG_LENGTH);
}

export interface PreviewDraftAgentRef {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export class PreviewDraftAgents {
  private swept = false;

  constructor(
    private readonly getStore: () => PreviewDraftAgentStore | undefined,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /**
   * The draft agent of `draftId`, created on first use. Throws
   * {@link PreviewDraftAgentUnavailableError} when there is no agent store or
   * the slug is held by an agent that is not a draft: a preview never runs
   * as an addressable agent.
   */
  async ensure(draftId: string, pluginName: string): Promise<PreviewDraftAgentRef> {
    const store = this.requireStore();
    // The boot found no agent store: sweep once now, before this process
    // creates a draft agent of its own.
    if (!this.swept) await this.sweep();
    const slug = previewDraftAgentSlug(draftId);
    const existing = await store.getAgentBySlug(slug);
    if (existing) return asRef(existing);
    try {
      const created = await store.createAgent({
        slug,
        name: `Preview: ${pluginName}`.slice(0, MAX_NAME_LENGTH),
        description: 'Draft agent of a Plugin Builder preview. Not addressable; removed when the preview closes.',
        status: 'draft',
      });
      this.log(`[preview-draft-agent] created ${slug} (${created.id})`);
      return asRef(created);
    } catch (err) {
      // Two first turns of the same draft at once: the other one created it.
      const raced = await store.getAgentBySlug(slug);
      if (raced) return asRef(raced);
      throw err;
    }
  }

  /** Removes the draft agent of `draftId`, if there is one. */
  async remove(draftId: string): Promise<boolean> {
    const store = this.getStore();
    if (!store) return false;
    const existing = await store.getAgentBySlug(previewDraftAgentSlug(draftId));
    if (!existing) return false;
    return this.purge(store, existing);
  }

  /** Removes every preview draft agent. Run at boot: no preview survives a restart. */
  async sweep(): Promise<number> {
    const store = this.getStore();
    if (!store) {
      this.log('[preview-draft-agent] sweep deferred: no agent store yet; it runs on the first preview');
      return 0;
    }
    let removed = 0;
    for (const agent of await store.listAgents()) {
      if (!isPreviewDraftAgentSlug(agent.slug)) continue;
      if (await this.purge(store, agent)) removed += 1;
    }
    // A removal whose purge failed left a tombstone: finish it.
    for (const tomb of await store.listTombstones()) {
      if (tomb.deletedBy !== PREVIEW_DELETED_BY || !isPreviewDraftAgentSlug(tomb.slug)) continue;
      if (await store.purgeAgent(tomb.id)) removed += 1;
    }
    this.swept = true;
    if (removed > 0) this.log(`[preview-draft-agent] sweep removed ${String(removed)} draft agent(s)`);
    return removed;
  }

  private requireStore(): PreviewDraftAgentStore {
    const store = this.getStore();
    if (!store) {
      throw new PreviewDraftAgentUnavailableError(
        'the preview runs as a draft agent, and the agent store is not available',
      );
    }
    return store;
  }

  private async purge(store: PreviewDraftAgentStore, agent: AgentRow): Promise<boolean> {
    // Only a draft is ever removed here, whatever its slug says.
    if (agent.status !== 'draft') {
      this.log(`[preview-draft-agent] ${agent.slug} is not a draft (status ${agent.status}); left alone`);
      return false;
    }
    // A tombstone first: `purgeAgent` only removes deleted agents.
    await store.deleteAgent(agent.id, PREVIEW_DELETED_BY);
    const purged = await store.purgeAgent(agent.id);
    this.log(`[preview-draft-agent] removed ${agent.slug}`);
    return purged;
  }
}

function asRef(agent: AgentRow): PreviewDraftAgentRef {
  if (agent.status !== 'draft') {
    throw new PreviewDraftAgentUnavailableError(
      `slug '${agent.slug}' belongs to an agent with status '${agent.status}', not a preview draft`,
    );
  }
  return { id: agent.id, slug: agent.slug, name: agent.name };
}
