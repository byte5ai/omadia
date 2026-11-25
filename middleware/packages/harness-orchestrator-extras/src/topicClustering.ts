/**
 * @omadia/orchestrator-extras — Topic clustering (KG-ACL Slice 11).
 *
 * Operator-triggered pass that:
 *   1. Pulls every MK with a populated embedding.
 *   2. Splits them by owner set (`acl_owners`, ADR 0045): a topic's name and
 *      description are written from its members' summaries, so a topic only
 *      ever groups memories with the same readers. MKs without owners are
 *      readable by no one and get no topic.
 *   3. Per owner set: builds a similarity graph (cosine ≥ threshold) and
 *      finds connected components via union-find.
 *   4. For each component ≥ minClusterSize: asks Haiku to name + describe
 *      the cluster from its top-5 member summaries (or falls back to
 *      `Cluster <n>` if Haiku is unavailable).
 *   5. Persists Topic + HAS_TOPIC edges. Destructive — wipes old Topics
 *      first so a re-cluster delivers a clean rebuild.
 *
 * Reads are gated per viewer: `list` and `getWithMembers` show a topic only
 * when the viewer can read every current member, so an ACL change after the
 * re-cluster cannot turn a topic into a window onto memories the viewer lost.
 * A topic that lost a member since it was written (deleted or purged) is
 * hidden from everyone until the next re-cluster: its text still carries the
 * gone member's summary.
 *
 * No Anthropic key required for the service to be published — fallback
 * naming keeps the feature operable without paid LLM access.
 */

import type { LlmProvider } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';
import type {
  GraphNode,
  KnowledgeGraph,
  TopicClusteringRunOptions,
  TopicClusteringRunResult,
  TopicClusteringService,
  TopicDetail,
  TopicNamingSource,
  TopicNode,
} from '@omadia/plugin-api';

import type { JobPrivacyRun, OpenJobPrivacy } from './jobPrivacy.js';

export interface TopicClusteringDeps {
  kg: KnowledgeGraph;
  /** Optional. When absent, naming falls back to "Cluster <n>". */
  llm?: LlmProvider;
  /** Haiku model id. Default 'claude-haiku-4-5-20251001'. */
  model?: string;
  log?: (msg: string) => void;
  /**
   * WP-10 — the Privacy Shield route for the member summaries, which carry
   * stored real values. One run per `recluster`; the name and description
   * are restored before they are persisted. A run that cannot mask names the
   * cluster with the fallback, without a model call. Absent ⇒ the summaries
   * go out as stored.
   */
  privacy?: OpenJobPrivacy;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_SIMILARITY_THRESHOLD = 0.6;
const DEFAULT_MIN_CLUSTER_SIZE = 3;
const TOP_K_FOR_NAMING = 5;

const NAMING_PROMPT = `You are naming a topic cluster from several MemorableKnowledge summaries that an embedding model placed close together. Pick a short, precise label (≤60 chars) and a one-sentence description (≤200 chars).

Reply with ONLY a single-line JSON object, no prose, no code fences.

Schema:
{"name": "<≤60 chars>", "description": "<≤200 chars>"}`;

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Simple weighted-quick-union find. */
class UnionFind {
  private parent: number[];
  private size: number[];

  constructor(n: number) {
    this.parent = new Array<number>(n);
    this.size = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      this.parent[i] = i;
      this.size[i] = 1;
    }
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root]!;
    // Path compression.
    let i = x;
    while (this.parent[i] !== root) {
      const next = this.parent[i]!;
      this.parent[i] = root;
      i = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra]! < this.size[rb]!) {
      this.parent[ra] = rb;
      this.size[rb]! += this.size[ra]!;
    } else {
      this.parent[rb] = ra;
      this.size[ra]! += this.size[rb]!;
    }
  }
}

/** The MK's owners; an MK without the array has none (readable by no one). */
function ownersOf(mk: GraphNode): readonly string[] {
  const owners = mk.props['acl_owners'];
  return Array.isArray(owners) ? owners.filter((o): o is string => typeof o === 'string') : [];
}

/** True when the topic still has every member it was written from. */
function isIntact(topic: TopicNode, members: readonly GraphNode[]): boolean {
  return members.length > 0 && members.length === topic.props.member_count;
}

