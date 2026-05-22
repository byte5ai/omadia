/**
 * @omadia/plugin-api — Topic clustering capability (KG-ACL Slice 11).
 *
 * Operator-triggered pass that clusters MemorableKnowledge nodes by
 * their embedding (connected-components on cosine similarity above a
 * threshold). Each non-trivial cluster becomes a `Topic` node with a
 * Haiku-generated name + description; member MKs are wired in via
 * `HAS_TOPIC` edges.
 *
 * Re-cluster is destructive: the trigger deletes all existing Topics
 * + edges for the tenant and rebuilds them. Operator browses the
 * result at `/admin/topics`.
 */

import type { GraphNode } from './knowledgeGraph.js';

export type TopicNamingSource = 'haiku' | 'fallback';

export interface TopicNode {
  /** External id, scheme `topic:<uuid>`. */
  id: string;
  type: 'Topic';
  props: {
    name: string;
    description: string;
    /** Cached count of HAS_TOPIC inbound edges at create-time.
     *  Stays in sync because re-clustering deletes-and-rebuilds, so
     *  the cached value never drifts. */
    member_count: number;
    created_at: string;
    updated_at: string;
    naming_source: TopicNamingSource;
  };
}

export interface TopicDetail extends TopicNode {
  /** Member MKs the viewer is authorised to see. The KG layer filters
   *  via the per-MK ACL gate; non-owners get a degraded view. */
  members: GraphNode[];
}

export interface TopicClusteringRunOptions {
  /** Cosine similarity floor for connected-components graph edges.
   *  Default 0.6. Higher = tighter, more clusters. */
  similarityThreshold?: number;
  /** Clusters smaller than this stay unclustered. Default 3. */
  minClusterSize?: number;
}

export interface TopicClusteringRunResult {
  totalMemoriesScanned: number;
  memoriesWithEmbedding: number;
  /** Topics removed in the wipe step. */
  topicsDeleted: number;
  topicsCreated: number;
  /** MKs that landed in clusters smaller than `minClusterSize`,
   *  or had no embedding. */
  unclusteredMemories: number;
  /** Number of Haiku naming-calls actually issued. Zero when the
   *  service was constructed without an Anthropic client. */
  haikuCalls: number;
  durationMs: number;
}

export interface TopicClusteringService {
  list(): Promise<TopicNode[]>;
  getWithMembers(
    topicExternalId: string,
    viewerOmadiaUserId: string,
  ): Promise<TopicDetail | null>;
  recluster(opts?: TopicClusteringRunOptions): Promise<TopicClusteringRunResult>;
}

export const TOPIC_CLUSTERING_SERVICE_NAME = 'topicClustering';
export const TOPIC_CLUSTERING_CAPABILITY = 'topicClustering@1';
