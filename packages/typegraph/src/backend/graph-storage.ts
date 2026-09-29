/**
 * Read-only views of what a database holds per graph, so an operator can
 * answer "which graphs live here?" and "did `store.clear()` leave anything
 * behind?" without depending on TypeGraph's physical table layout.
 *
 * Both reads consume the one graph-relation inventory (`./graph-relations`):
 * a relation added to the inventory is visible here without further changes,
 * under whatever physical name the backend gave it. A relation whose table the
 * database never provisioned holds no rows for any graph, so it is skipped or
 * counted as zero rather than reported as an error.
 */
import { ConfigurationError } from "../errors";
import { getDialect } from "../query/dialect";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { requireCatalog } from "./capabilities/catalog";
import {
  type RecursiveTraversalVerdict,
  resolveRecursiveTraversal,
} from "./capabilities/recursive-traversal";
import {
  GRAPH_ID_COLUMN,
  GRAPH_PRESENCE_ANCHOR_KEYS,
  GRAPH_RELATIONS,
  type GraphRelationNames,
  resolveGraphRelationNames,
} from "./graph-relations";
import { DEPLOYMENT_CONTRIBUTION_GRAPH_ID } from "./table-contribution";
import {
  type GraphBackend,
  runOptionallyInTransaction,
  type TransactionBackend,
} from "./types";

/** Page size when {@link ListGraphIdsOptions.limit} is omitted. */
const DEFAULT_LIST_GRAPH_IDS_LIMIT = 100;

/** Largest page {@link listGraphIds} returns. */
const MAX_LIST_GRAPH_IDS_LIMIT = 1000;

const LIST_GRAPH_IDS_OPERATION = "listGraphIds";

/** Options for {@link listGraphIds}. */
export type ListGraphIdsOptions = Readonly<{
  /** Only graph ids starting with this exact, case-sensitive prefix. */
  prefix?: string | undefined;
  /** Exclusive cursor: only graph ids ordered after this one. */
  after?: string | undefined;
  /** Page size, 1 to 1000. Defaults to 100. */
  limit?: number | undefined;
}>;

/** One relation and how many rows one graph holds in it. */
export type GraphStorageRelation = Readonly<{
  /**
   * The relation's logical key (`nodes`, `edges`, ...), or the vector
   * contribution's logical name (`vector:<Kind>.<field>`) for per-field
   * embedding storage.
   */
  relation: string;
  /** The physical table the relation resolved to on this backend. */
  table: string;
  rows: number;
}>;

/** Row counts for one graph across every relation that can hold its rows. */
export type GraphStorageInspection = Readonly<{
  graphId: string;
  relations: readonly GraphStorageRelation[];
  totalRows: number;
}>;

/** A relation to count: its identity and physical table, before counting. */
export type GraphStorageRelationTarget = Pick<
  GraphStorageRelation,
  "relation" | "table"
>;

type ReadTarget = GraphBackend | TransactionBackend;
type CountRow = Readonly<{ cnt: unknown }>;
type GraphIdRow = Readonly<{ graph_id: string }>;

function assertPageLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_GRAPH_IDS_LIMIT
  ) {
    throw new ConfigurationError(
      `Graph id inventory limit must be 1 to ${MAX_LIST_GRAPH_IDS_LIMIT}.`,
      { limit },
    );
  }
}

function safeCount(value: unknown, table: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ConfigurationError(
      "Graph storage inventory returned an invalid row count.",
      { table, value },
    );
  }
  return count;
}

async function existingTables(
  target: ReadTarget,
  tables: readonly string[],
  operation: string,
): Promise<ReadonlySet<string>> {
  const states = await requireCatalog(target, operation).tablesExist([
    ...new Set(tables),
  ]);
  return new Set(
    states.filter((state) => state.exists).map((state) => state.name),
  );
}

/**
 * Literal, case-sensitive prefix match. `LIKE` is case-insensitive on SQLite and
 * carries wildcards on both engines, so the id is cut to the prefix's own
 * length and compared as text. Both lengths are measured by the engine, in the
 * engine's own character unit, so they cannot disagree with each other.
 */