/** True when the topic is intact and the viewer may read every member. */
function readableByViewer(
  topic: TopicNode,
  members: readonly GraphNode[],
  viewer: string,
): boolean {
  return isIntact(topic, members) && members.every((m) => ownersOf(m).includes(viewer));
}

type EmbeddedMk = { mk: GraphNode; embedding: number[] };

/**
 * Groups MKs by their exact owner set. Returns the partitions and the MKs
 * without owners, which no partition takes.
 */
function partitionByOwners(items: readonly EmbeddedMk[]): {
  partitions: EmbeddedMk[][];
  ownerless: number;
} {
  const byKey = new Map<string, EmbeddedMk[]>();
  let ownerless = 0;
  for (const item of items) {
    const owners = [...new Set(ownersOf(item.mk))].sort();
    if (owners.length === 0) {
      ownerless++;
      continue;
    }
    const key = JSON.stringify(owners);
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  return { partitions: [...byKey.values()], ownerless };
}

/** Connected components of the cosine ≥ threshold graph, as item lists. */
function connectedComponents(items: readonly EmbeddedMk[], threshold: number): EmbeddedMk[][] {
  const n = items.length;
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosine(items[i]!.embedding, items[j]!.embedding) >= threshold) uf.union(i, j);
    }
  }
  const groups = new Map<number, EmbeddedMk[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    groups.set(root, [...(groups.get(root) ?? []), items[i]!]);
  }
  return [...groups.values()];
}

interface ParsedNaming {
  name: string;
  description: string;
}

function parseNaming(raw: string): ParsedNaming | null {
  const trimmed = raw.trim();
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(stripped) as Partial<ParsedNaming>;
    if (
      typeof parsed.name !== 'string' ||
      typeof parsed.description !== 'string'
    ) {
      return null;
    }
    return {
      name: parsed.name.slice(0, 200),
      description: parsed.description.slice(0, 2000),
    };
  } catch {
    return null;
  }
}

