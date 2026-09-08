/**
 * Item D.2: `acyclic: true` on an edge registration.
 *
 * THE acyclicity predicate: "does `from` lie in the reflexive-transitive
 * closure of `to`, over one acyclic relation's live edges". Every write path
 * that can put an edge into a declared-acyclic relation calls
 * {@link assertEdgeRelationsAcyclic} and no other function; the audit and the
 * schema-tightening preflight call {@link readEdgeAcyclicityViolations},
 * which shares the same SQL builder (`buildEdgeAcyclicityProbe`,
 * `src/store/recursive-cte.ts`) so a live-graph audit and a write-path probe
 * can never disagree about what counts as a cycle.
 *
 * The check is exhaustive: a set-semantics (`UNION`, never `UNION ALL`)
 * recursive reachability with no depth bound. `MAX_EXPLICIT_RECURSIVE_DEPTH`
 * does not apply here — see `buildEdgeAcyclicityProbe`'s docblock. An engine
 * that cuts the search short (statement timeout, resource exhaustion) is
 * reported as indeterminate, never as "no cycle".
 *
 * Population (§5 of the design note): every non-deleted edge of the relation
 * counts, regardless of its validity window. A cycle is a property of the
 * edge relation, not of an instant, so honoring `validTo` would let a
 * future-dated edge close a cycle no write ever probed.
 */