function prefixPredicate(prefix: string): SqlFragment {
  return sql`substr(${sql.identifier(GRAPH_ID_COLUMN)}, 1, length(CAST(${prefix} AS TEXT))) = CAST(${prefix} AS TEXT)`;
}

/** Everything that decides which graph ids one page lists. */
type GraphIdPage = Readonly<{ prefix: string; after: string; limit: number }>;

/**
 * How a walk is narrowed to one page. Both parts are only an optimization: the
 * page filter is applied over the walk's output either way, so a walk that is
 * not narrowed lists the same ids, only after visiting more of them.
 */
type GraphIdWalkBounds = Readonly<{
  /** Conditions on the first graph id visited. */
  seed: readonly SqlFragment[];
  /** Conditions under which the walk visits one more graph id. */
  continueWhile: readonly SqlFragment[];
}>;

const WALK_STEP_COLUMN = "step";

const UNBOUNDED_WALK: GraphIdWalkBounds = { seed: [], continueWhile: [] };

/**
 * Where a walk may start and stop for `page`. The walk visits ids in the order
 * the anchor indexes keep them, so it can start at the page's lower bound and
 * stop after the page (or the prefix) ends only where that order is the byte
 * order the page is defined in. Elsewhere the ids the page wants are scattered
 * through the walk, and the walk must visit all of them.
 *
 * The seed bound is inclusive so it is one range condition on the index however
 * the cursor and the prefix compare: the larger of the two, chosen by the
 * engine's own comparison. When it lands on the cursor itself, that id is the
 * one visit the page filter drops, so the walk is allowed one more step.
 */
function walkBounds(
  dialect: GraphBackend["dialect"],
  page: GraphIdPage,
): GraphIdWalkBounds {
  if (!getDialect(dialect).capabilities.textIndexOrderIsBinary)
    return UNBOUNDED_WALK;
  const graphId = sql.identifier(GRAPH_ID_COLUMN);
  const hasCursor = page.after !== "";
  const hasPrefix = page.prefix !== "";
  const lowerBound =
    hasCursor && hasPrefix ? sql`max(${page.after}, ${page.prefix})`
    : hasCursor ? sql`${page.after}`
    : sql`${page.prefix}`;
  const visits = page.limit + (hasCursor ? 1 : 0);
  return {
    seed: hasCursor || hasPrefix ? [sql`${graphId} >= ${lowerBound}`] : [],
    continueWhile: [
      sql`${sql.identifier(WALK_STEP_COLUMN)} < ${visits}`,
      ...(hasPrefix ? [prefixPredicate(page.prefix)] : []),
    ],
  };
}

/**
 * The next graph id across every anchor table that satisfies `conditions`: one
 * index seek per table on the table's own `graph_id`-leading primary key,
 * however many rows the table holds.
 */
function smallestGraphId(
  tables: readonly string[],
  conditions: readonly SqlFragment[],
): SqlFragment {
  const graphId = sql.identifier(GRAPH_ID_COLUMN);
  const where = [
    sql`${graphId} <> ${DEPLOYMENT_CONTRIBUTION_GRAPH_ID}`,
    ...conditions,
  ];
  const seeks = tables.map(
    (table) =>
      sql`SELECT min(${graphId}) AS next_graph_id FROM ${sql.identifier(table)} WHERE ${sql.join(where, sql` AND `)}`,
  );
  return sql`SELECT min(next_graph_id) FROM (${sql.join(seeks, sql` UNION ALL `)}) AS next_ids`;
}

/**
 * The `graph_ids` relation: every distinct graph id in the anchor tables, in
 * the columns' native order, without the reserved deployment marker id. Where
 * the engine recurses it is a loose index scan, a recursive CTE that steps from
 * one graph id to the next by index seek instead of reading every row, so its
 * cost is the number of graphs visited rather than the rows they hold. An
 * engine that declares no recursive traversal still lists graphs, from a
 * de-duplicating scan of the same columns, the way weighted shortest path falls
 * back to a predecessor walk.
 */