export function createTopicClusteringService(
  deps: TopicClusteringDeps,
): TopicClusteringService {
  const log =
    deps.log ?? ((msg: string): void => { console.error(msg); });
  const model = deps.model ?? DEFAULT_MODEL;

  async function list(viewerOmadiaUserId: string): Promise<TopicNode[]> {
    const topics = await deps.kg.listTopics();
    const visible: TopicNode[] = [];
    for (const topic of topics) {
      const members = await deps.kg.listTopicMembers(topic.id);
      if (readableByViewer(topic, members, viewerOmadiaUserId)) visible.push(topic);
    }
    return visible;
  }

  async function getWithMembers(
    topicExternalId: string,
    viewerOmadiaUserId: string,
  ): Promise<TopicDetail | null> {
    const topic = await deps.kg.getTopic(topicExternalId);
    if (!topic) return null;
    const rawMembers = await deps.kg.listTopicMembers(topicExternalId);
    if (!isIntact(topic, rawMembers)) return null;
    // The name and description are written from every member, so the topic
    // is visible only when the viewer passes the ACL gate for all of them.
    const visible: GraphNode[] = [];
    for (const member of rawMembers) {
      const gated = await deps.kg.getMemorableKnowledge(
        member.id,
        viewerOmadiaUserId,
      );
      if (!gated) return null;
      visible.push(gated);
    }
    return { ...topic, members: visible };
  }

  async function nameCluster(
    summaries: string[],
    fallbackIndex: number,
    run: JobPrivacyRun | undefined,
  ): Promise<{ name: string; description: string; source: TopicNamingSource }> {
    if (!deps.llm) {
      return {
        name: `Cluster ${String(fallbackIndex + 1)}`,
        description: summaries.slice(0, 3).join(' · ').slice(0, 200),
        source: 'fallback',
      };
    }
    try {
      const body = summaries
        .slice(0, TOP_K_FOR_NAMING)
        .map((s, i) => `${String(i + 1)}. ${s}`)
        .join('\n');
      const masked = run ? await run.mask(body) : { send: true as const, text: body };
      if (!masked.send) {
        log(
          `[topic-clustering] privacy: ${masked.reason} — naming skipped for cluster ${String(fallbackIndex + 1)}`,
        );
        return {
          name: `Cluster ${String(fallbackIndex + 1)}`,
          description: summaries[0]?.slice(0, 200) ?? '',
          source: 'fallback',
        };
      }
      const response = await deps.llm.complete({
        model,
        maxTokens: 250,
        system: NAMING_PROMPT,
        messages: [textMessage('user', masked.text)],
      });
      const text = collectText(response.content);
      const parsed = parseNaming(text);
      if (!parsed) {
        log(`[topic-clustering] unparseable naming output: ${text.slice(0, 200)}`);
        return {
          name: `Cluster ${String(fallbackIndex + 1)}`,
          description: summaries[0]?.slice(0, 200) ?? '',
          source: 'fallback',
        };
      }
      if (!run) return { ...parsed, source: 'haiku' };
      return {
        name: await run.restore(parsed.name),
        description: await run.restore(parsed.description),
        source: 'haiku',
      };
    } catch (err) {
      log(
        `[topic-clustering] naming Haiku call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        name: `Cluster ${String(fallbackIndex + 1)}`,
        description: summaries[0]?.slice(0, 200) ?? '',
        source: 'fallback',
      };
    }
  }

  async function recluster(
    options: TopicClusteringRunOptions = {},
  ): Promise<TopicClusteringRunResult> {
    const startedAt = Date.now();
    const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const minClusterSize = Math.max(
      2,
      options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE,
    );

    // 1. Pull MKs with embeddings.
    const items = await deps.kg.listMemorableKnowledgeWithEmbeddings();
    if (items.length === 0) {
      const deleted = await deps.kg.deleteAllTopics();
      return {
        totalMemoriesScanned: 0,
        memoriesWithEmbedding: 0,
        topicsDeleted: deleted,
        topicsCreated: 0,
        unclusteredMemories: 0,
        haikuCalls: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    // 2. Split by owner set, then 3. cluster each set on its own.
    const { partitions, ownerless } = partitionByOwners(items);
    const components = partitions.map((p) => connectedComponents(p, threshold));

    // 4. Wipe + rebuild.
    const topicsDeleted = await deps.kg.deleteAllTopics();
    let topicsCreated = 0;
    let unclusteredMemories = ownerless;
    let haikuCalls = 0;
    let clusterIndex = 0;

    for (const groups of components) {
      const eligibleGroups = groups
        .filter((group) => group.length >= minClusterSize)
        // Largest first so the operator sees meaningful clusters at the
        // top of the eventual list (the KG layer's `listTopics` also
        // orders by member_count DESC).
        .sort((a, b) => b.length - a.length);
      for (const group of groups) {
        if (group.length < minClusterSize) unclusteredMemories += group.length;
      }
      // One privacy run per owner set: a value keeps its surrogate across
      // the set's clusters, and no restore can hand back a value from
      // memories of other owners.
      const run = eligibleGroups.length > 0 ? deps.privacy?.('topic-clustering') : undefined;
      for (const group of eligibleGroups) {
        const g = clusterIndex++;
        const summaries = group.map((item) => String(item.mk.props['summary'] ?? ''));
        const naming = await nameCluster(summaries, g, run);
        if (naming.source === 'haiku') haikuCalls++;
        try {
          await deps.kg.createTopic({
            name: naming.name,
            description: naming.description,
            namingSource: naming.source,
            memberMkIds: group.map((item) => item.mk.id),
          });
          topicsCreated++;
        } catch (err) {
          log(
            `[topic-clustering] createTopic failed for group ${String(g)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    log(
      `[topic-clustering] recluster done memories=${String(items.length)} topics=${String(topicsCreated)} unclustered=${String(unclusteredMemories)} haiku=${String(haikuCalls)} duration=${String(durationMs)}ms threshold=${threshold.toFixed(2)} minSize=${String(minClusterSize)}`,
    );

    return {
      totalMemoriesScanned: items.length,
      memoriesWithEmbedding: items.length,
      topicsDeleted,
      topicsCreated,
      unclusteredMemories,
      haikuCalls,
      durationMs,
    };
  }

  return { list, getWithMembers, recluster };
}
