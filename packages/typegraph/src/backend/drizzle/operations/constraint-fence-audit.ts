/**
 * The read-only audit behind `store.verifyConstraintFences()`.
 *
 * Every statement here reads a relation the constraint is DECLARED over, never
 * a claim relation's primary key: a claim key admits one row per axis by
 * construction, and a database written before the claim relations existed holds
 * no edge claims at all, so a claim scan reports zero violations on exactly the
 * pre-existing data this audit exists to find. Uniqueness is the one family
 * whose pre-upgrade duplicate IS a pair of claim rows — two live `uniques` rows
 * at two different `node_kind`s — so it reads that relation for the ROWS while
 * leaving "do these two axes fold together?" to the caller.
 *
 * Each family is one statement with a correlated `EXISTS` over the same
 * relation, rather than a `GROUP BY … HAVING count(*) > 1` followed by a
 * second fetch of the members: one round trip, no tuple-list `IN` to render,
 * and the same rows either way.
 */
import { getTableName, type SQL, sql } from "drizzle-orm";

import {
  type EdgeCardinalityAxisRef,
  type EdgeCardinalitySpec,
  edgeCardinalitySpec,
} from "../../../store/claims/edge-claims";
import type { CompositionClaimScope } from "../../types";
import { claimHolderTerms, endpointTerms } from "./edge-claims";
import { currentWindowPredicate, quotedColumn, type Tables } from "./shared";

/** The alias the correlated subquery reads the same relation under. */
const PEER = "peer";

/** The alias the misassigned-endpoint audit's `VALUES` derived table reads under. */
const ALLOWED_PAIR_ALIAS = "tg_allowed_pair";

/** Qualifies a column with a relation name, the rendering both dialects read. */
function qualified(relation: string, column: Readonly<{ name: string }>): SQL {
  return sql.raw(`"${relation}"."${column.name}"`);
}

/** A bound-parameter `IN (…)` list; callers never pass an empty one. */
function inList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/**
 * The row every edge-family audit reports, in one place: the edge's identity
 * and both endpoints, named as the caller's row type spells them
 * ({@link file://../../operation-backend-core.ts readConstraintFenceViolations}).
 * An added audit column is then one edit here and one in that row type, rather
 * than one per statement.
 */
function edgeAuditProjection(edges: Tables["edges"]): SQL {
  return sql`
    ${quotedColumn(edges.id)} as edge_id,
    ${quotedColumn(edges.kind)} as edge_kind,
    ${quotedColumn(edges.fromKind)} as from_kind,
    ${quotedColumn(edges.fromId)} as from_id,
    ${quotedColumn(edges.toKind)} as to_kind,
    ${quotedColumn(edges.toId)} as to_id
  `;
}

/**
 * What a member of a cardinality population must still BE, read off the axis's
 * {@link edgeCardinalitySpec}: `"liveAndActive"` additionally requires an open
 * validity window. Rendered for the outer row and for the correlated peer from
 * the same ternary, so the two sides of one statement cannot disagree.
 */
function holderLivenessTerm(
  holderLiveness: EdgeCardinalitySpec["holderLiveness"],
  relation: string,
  edges: Tables["edges"],
): SQL {
  return holderLiveness === "liveAndActive" ?
      sql` AND ${qualified(relation, edges.validTo)} IS NULL`
    : sql.empty();
}

/**
 * Live `uniques` rows sharing a `(constraint_name, key)` with another live row,
 * restricted to constraint names the graph declares.
 *
 * The restriction is load-bearing, not a filter for speed: the same relation
 * holds disjointness claims under a reserved constraint name whose `node_kind`
 * is a PAIR label, and no uniqueness axis can be computed for one. Those rows
 * are audited from the nodes relation instead
 * ({@link buildDisjointOverlapAudit}).
 *
 * The peer test is `node_kind <> node_kind` because the relation's primary key
 * already makes two rows with equal `(graph_id, node_kind, constraint_name,
 * key)` impossible — so a peer is by definition a row at a DIFFERENT axis,
 * which is precisely the shape a pre-upgrade duplicate leaves behind.
 */