function distinctGraphIds(
  recursiveTraversal: RecursiveTraversalVerdict,
  tables: readonly string[],
  bounds: GraphIdWalkBounds,
): SqlFragment {
  const graphId = sql.identifier(GRAPH_ID_COLUMN);
  if (!recursiveTraversal.supported) {
    const scans = tables.map(
      (table) =>
        sql`SELECT ${graphId} FROM ${sql.identifier(table)} WHERE ${graphId} <> ${DEPLOYMENT_CONTRIBUTION_GRAPH_ID}`,
    );
    return sql`WITH graph_ids(${graphId}) AS (${sql.join(scans, sql` UNION `)})`;
  }
  const step = sql.identifier(WALK_STEP_COLUMN);
  return sql`
    WITH RECURSIVE graph_ids(${graphId}, ${step}) AS (
      SELECT (${smallestGraphId(tables, bounds.seed)}), 1
      UNION ALL
      SELECT (${smallestGraphId(tables, [sql`${graphId} > graph_ids.${graphId}`])}), graph_ids.${step} + 1
      FROM graph_ids
      WHERE ${sql.join([sql`graph_ids.${graphId} IS NOT NULL`, ...bounds.continueWhile], sql` AND `)}
    )
  `;
}

/**
 * The statement behind one {@link listGraphIds} page: the distinct graph ids,
 * then the cursor, prefix and page size applied in byte order over them. The
 * same statement runs on every dialect; what differs is how far the walk may be
 * narrowed (see {@link walkBounds}) and the byte-order collation, which the
 * dialect adapter owns.
 */
function listGraphIdsQuery(
  dialect: GraphBackend["dialect"],
  recursiveTraversal: RecursiveTraversalVerdict,
  tables: readonly string[],
  page: GraphIdPage,
): SqlFragment {
  const graphId = sql.identifier(GRAPH_ID_COLUMN);
  // The dialect's own owner of "compare text by bytes": PostgreSQL would
  // otherwise order and page by the database collation, and two databases
  // would disagree about where a mixed-case id sorts.
  const byteOrdered = getDialect(dialect).binaryText(graphId);
  const conditions = [
    sql`${graphId} IS NOT NULL`,
    ...(page.after === "" ? [] : [sql`${byteOrdered} > ${page.after}`]),
    ...(page.prefix === "" ? [] : [prefixPredicate(page.prefix)]),
  ];
  return sql`
    ${distinctGraphIds(recursiveTraversal, tables, walkBounds(dialect, page))}
    SELECT ${graphId}
    FROM graph_ids
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY ${byteOrdered}
    LIMIT ${page.limit}
  `;
}

/**
 * The graph ids that hold data, in byte order, one bounded page at a time. A
 * graph is listed while it has nodes, edges, or a committed schema version:
 * exactly the relations a default `store.clear()` empties, so a cleared graph
 * is no longer listed even though graph-local contribution markers survive the
 * clear. Rows that exist only in other relations (a stray revision-journal
 * row, contribution markers) do not list a graph; `inspectGraphStorage` counts
 * every relation and shows them.
 *
 * The order is the same on every backend: byte order of the UTF-8 id (code
 * point order), so `B` sorts before `a` on SQLite and PostgreSQL alike, and a
 * cursor taken from the last id of one page resumes exactly after it. The
 * reserved deployment graph id that marks deployment-scoped contributions is
 * never listed: it is an internal marker, not a graph.
 *
 * Per-`(kind, field)` vector tables are keyed by graph id in their names and
 * are not enumerable without one; a graph with vector rows has node rows too.
 * Use `inspectGraphStorage` to see everything one graph holds.
 *
 * Cost: a page walks graph ids by index seek (one seek per graph per anchor
 * table, on the `graph_id`-leading primary keys), never by reading the rows
 * those graphs hold. Where the engine keeps text indexes in byte order (SQLite)
 * the walk starts at the cursor or prefix and stops after the page, so a page
 * costs about `limit` seeks wherever it sits. Where it does not (PostgreSQL
 * orders those indexes by the database collation, so byte-order bounds are not
 * index ranges) the walk visits every graph, so a page costs one seek per graph
 * in the database. A backend that declares no recursive traversal reads and
 * de-duplicates every anchor row instead. It is an operator read, not a
 * hot-path lookup.
 *
 * ```typescript
 * let after: string | undefined;
 * for (;;) {
 *   const page = await listGraphIds(backend, { prefix: "tenant-", after });
 *   if (page.length === 0) break;
 *   for (const graphId of page) console.log(graphId);
 *   after = page.at(-1);
 * }
 * ```
 *
 * @throws ConfigurationError when `limit` is not an integer from 1 to 1000, or
 *   when the backend exposes no catalog probes to tell provisioned relations
 *   from lazily-provisioned ones that do not exist yet.
 */
