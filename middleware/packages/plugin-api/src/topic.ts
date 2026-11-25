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
 *
 * A topic's name and description are written from its members'
 * summaries, so a topic is content of every member (ADR 0045): it only
 * groups memories with the same owner set, and a viewer sees it only
 * when they may read every current member.
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
    /** Count of HAS_TOPIC inbound edges. Stored at create-time; the
     *  service's `list` and `getWithMembers` return the live count of
     *  the members the viewer reads (all of them, or no topic). */
    member_count: number;
    created_at: string;
    updated_at: string;
    naming_source: TopicNamingSource;
  };
}

export interface TopicDetail extends TopicNode {
  /** The member MKs, each through the per-MK ACL gate. A viewer who
   *  fails the gate for any member gets no topic at all. */
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
  /** Topics whose every member the viewer may read, with live counts. */
  list(viewerOmadiaUserId: string): Promise<TopicNode[]>;
  /** `null` when the topic is unknown or the viewer cannot read every member. */
  getWithMembers(
    topicExternalId: string,
    viewerOmadiaUserId: string,
  ): Promise<TopicDetail | null>;
  recluster(opts?: TopicClusteringRunOptions): Promise<TopicClusteringRunResult>;
}

export const TOPIC_CLUSTERING_SERVICE_NAME = 'topicClustering';
export const TOPIC_CLUSTERING_CAPABILITY = 'topicClustering@1';