export function buildContendedUniqueRowAudit(
  tables: Tables,
  graphId: string,
  constraintNames: readonly string[],
): SQL {
  const { uniques } = tables;
  const relation = getTableName(uniques);
  return sql`
    SELECT
      ${quotedColumn(uniques.nodeKind)} as node_kind,
      ${quotedColumn(uniques.constraintName)} as constraint_name,
      ${quotedColumn(uniques.key)} as key,
      ${quotedColumn(uniques.concreteKind)} as concrete_kind,
      ${quotedColumn(uniques.nodeId)} as node_id
    FROM ${uniques}
    WHERE ${qualified(relation, uniques.graphId)} = ${graphId}
      AND ${qualified(relation, uniques.constraintName)} IN (${inList(constraintNames)})
      AND ${qualified(relation, uniques.deletedAt)} IS NULL
      AND EXISTS (
        SELECT 1 FROM ${uniques} AS ${sql.raw(`"${PEER}"`)}
        WHERE ${qualified(PEER, uniques.graphId)} = ${qualified(relation, uniques.graphId)}
          AND ${qualified(PEER, uniques.constraintName)} = ${qualified(relation, uniques.constraintName)}
          AND ${qualified(PEER, uniques.key)} = ${qualified(relation, uniques.key)}
          AND ${qualified(PEER, uniques.deletedAt)} IS NULL
          AND ${qualified(PEER, uniques.nodeKind)} <> ${qualified(relation, uniques.nodeKind)}
      )
  `;
}

/**
 * Live edges of the named kinds sharing one declared cardinality axis's
 * population with another live edge.
 *
 * Which endpoint the population is keyed by (`keyShape`) and what a member
 * must still BE (`holderLiveness`) are read from
 * {@link edgeCardinalitySpec} — the same table the probe and the claim's SQL
 * read — so the audit cannot report a population the fence does not fence, or
 * miss one it does: `"from"` emits from-terms only, `"to"` emits to-terms
 * only, `"fromAndTo"` emits both. One statement per axis, because that is the
 * granularity at which the spec differs.
 */
export function buildContendedEdgeRowAudit(
  tables: Tables,
  graphId: string,
  ref: EdgeCardinalityAxisRef,
  edgeKinds: readonly string[],
): SQL {
  const { edges } = tables;
  const relation = getTableName(edges);
  const spec = edgeCardinalitySpec(ref);
  const activeOnly = holderLivenessTerm(spec.holderLiveness, relation, edges);
  const peerActiveOnly = holderLivenessTerm(spec.holderLiveness, PEER, edges);
  // The endpoint fold belongs to `endpointTerms` — the same renderer the
  // write-path fence reads it through — given the OUTER row's own qualified
  // columns in place of a write's bound literals, so the audit cannot key the
  // population on a different subset of endpoints than the fence does.
  const peerEndpoints = endpointTerms(PEER, edges, spec.keyShape, {
    fromKind: qualified(relation, edges.fromKind),
    fromId: qualified(relation, edges.fromId),
    toKind: qualified(relation, edges.toKind),
    toId: qualified(relation, edges.toId),
  });

  return sql`
    SELECT${edgeAuditProjection(edges)}
    FROM ${edges}
    WHERE ${qualified(relation, edges.graphId)} = ${graphId}
      AND ${qualified(relation, edges.kind)} IN (${inList(edgeKinds)})
      AND ${qualified(relation, edges.deletedAt)} IS NULL${activeOnly}
      AND EXISTS (
        SELECT 1 FROM ${edges} AS ${sql.raw(`"${PEER}"`)}
        WHERE ${qualified(PEER, edges.graphId)} = ${qualified(relation, edges.graphId)}
          AND ${qualified(PEER, edges.kind)} = ${qualified(relation, edges.kind)}${peerEndpoints}
          AND ${qualified(PEER, edges.deletedAt)} IS NULL${peerActiveOnly}
          AND ${qualified(PEER, edges.id)} <> ${qualified(relation, edges.id)}
      )
  `;
}

