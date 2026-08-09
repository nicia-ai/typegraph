import { canonicalValueKey } from "./canonical-props";
import type { MergeKey } from "./node-key";
import {
  compareMergeKeys,
  compareStrings,
  idOf,
  kindOf,
  mergeKey,
} from "./node-key";
import type { JsonValue, NodeId, NodeType } from "./typegraph-internal";
import type { SimilarityStrategy } from "./types";

/** A complete graph-merge node identity. */
export type EntityRef = Readonly<{
  kind: string;
  id: NodeId<NodeType>;
}>;

/** Structured attribution for one candidate-recall path. */
export type MatchSource =
  | Readonly<{ kind: "block"; sourceId: string }>
  | Readonly<{
      kind: "unique";
      sourceId: string;
      constraintName: string;
    }>
  | Readonly<{
      kind: "baseUnique";
      sourceId: string;
      constraintName: string;
    }>
  | Readonly<{
      kind: "baseIndex";
      sourceId: string;
      indexName: string;
    }>
  | Readonly<{ kind: "keyless"; sourceId: string }>
  | Readonly<{ kind: "retype"; sourceId: string }>
  | Readonly<{
      kind: "custom";
      sourceId: string;
      metadata?: JsonValue;
    }>;

/** JSON-safe description of the strategy that actually scored a pair. */
export type MatchStrategy =
  | Readonly<{ kind: "fulltext"; fields: readonly string[] }>
  | Readonly<{ kind: "vector"; fields: readonly string[] }>
  | Readonly<{
      kind: "hybrid";
      fields: readonly string[];
      weights: Readonly<{ vector: number; fulltext: number }>;
    }>
  | Readonly<{ kind: "custom" }>;

/** Serializable explanation for one accepted identity edge. */
export type MatchEvidence =
  | Readonly<{
      a: EntityRef;
      b: EntityRef;
      sources: readonly MatchSource[];
      decision: "definitional";
    }>
  | Readonly<{
      a: EntityRef;
      b: EntityRef;
      sources: readonly MatchSource[];
      decision: "scored";
      strategy: MatchStrategy;
      score: number;
      threshold: number;
    }>;

/** One opt-in scorer observation, retained independently of cluster membership. */
export type CandidateDiagnostic =
  | Readonly<{
      evidence: Extract<MatchEvidence, Readonly<{ decision: "scored" }>>;
      scoreDecision: "accepted" | "rejected";
      reason?: "noComparableValues";
      clusterDisposition?:
        | "retained"
        | Readonly<{
            kind: "excluded";
            reason: "diameter" | "baseAmbiguity";
          }>;
    }>
  | Readonly<{
      evidence: Extract<MatchEvidence, Readonly<{ decision: "definitional" }>>;
      scoreDecision: "accepted";
      clusterDisposition: Readonly<{
        kind: "excluded";
        reason: "diameter" | "baseAmbiguity";
      }>;
    }>;

/** Bounded public diagnostic collection assembled by the merge planner. */
export type CandidateDiagnostics = Readonly<{
  entries: readonly CandidateDiagnostic[];
  total: number;
  limit: number;
  truncated: boolean;
}>;

/** Converts an internal composite key into its public JSON-safe identity. */
export function entityRef(key: MergeKey): EntityRef {
  return { kind: kindOf(key), id: idOf(key) };
}

const SOURCE_KIND_ORDER: Readonly<Record<MatchSource["kind"], number>> = {
  block: 0,
  unique: 1,
  baseUnique: 2,
  baseIndex: 3,
  keyless: 4,
  retype: 5,
  custom: 6,
};

/** Canonical JSON key for source deduplication and ordering. */
function sourceKey(source: MatchSource): string {
  switch (source.kind) {
    case "block":
    case "keyless":
    case "retype": {
      return JSON.stringify([SOURCE_KIND_ORDER[source.kind], source.sourceId]);
    }
    case "unique":
    case "baseUnique": {
      return JSON.stringify([
        SOURCE_KIND_ORDER[source.kind],
        source.sourceId,
        source.constraintName,
      ]);
    }
    case "baseIndex": {
      return JSON.stringify([
        SOURCE_KIND_ORDER[source.kind],
        source.sourceId,
        source.indexName,
      ]);
    }
    case "custom": {
      return JSON.stringify([
        SOURCE_KIND_ORDER.custom,
        source.sourceId,
        source.metadata === undefined ? "" : canonicalValueKey(source.metadata),
      ]);
    }
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** Stable, duplicate-free union of every attribution for an endpoint pair. */
export function normalizeMatchSources(
  sources: readonly MatchSource[],
): readonly MatchSource[] {
  const byKey = new Map<string, MatchSource>();
  for (const source of sources) {
    byKey.set(sourceKey(source), source);
  }
  return [...byKey]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, source]) => source);
}

const DEFAULT_HYBRID_WEIGHT = 0.5;

/** Builds the effective, function-free strategy descriptor used in evidence. */
export function describeMatchStrategy(
  strategy: SimilarityStrategy,
): MatchStrategy {
  switch (strategy.kind) {
    case "fulltext": {
      return { kind: "fulltext", fields: [...strategy.fields] };
    }
    case "vector": {
      return { kind: "vector", fields: [strategy.field] };
    }
    case "hybrid": {
      const vector = strategy.weights?.vector ?? DEFAULT_HYBRID_WEIGHT;
      const fulltext = strategy.weights?.fulltext ?? DEFAULT_HYBRID_WEIGHT;
      const total = vector + fulltext;
      const weights =
        total === 0 ?
          { vector: DEFAULT_HYBRID_WEIGHT, fulltext: DEFAULT_HYBRID_WEIGHT }
        : { vector: vector / total, fulltext: fulltext / total };
      return { kind: "hybrid", fields: [...strategy.fields], weights };
    }
    case "custom": {
      return { kind: "custom" };
    }
    default: {
      const exhaustive: never = strategy;
      return exhaustive;
    }
  }
}

/** Total order for evidence and diagnostic serialization. */
export function compareMatchEvidence(
  left: MatchEvidence,
  right: MatchEvidence,
): number {
  const leftA = mergeKey(left.a.kind, left.a.id);
  const rightA = mergeKey(right.a.kind, right.a.id);
  const byA = compareMergeKeys(leftA, rightA);
  if (byA !== 0) return byA;
  const leftB = mergeKey(left.b.kind, left.b.id);
  const rightB = mergeKey(right.b.kind, right.b.id);
  return compareMergeKeys(leftB, rightB);
}
