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
  type ConstrainedCardinality,
  EDGE_CARDINALITY_SPECS,
} from "../../../store/claims/edge-claims";
import { quotedColumn, type Tables } from "./shared";

/** The alias the correlated subquery reads the same relation under. */
const PEER = "peer";

/** Qualifies a column with a relation name, the rendering both dialects read. */
function qualified(
  relation: string,
  column: Readonly<{ name: string }>,
): SQL {
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
 * Live edges of the named kinds sharing one declared cardinality's population
 * with another live edge.
 *
 * Which endpoints the population is keyed by and what a member must still BE
 * are read from {@link EDGE_CARDINALITY_SPECS} — the same table the probe and
 * the claim's SQL read — so the audit cannot report a population the fence does
 * not fence, or miss one it does. One statement per cardinality, because that
 * is the granularity at which the spec differs.
 */
export function buildContendedEdgeRowAudit(
  tables: Tables,
  graphId: string,
  cardinality: ConstrainedCardinality,
  edgeKinds: readonly string[],
): SQL {
  const { edges } = tables;
  const relation = getTableName(edges);
  const spec = EDGE_CARDINALITY_SPECS[cardinality];
  const activeOnly =
    spec.holderLiveness === "liveAndActive" ?
      sql` AND ${qualified(relation, edges.validTo)} IS NULL`
    : sql.empty();
  const peerActiveOnly =
    spec.holderLiveness === "liveAndActive" ?
      sql` AND ${qualified(PEER, edges.validTo)} IS NULL`
    : sql.empty();
  const peerToEndpoints =
    spec.keyShape === "fromAndTo" ?
      sql`
        AND ${qualified(PEER, edges.toKind)} = ${qualified(relation, edges.toKind)}
                  AND ${qualified(PEER, edges.toId)} = ${qualified(relation, edges.toId)}
      `
    : sql.empty();

  return sql`
    SELECT
      ${quotedColumn(edges.id)} as edge_id,
      ${quotedColumn(edges.kind)} as edge_kind,
      ${quotedColumn(edges.fromKind)} as from_kind,
      ${quotedColumn(edges.fromId)} as from_id,
      ${quotedColumn(edges.toKind)} as to_kind,
      ${quotedColumn(edges.toId)} as to_id
    FROM ${edges}
    WHERE ${qualified(relation, edges.graphId)} = ${graphId}
      AND ${qualified(relation, edges.kind)} IN (${inList(edgeKinds)})
      AND ${qualified(relation, edges.deletedAt)} IS NULL${activeOnly}
      AND EXISTS (
        SELECT 1 FROM ${edges} AS ${sql.raw(`"${PEER}"`)}
        WHERE ${qualified(PEER, edges.graphId)} = ${qualified(relation, edges.graphId)}
          AND ${qualified(PEER, edges.kind)} = ${qualified(relation, edges.kind)}
          AND ${qualified(PEER, edges.fromKind)} = ${qualified(relation, edges.fromKind)}
          AND ${qualified(PEER, edges.fromId)} = ${qualified(relation, edges.fromId)}${peerToEndpoints}
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