/**
 * Live composition-scoped edges sharing one PART identity with another live
 * edge, across every realizing edge kind and orientation.
 *
 * `buildContendedEdgeRowAudit`'s peer test (`peer.kind = relation.kind`) is
 * wrong here: the composition claim's axis is relation-wide, so a `Chapter`
 * attached via `chapterOf` (`partSide: "from"`) and the SAME `Chapter`
 * attached via `includedIn` (`partSide: "to"`) must be found contending even
 * though they are different edge kinds in different orientations. The peer
 * test below IS {@link file://./edge-claims.ts claimHolderTerms} — the same
 * function the write-path fence calls — given the OUTER row's own qualified
 * part column instead of a write's bound literal, so this audit and the
 * fence can never render two different answers to "does this row hold the
 * axis this claim contends for".
 *
 * `ref` fixes which side of the OUTER row is the part (`edgeCardinalitySpec`'s
 * `keyShape`, always `"from"` or `"to"` for a composition ref — never
 * `"fromAndTo"`), so only the outer row's own side needs qualifying; the
 * PEER may be either side, which `claimHolderTerms`' two-arm OR already
 * expresses.
 */
export function buildContendedCompositionEdgeRowAudit(
  tables: Tables,
  graphId: string,
  ref: EdgeCardinalityAxisRef,
  holders: CompositionClaimScope["holders"],
  reportedEdgeKinds: readonly string[],
): SQL {
  const { edges } = tables;
  const relation = getTableName(edges);
  const spec = edgeCardinalitySpec(ref);
  const outerPartKindColumn =
    spec.keyShape === "from" ? edges.fromKind : edges.toKind;
  const outerPartIdColumn =
    spec.keyShape === "from" ? edges.fromId : edges.toId;
  const activeOnly = holderLivenessTerm(spec.holderLiveness, relation, edges);
  const peerActiveOnly = holderLivenessTerm(spec.holderLiveness, PEER, edges);

  // The composition overload of `claimHolderTerms`: given a part identity in
  // place of a claim value source, it needs nothing beyond the axis ref and
  // `scope` — no fabricated `edgeKind`/`fromKind`/`fromId`/`toKind`/`toId`
  // for a caller to invent or a reader to check is unread.
  const peerHolderTerms = claimHolderTerms(
    PEER,
    edges,
    { ...ref, scope: { kind: "composition", holders } },
    {
      part: {
        kind: qualified(relation, outerPartKindColumn),
        id: qualified(relation, outerPartIdColumn),
      },
    },
  );

  return sql`
    SELECT${edgeAuditProjection(edges)}
    FROM ${edges}
    WHERE ${qualified(relation, edges.graphId)} = ${graphId}
      AND ${qualified(relation, edges.kind)} IN (${inList(reportedEdgeKinds)})
      AND ${qualified(relation, edges.deletedAt)} IS NULL${activeOnly}
      AND EXISTS (
        SELECT 1 FROM ${edges} AS ${sql.raw(`"${PEER}"`)}
        WHERE ${qualified(PEER, edges.graphId)} = ${qualified(relation, edges.graphId)}
          AND ${peerHolderTerms}
          AND ${qualified(PEER, edges.deletedAt)} IS NULL${peerActiveOnly}
          AND ${qualified(PEER, edges.id)} <> ${qualified(relation, edges.id)}
      )
  `;
}

/**
 * The ids live under BOTH kinds of one declared disjoint pair.
 *
 * The nodes relation, not the claim relation, for the same reason as the edge
 * families: a pre-upgrade overlap holds no disjointness claim. `INTERSECT`
 * rather than a self-join so the statement says what it means; one statement
 * per declared pair bounds the cost by the declaration, not by graph size.
 */
