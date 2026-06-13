/**
 * @omadia/orchestrator-extras — Topic clustering (KG-ACL Slice 11).
 *
 * Operator-triggered pass that:
 *   1. Pulls every MK with a populated embedding.
 *   2. Builds a similarity graph (cosine ≥ threshold).
 *   3. Finds connected components via union-find.
 *   4. For each component ≥ minClusterSize: asks Haiku to name + describe
 *      the cluster from its top-5 member summaries (or falls back to
 *      `Cluster <n>` if Haiku is unavailable).
 *   5. Persists Topic + HAS_TOPIC edges. Destructive — wipes old Topics
 *      first so a re-cluster delivers a clean rebuild.
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

export interface TopicClusteringDeps {
  kg: KnowledgeGraph;
  /** Optional. When absent, naming falls back to "Cluster <n>". */
  llm?: LlmProvider;
  /** Haiku model id. Default 'claude-haiku-4-5-20251001'. */
  model?: string;
  log?: (msg: string) => void;
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

  async function list(): Promise<TopicNode[]> {
    return deps.kg.listTopics();
  }

  async function getWithMembers(
    topicExternalId: string,
    viewerOmadiaUserId: string,
  ): Promise<TopicDetail | null> {
    const topic = await deps.kg.getTopic(topicExternalId);
    if (!topic) return null;
    const rawMembers = await deps.kg.listTopicMembers(topicExternalId);
    // Filter through the ACL gate: a member that the viewer can't see
    // drops out, but the topic itself stays visible.
    const visible: GraphNode[] = [];
    for (const member of rawMembers) {
      const gated = await deps.kg.getMemorableKnowledge(
        member.id,
        viewerOmadiaUserId,
      );
      if (gated) visible.push(gated);
    }
    return { ...topic, members: visible };
  }

  async function nameCluster(
    summaries: string[],
    fallbackIndex: number,
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
      const response = await deps.llm.complete({
        model,
        maxTokens: 250,
        system: NAMING_PROMPT,
        messages: [textMessage('user', body)],
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
      return { ...parsed, source: 'haiku' };
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

    // 2. Pairwise cosine → union-find.
    const n = items.length;
    const uf = new UnionFind(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = cosine(items[i]!.embedding, items[j]!.embedding);
        if (sim >= threshold) uf.union(i, j);
      }
    }

    // 3. Group by root.
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const root = uf.find(i);
      const arr = groups.get(root);
      if (arr) arr.push(i);
      else groups.set(root, [i]);
    }

    // 4. Wipe + rebuild.
    const topicsDeleted = await deps.kg.deleteAllTopics();
    let topicsCreated = 0;
    let unclusteredMemories = 0;
    let haikuCalls = 0;

    const eligibleGroups = [...groups.values()]
      .filter((group) => group.length >= minClusterSize)
      // Largest first so the operator sees meaningful clusters at the
      // top of the eventual list (the KG layer's `listTopics` also
      // orders by member_count DESC).
      .sort((a, b) => b.length - a.length);

    for (let g = 0; g < eligibleGroups.length; g++) {
      const group = eligibleGroups[g]!;
      const summaries = group.map((idx) =>
        String(items[idx]!.mk.props['summary'] ?? ''),
      );
      const naming = await nameCluster(summaries, g);
      if (naming.source === 'haiku') haikuCalls++;

      try {
        await deps.kg.createTopic({
          name: naming.name,
          description: naming.description,
          namingSource: naming.source,
          memberMkIds: group.map((idx) => items[idx]!.mk.id),
        });
        topicsCreated++;
      } catch (err) {
        log(
          `[topic-clustering] createTopic failed for group ${String(g)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const group of groups.values()) {
      if (group.length < minClusterSize) unclusteredMemories += group.length;
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