import { resolveRecursiveTraversal } from "../backend/capabilities/recursive-traversal";
import { observesPostFenceCommits } from "../backend/command-contract";
import { graphCommandCoordinationIsolation } from "../backend/command-contract";
import { type GraphBackend } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { ConfigurationError, EdgeAcyclicityError } from "../errors";
import { EdgeAcyclicityIndeterminateError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { type DialectAdapter } from "../query/dialect/types";
import { asCompiledRowsSql } from "../query/sql-intent";
import { groupBy } from "../utils/array";
import { compareStrings } from "../utils/compare";
import { requireDefined } from "../utils/presence";
import { isStatementCutShortError } from "../utils/sql-errors";
import { type GraphWriteLock } from "./recorded-capture/clock";
import {
  type AcyclicityProbeSeed,
  buildEdgeAcyclicityProbe,
} from "./recursive-cte";

/**
 * One member of an acyclic relation: an edge kind, and the orientation its
 * rows must be read in to walk the relation part->whole. A standalone
 * `acyclic: true` registration (D.2) is always `reversed: false` — this
 * relation IS the edge kind, read in its stored direction. Item E's
 * composition contract will later hand this builder a relation whose
 * members mix `reversed: false` (part -> whole realizing edges) and
 * `reversed: true` (whole -> part realizing edges), checked as ONE directed
 * relation; a plain edge-kind list cannot express that.
 */
export type AcyclicRelationMember = Readonly<{
  edgeKind: string;
  reversed: boolean;
}>;

/** One acyclic relation: a name, and the oriented edge kinds that form it. */
export type AcyclicEdgeRelation = Readonly<{
  /** The edge kind in D.2; item E's composition relation later. */
  name: string;
  members: readonly AcyclicRelationMember[];
}>;

/**
 * Every acyclic relation this graph declares, in code-point order by name.
 * In D.2 each `acyclic: true` edge kind is its own relation, named after
 * itself, with one `reversed: false` member.
 */
export function acyclicEdgeRelations(
  graph: GraphDef,
): readonly AcyclicEdgeRelation[] {
  return Object.entries(graph.edges)
    .filter(([, registration]) => registration.acyclic === true)
    .map(([edgeKind]): AcyclicEdgeRelation => ({
      name: edgeKind,
      members: [{ edgeKind, reversed: false }],
    }))
    .toSorted((left, right) => compareStrings(left.name, right.name));
}

/** The relation an edge of this kind belongs to, or `undefined`. */
export function acyclicRelationForEdgeKind(
  graph: GraphDef,
  edgeKind: string,
): AcyclicEdgeRelation | undefined {
  return acyclicEdgeRelations(graph).find((relation) =>
    relation.members.some((member) => member.edgeKind === edgeKind),
  );
}

/** An edge a writer proposes to have in the relation when the frame commits. */
export type ProposedRelationEdge = Readonly<{
  edgeId: string;
  edgeKind: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
}>;

/**
 * The `edgeAcyclicity` member of `ConstraintFenceViolation`
 * (`src/store/claims/verify.ts`), defined here so the shape has one owner:
 * the family carries no `ClaimTarget` — acyclicity reserves no claim row,
 * so there is nothing shaped like one to name.
 */
export type EdgeAcyclicityViolation = Readonly<{
  family: "edgeAcyclicity";
  /** The declared relation — the edge kind in D.2. */
  relation: string;
  /** Live edges of the relation whose `to` reaches their `from`. */
  edgeIds: readonly string[];
}>;

export type AcyclicityProbeContext = Readonly<{
  graphId: string;
  graph: GraphDef;
  schema: SqlSchema;
  dialect: DialectAdapter;
  /** The transaction target the frame's row work runs on. */
  target: Pick<
    GraphBackend,
    "capabilities" | "commands" | "dialect" | "execute"
  >;
  /** Compile-time evidence the per-graph fence was taken before any read. */
  lock: GraphWriteLock;
  /** Echoed in every refusal's `details.operation`. */
  operation: string;
}>;

/**
 * What the audit reader needs — `AcyclicityProbeContext` minus `lock` (no
 * write to fence) and `graph` (the relations to probe are passed
 * explicitly, so a caller working from a SERIALIZED schema document rather
 * than a runtime `GraphDef` — the schema-tightening preflight — need not
 * fabricate one just to satisfy this type).
 */
export type AcyclicityAuditContext = Omit<
  AcyclicityProbeContext,
  "lock" | "graph"
>;

/**
 * Runs one acyclicity probe statement and returns the `origin_key`s the
 * database reports as reaching their own `from` — empty when the seed's rows
 * are all fine. Shared by the write-path assertion and the audit reader, so
 * a cut-short statement is classified identically by both.
 *
 * @throws EdgeAcyclicityIndeterminateError when the engine cut the statement
 *   short.
 */
async function runAcyclicityProbe(
  ctx: AcyclicityAuditContext,
  relation: AcyclicEdgeRelation,
  seed: AcyclicityProbeSeed,
): Promise<readonly string[]> {
  const fragment = buildEdgeAcyclicityProbe({
    graphId: ctx.graphId,
    members: relation.members,
    seed,
    dialect: ctx.dialect,
    schema: ctx.schema,
    recursiveTraversal: resolveRecursiveTraversal(ctx.target.capabilities),
    operation: ctx.operation,
  });
  try {
    const rows = await ctx.target.execute<Readonly<{ origin_key: string }>>(
      asCompiledRowsSql(fragment),
    );
    return rows.map((row) => row.origin_key);
  } catch (error) {
    if (!isStatementCutShortError(error)) throw error;
    throw new EdgeAcyclicityIndeterminateError(
      {
        relation: relation.name,
        operation: ctx.operation,
        graphId: ctx.graphId,
      },
      { cause: error },
    );
  }
}

/**
 * A fresh-snapshot guard, applied only where an isolation question exists:
 * `ctx.lock.coordination` is `undefined` for `engine-serialized` /
 * `caller-serialized` write-fence plans (SQLite's single writer, or a
 * caller-serialized deployment), where there is nothing to observe — see
 * `uncapturedGraphWriteLock`. A keyed acquisition on a shared session
 * (`lock` / `row`) mints real coordination, and this is the one place that
 * verifies the session it belongs to actually observes commits made while
 * it waited for the fence.
 *
 * @throws ConfigurationError (`EDGE_ACYCLICITY_REQUIRES_FRESH_SNAPSHOT`)
 */
function assertFreshSnapshot(ctx: AcyclicityProbeContext): void {
  if (ctx.lock.coordination === undefined) return;
  const isolation = graphCommandCoordinationIsolation(
    ctx.target.commands,
    ctx.graphId,
    ctx.lock.coordination,
  );
  if (observesPostFenceCommits(isolation)) return;
  throw new ConfigurationError(
    "Edge-acyclicity requires a transaction isolation that observes writes " +
      "committed while this session waited for the per-graph write fence.",
    {
      code: "EDGE_ACYCLICITY_REQUIRES_FRESH_SNAPSHOT",
      graphId: ctx.graphId,
      isolation,
    },
    {
      suggestion:
        "Use read_committed or serializable transaction isolation, or " +
        "configure a custom PostgreSQL graph-write fence to report the " +
        "effective transaction isolation.",
    },
  );
}

/**
 * THE acyclicity predicate. Every write path calls exactly this function and
 * no other. Refuses with {@link EdgeAcyclicityError} when any proposed edge
 * closes a cycle in its relation; with {@link EdgeAcyclicityIndeterminateError}
 * when the engine cut the search short; with `ConfigurationError`
 * (`RECURSIVE_TRAVERSAL_UNSUPPORTED`) when the backend declares no recursive
 * traversal; with `ConfigurationError`
 * (`EDGE_ACYCLICITY_REQUIRES_FRESH_SNAPSHOT`) when the fenced session cannot
 * observe writes committed while it waited for the fence.
 *
 * Order-insensitive with respect to the proposed rows: the question is "does
 * `from` lie in the reflexive-transitive closure of `to`", and the proposed
 * edge itself, present or absent, is never on such a path unless a cycle
 * already exists. Probe-then-insert (single writes) and insert-then-probe
 * (batches, merge apply) therefore call the same function with the same
 * meaning.
 *
 * Short-circuits three ways before touching SQL: a proposed row whose kind is
 * in no acyclic relation is dropped; a self-loop
 * (`fromKind === toKind && fromId === toId`) is refused immediately, because
 * the reflexive seed would answer the same question with a round trip; and an
 * empty remaining set returns with no statement.
 */
export async function assertEdgeRelationsAcyclic(
  ctx: AcyclicityProbeContext,
  proposed: readonly ProposedRelationEdge[],
): Promise<void> {
  const relevant: Readonly<{
    relation: AcyclicEdgeRelation;
    edge: ProposedRelationEdge;
  }>[] = [];
  for (const edge of proposed) {
    const relation = acyclicRelationForEdgeKind(ctx.graph, edge.edgeKind);
    if (relation === undefined) continue;
    if (edge.fromKind === edge.toKind && edge.fromId === edge.toId) {
      throw new EdgeAcyclicityError({
        relation: relation.name,
        edgeKind: edge.edgeKind,
        edgeId: edge.edgeId,
        fromKind: edge.fromKind,
        fromId: edge.fromId,
        toKind: edge.toKind,
        toId: edge.toId,
        selfLoop: true,
      });
    }
    relevant.push({ relation, edge });
  }
  if (relevant.length === 0) return;

  assertFreshSnapshot(ctx);

  const byRelationName = groupBy(relevant, (entry) => entry.relation.name);
  for (const relationName of [...byRelationName.keys()].toSorted(
    compareStrings,
  )) {
    const entries = requireDefined(byRelationName.get(relationName));
    const relation = entries[0]?.relation;
    if (relation === undefined) continue;
    const edges = entries.map((entry) => entry.edge);
    const violatingOriginKeys = await runAcyclicityProbe(ctx, relation, {
      kind: "proposed",
      edges,
    });
    if (violatingOriginKeys.length === 0) continue;
    const violatingEdge =
      edges.find((edge) => violatingOriginKeys.includes(edge.edgeId)) ??
      requireDefined(edges[0]);
    throw new EdgeAcyclicityError({
      relation: relation.name,
      edgeKind: violatingEdge.edgeKind,
      edgeId: violatingEdge.edgeId,
      fromKind: violatingEdge.fromKind,
      fromId: violatingEdge.fromId,
      toKind: violatingEdge.toKind,
      toId: violatingEdge.toId,
      selfLoop: false,
    });
  }
}

/**
 * The audit reader: every live edge of `relations` whose `to` endpoint
 * reaches its `from` endpoint. Shared verbatim with `verifyConstraintFences`
 * (`src/store/claims/verify.ts`) and with the `acyclic`-added schema-tightening
 * probe (`src/schema/tightening-preflight.ts`), so there is exactly one
 * implementation of "is there a cycle".
 *
 * Takes no `lock`: this is a read-only diagnostic, never gating a live write
 * against a concurrent race, so it runs no isolation-freshness check.
 */
export async function readEdgeAcyclicityViolations(
  ctx: AcyclicityAuditContext,
  relations: readonly AcyclicEdgeRelation[],
): Promise<readonly EdgeAcyclicityViolation[]> {
  const violations: EdgeAcyclicityViolation[] = [];
  for (const relation of [...relations].toSorted((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const originKeys = await runAcyclicityProbe(ctx, relation, {
      kind: "relation",
    });
    if (originKeys.length === 0) continue;
    violations.push({
      family: "edgeAcyclicity",
      relation: relation.name,
      edgeIds: [...originKeys].toSorted(compareStrings),
    });
  }
  return violations;
}
