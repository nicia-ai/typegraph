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
  GRAPH_ID_COLUMN,
  GRAPH_RELATIONS,
  type GraphRelationKey,
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

/**
 * The relations a graph id is listed from. Every graph that holds data has a
 * committed schema version, nodes or edges, so these anchor a graph's presence
 * without reading the recorded history and the revision journal, which are the
 * largest relations and only ever hold rows for a graph these already list.
 * `inspectGraphStorage` still counts every relation, so rows orphaned outside
 * these anchors are visible there.
 */
const LISTING_RELATION_KEYS = [
  "nodes",
  "edges",
  "schemaVersions",
  "contributionMaterializations",
] as const satisfies readonly GraphRelationKey[];

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

function listGraphIdsQuery(
  dialect: GraphBackend["dialect"],
  tables: readonly string[],
  options: Readonly<{ prefix: string; after: string; limit: number }>,
): SqlFragment {
  const graphId = sql.identifier(GRAPH_ID_COLUMN);
  // The dialect's own owner of "compare text by bytes": PostgreSQL would
  // otherwise order and page by the database collation, and two databases
  // would disagree about where a mixed-case id sorts.
  const byteOrdered = getDialect(dialect).binaryText(graphId);
  const branches = tables.map(
    (table) => sql`SELECT ${graphId} FROM ${sql.identifier(table)}`,
  );
  const conditions = [
    sql`${graphId} <> ${DEPLOYMENT_CONTRIBUTION_GRAPH_ID}`,
    ...(options.after === "" ? [] : [sql`${byteOrdered} > ${options.after}`]),
    ...(options.prefix === "" ? [] : [prefixPredicate(options.prefix)]),
  ];
  return sql`
    SELECT ${graphId}
    FROM (${sql.join(branches, sql` UNION `)}) AS graph_ids
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY ${byteOrdered}
    LIMIT ${options.limit}
  `;
}

/**
 * The graph ids that hold data, in byte order, one bounded page at a time. A
 * graph is listed while it has nodes, edges, a committed schema version, or
 * graph-local contribution markers.
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
 * Cost: a page is small, but the query behind it is not. Every call reads the
 * `graph_id` column of the listed relations and de-duplicates it before the
 * cursor and prefix apply, so the work grows with the rows in those relations,
 * not with the page size. It is an operator read, not a hot-path lookup.
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
  const relationTables = LISTING_RELATION_KEYS.map((key) => names[key]);

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
          listGraphIdsQuery(target.dialect, tables, {
            prefix: options.prefix ?? "",
            after: options.after ?? "",
            limit,
          }),
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