export async function listGraphIds(
  backend: GraphBackend,
  options: ListGraphIdsOptions = {},
): Promise<readonly string[]> {
  const limit = options.limit ?? DEFAULT_LIST_GRAPH_IDS_LIMIT;
  assertPageLimit(limit);
  const names = graphRelationNames(backend);
  const relationTables = GRAPH_PRESENCE_ANCHOR_KEYS.map((key) => names[key]);

  return runOptionallyInTransaction(
    backend,
    async (target) => {
      const present = await existingTables(
        target,
        relationTables,
        LIST_GRAPH_IDS_OPERATION,
      );
      const tables = [...new Set(relationTables)].filter((table) =>
        present.has(table),
      );
      if (tables.length === 0) return [];
      const rows = await target.execute<GraphIdRow>(
        asCompiledRowsSql(
          listGraphIdsQuery(
            target.dialect,
            resolveRecursiveTraversal(target.capabilities),
            tables,
            {
              prefix: options.prefix ?? "",
              after: options.after ?? "",
              limit,
            },
          ),
        ),
      );
      return rows.map((row) => row.graph_id);
    },
    { transaction: { accessMode: "read_only" } },
  );
}

function graphRelationNames(
  backend: Pick<GraphBackend, "tableNames">,
): GraphRelationNames {
  return resolveGraphRelationNames(backend.tableNames);
}

/**
 * The inventory relations, under `backend`'s physical names, that
 * {@link countGraphStorage} counts for every graph.
 */
export function inventoryRelationTargets(
  backend: Pick<GraphBackend, "tableNames">,
): readonly GraphStorageRelationTarget[] {
  const names = graphRelationNames(backend);
  return GRAPH_RELATIONS.map((relation) => ({
    relation: relation.key,
    table: names[relation.key],
  }));
}

/**
 * Counts one graph's rows in each of `relations` inside one read-only
 * transaction where the backend has them, so the counts describe one snapshot.
 * A relation whose table does not exist counts as zero.
 */
export async function countGraphStorage(
  backend: GraphBackend,
  graphId: string,
  relations: readonly GraphStorageRelationTarget[],
  operation: string,
): Promise<GraphStorageInspection> {
  return runOptionallyInTransaction(
    backend,
    async (target) => {
      const present = await existingTables(
        target,
        relations.map((relation) => relation.table),
        operation,
      );
      const counted: GraphStorageRelation[] = [];
      for (const { relation, table } of relations) {
        const rows =
          present.has(table) ? await countRows(target, table, graphId) : 0;
        counted.push({ relation, table, rows });
      }
      return {
        graphId,
        relations: counted,
        totalRows: counted.reduce((total, entry) => total + entry.rows, 0),
      };
    },
    { transaction: { accessMode: "read_only" } },
  );
}

async function countRows(
  target: ReadTarget,
  table: string,
  graphId: string,
): Promise<number> {
  const rows = await target.execute<CountRow>(
    asCompiledRowsSql(
      sql`SELECT COUNT(*) AS cnt FROM ${sql.identifier(table)} WHERE ${sql.identifier(GRAPH_ID_COLUMN)} = ${graphId}`,
    ),
  );
  return safeCount(rows[0]?.cnt, table);
}