export function buildDisjointOverlapAudit(
  tables: Tables,
  graphId: string,
  kinds: readonly [string, string],
): SQL {
  const { nodes } = tables;
  const relation = getTableName(nodes);
  const liveIdsOfKind = (kind: string): SQL => sql`
    SELECT ${quotedColumn(nodes.id)} as node_id
    FROM ${nodes}
    WHERE ${qualified(relation, nodes.graphId)} = ${graphId}
      AND ${qualified(relation, nodes.kind)} = ${kind}
      AND ${qualified(relation, nodes.deletedAt)} IS NULL
  `;
  return sql`${liveIdsOfKind(kinds[0])} INTERSECT ${liveIdsOfKind(kinds[1])}`;
}

/**
 * Live edges of one kind whose `(from_kind, to_kind)` matches no declared
 * pair.
 *
 * A pair list rather than a per-side kind list because a source-dependent
 * target map (`targetKindsBySource`) admits pairs, not a Cartesian product —
 * and because the caller already expanded subsumption
 * (`expandEdgeEndpointAllowance`), so this statement compares literals only.
 * An EMPTY allowance list means the declaration admits nothing: every live
 * edge of the kind is returned, and the statement renders no pair predicate
 * at all.
 *
 * The admitted-pairs list is rendered as a `VALUES` derived table joined by
 * `NOT EXISTS`, never as a disjunction of bound equality pairs: a flat `OR`
 * chain nests one boolean operator per pair, so its parsed expression tree
 * grows with the pair count and exceeds SQLite's `SQLITE_MAX_EXPR_DEPTH`
 * (1000) on an ordinary subclass hierarchy — a root with ~40 direct
 * subclasses and one edge kind over it already renders (41)² ≈ 1681 pairs.
 * `VALUES` rows are siblings in the parse tree, not nested expressions, so
 * this predicate's depth is constant in the pair count; the caller
 * ({@link file://../../operation-backend-core.ts readConstraintFenceViolations})
 * still chunks `allowedPairs` to the connection's bound-parameter budget and
 * intersects the per-chunk results, because that budget (not expression
 * depth) is what an unbounded pair count can still exceed on every dialect.
 *
 * "Live" is {@link currentWindowPredicate} — the same window an ordinary
 * current read applies — not `valid_to IS NULL`. A currently-valid edge can
 * carry a bounded FUTURE `valid_to` (e.g. a term appointment); it is what
 * every current-coordinate read returns today, so it is exactly what this
 * audit must not miss. `now` is a parameter, not `nowIso()` sampled here, so
 * every chunk of every allowance in one audit call reads against the same
 * instant.
 */
export function buildMisassignedEdgeEndpointAudit(
  tables: Tables,
  graphId: string,
  edgeKind: string,
  now: string,
  allowedPairs: readonly (readonly [string, string])[],
): SQL {
  const { edges } = tables;
  const relation = getTableName(edges);
  const admittedPredicate =
    allowedPairs.length === 0 ?
      sql.empty()
    : sql`
      AND NOT EXISTS (
             SELECT 1 FROM (VALUES ${sql.join(
               allowedPairs.map(
                 ([fromKind, toKind]) => sql`(${fromKind}, ${toKind})`,
               ),
               sql`, `,
             )}) AS ${sql.raw(`"${ALLOWED_PAIR_ALIAS}"`)}
             WHERE ${sql.raw(`"${ALLOWED_PAIR_ALIAS}".column1`)} = ${qualified(relation, edges.fromKind)}
               AND ${sql.raw(`"${ALLOWED_PAIR_ALIAS}".column2`)} = ${qualified(relation, edges.toKind)}
           )
    `;
  return sql`
    SELECT${edgeAuditProjection(edges)}
    FROM ${edges}
    WHERE ${qualified(relation, edges.graphId)} = ${graphId}
      AND ${qualified(relation, edges.kind)} = ${edgeKind}
      AND ${currentWindowPredicate(relation, edges, now)}${admittedPredicate}
  `;
}
