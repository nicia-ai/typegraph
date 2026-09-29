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
import { graphIdOrderIndexName } from "../indexes/system";
import { getDialect } from "../query/dialect";
import { type DialectAdapter } from "../query/dialect/types";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { requireCatalog } from "./capabilities/catalog";
import { resolveRecursiveTraversal } from "./capabilities/recursive-traversal";
import { normalizeGraphCommandIsolation } from "./command-contract";
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
  type GraphCommandIsolation,
  type OptionalTransactionExecution,
  runOptionallyInTransaction,
  type TransactionBackend,
  type TransactionOptions,
} from "./types";

/** Page size when {@link ListGraphIdsOptions.limit} is omitted. */
const DEFAULT_LIST_GRAPH_IDS_LIMIT = 100;

/** Largest page {@link listGraphIds} returns. */
const MAX_LIST_GRAPH_IDS_LIMIT = 1000;

const LIST_GRAPH_IDS_OPERATION = "listGraphIds";

/**
 * The transaction {@link countGraphStorage} asks for: one snapshot for every
 * count, and no writes. A request only: the backend may not honor the
 * isolation level, so the counts report what the session actually ran under.
 */
const STORAGE_COUNT_TRANSACTION = {
  isolationLevel: "repeatable_read",
  accessMode: "read_only",
} as const satisfies TransactionOptions;

const SESSION_ISOLATION_COLUMN = "transaction_isolation";

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

/**
 * How far the counts of one {@link GraphStorageInspection} agree with each
 * other:
 *
 * - `snapshot`: every count read the same snapshot of the database, so the
 *   relations and `totalRows` describe one state that existed. Reported only
 *   when the counting session proved it: a SQLite transaction, or a PostgreSQL
 *   transaction observed running at `repeatable read` or `serializable`.
 * - `per-statement`: each relation was counted by its own statement and a
 *   concurrent write may fall between two of them, so the counts can describe
 *   a state that never existed together. It is what a backend with no
 *   interactive transactions, or a transaction whose session runs at `read
 *   committed` (a wrapper dropped the requested isolation level under a
 *   `read committed` default), yields. Quiesce writers before reading such counts as one state, or read
 *   them again and compare.
 */
export type GraphStorageConsistency = "snapshot" | "per-statement";

/** Row counts for one graph across every relation that can hold its rows. */
export type GraphStorageInspection = Readonly<{
  graphId: string;
  relations: readonly GraphStorageRelation[];
  totalRows: number;
  /** Whether the counts share one snapshot; see {@link GraphStorageConsistency}. */
  consistency: GraphStorageConsistency;
}>;

/** A relation to count: its identity and physical table, before counting. */
export type GraphStorageRelationTarget = Pick<
  GraphStorageRelation,
  "relation" | "table"
>;

type ReadTarget = GraphBackend | TransactionBackend;
type CountRow = Readonly<{ cnt: unknown; transaction_isolation?: unknown }>;
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
 * How the distinct graph ids are read. A `walk` steps from one graph id to the
 * next by index seek, so its cost is the number of graph ids it visits and the
 * page bounds below narrow it to the page. A `scan` reads and de-duplicates
 * every anchor row, whatever the page.
 */
type GraphIdRead = "walk" | "scan";

/**
 * Where a walk starts and how long it runs. Both only narrow the walk: the page
 * filter is applied over its output either way.
 */
type GraphIdWalkBounds = Readonly<{
  /** Conditions on the first graph id visited. */
  seed: readonly SqlFragment[];
  /** Conditions under which the walk visits one more graph id. */
  continueWhile: readonly SqlFragment[];
}>;

const WALK_STEP_COLUMN = "step";

/**
 * Where a walk may start and stop for `page`. The walk visits ids in byte order
 * (see {@link byteOrderedWalkAvailable}, which is what allows a walk at all), so
 * it can start at the page's lower bound and stop after the page, or the
 * prefix, ends.
 *
 * The seed bound is inclusive so it is one range condition on the index however
 * the cursor and the prefix compare: the larger of the two, chosen by the
 * dialect's own byte-order comparison. When it lands on the cursor itself, that
 * id is the one visit the page filter drops, so the walk is allowed one more
 * step.
 */
function walkBounds(
  dialect: DialectAdapter,
  page: GraphIdPage,
): GraphIdWalkBounds {
  const graphId = sql.identifier(GRAPH_ID_COLUMN);
  const hasCursor = page.after !== "";
  const hasPrefix = page.prefix !== "";
  const cursor = sql`CAST(${page.after} AS TEXT)`;
  const prefix = sql`CAST(${page.prefix} AS TEXT)`;
  const lowerBound =
    hasCursor && hasPrefix ?
      sql`CASE WHEN ${dialect.binaryText(cursor)} > ${prefix} THEN ${cursor} ELSE ${prefix} END`
    : hasCursor ? cursor
    : prefix;
  const visits = page.limit + (hasCursor ? 1 : 0);
  return {
    seed:
      hasCursor || hasPrefix ?
        [sql`${dialect.binaryText(graphId)} >= ${lowerBound}`]
      : [],
    continueWhile: [
      sql`${sql.identifier(WALK_STEP_COLUMN)} < ${visits}`,
      ...(hasPrefix ? [prefixPredicate(page.prefix)] : []),
    ],
  };
}

/**
 * The next graph id across every anchor table that satisfies `conditions`: one
 * index seek per table, in byte order, on the table's `graph_id` index however
 * many rows the table holds.
 */
function smallestGraphId(
  dialect: DialectAdapter,
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
      sql`SELECT min(${dialect.binaryText(graphId)}) AS next_graph_id FROM ${sql.identifier(table)} WHERE ${sql.join(where, sql` AND `)}`,
  );
  return sql`SELECT min(next_graph_id) FROM (${sql.join(seeks, sql` UNION ALL `)}) AS next_ids`;
}

/**
 * The `graph_ids` relation: every distinct graph id in the anchor tables,
 * without the reserved deployment marker id. As a `walk` it is a loose index
 * scan, a recursive CTE that steps from one graph id to the next by index seek
 * instead of reading every row, so its cost is the number of graphs visited
 * rather than the rows they hold. As a `scan` it is a de-duplicating read of
 * the same columns, the way weighted shortest path falls back to a predecessor
 * walk where the engine declines recursion.
 */
function distinctGraphIds(
  dialect: DialectAdapter,
  read: GraphIdRead,
  tables: readonly string[],
  page: GraphIdPage,
): SqlFragment {
  const graphId = sql.identifier(GRAPH_ID_COLUMN);
  if (read === "scan") {
    const scans = tables.map(
      (table) =>
        sql`SELECT ${graphId} FROM ${sql.identifier(table)} WHERE ${graphId} <> ${DEPLOYMENT_CONTRIBUTION_GRAPH_ID}`,
    );
    return sql`WITH graph_ids(${graphId}) AS (${sql.join(scans, sql` UNION `)})`;
  }
  const bounds = walkBounds(dialect, page);
  const step = sql.identifier(WALK_STEP_COLUMN);
  return sql`
    WITH RECURSIVE graph_ids(${graphId}, ${step}) AS (
      SELECT (${smallestGraphId(dialect, tables, bounds.seed)}), 1
      UNION ALL
      SELECT (${smallestGraphId(dialect, tables, [sql`${dialect.binaryText(graphId)} > graph_ids.${graphId}`])}), graph_ids.${step} + 1
      FROM graph_ids
      WHERE ${sql.join([sql`graph_ids.${graphId} IS NOT NULL`, ...bounds.continueWhile], sql` AND `)}
    )
  `;
}

/**
 * The statement behind one {@link listGraphIds} page: the distinct graph ids,
 * then the cursor, prefix and page size applied in byte order over them. The
 * same statement shape runs on every dialect; the byte-order collation is the
 * dialect adapter's.
 */
function listGraphIdsQuery(
  dialect: DialectAdapter,
  read: GraphIdRead,
  tables: readonly string[],
  page: GraphIdPage,
): SqlFragment {
  const graphId = sql.identifier(GRAPH_ID_COLUMN);
  // The dialect's own owner of "compare text by bytes": PostgreSQL would
  // otherwise order and page by the database collation, and two databases
  // would disagree about where a mixed-case id sorts.
  const byteOrdered = dialect.binaryText(graphId);
  const conditions = [
    sql`${graphId} IS NOT NULL`,
    ...(page.after === "" ? [] : [sql`${byteOrdered} > ${page.after}`]),
    ...(page.prefix === "" ? [] : [prefixPredicate(page.prefix)]),
  ];
  return sql`
    ${distinctGraphIds(dialect, read, tables, page)}
    SELECT ${graphId}
    FROM graph_ids
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY ${byteOrdered}
    LIMIT ${page.limit}
  `;
}

/**
 * Whether `tables` can be walked in byte order by index seek. SQLite keeps every
 * text index in byte order, so its `graph_id`-leading primary keys serve the
 * walk. PostgreSQL orders text indexes by the database collation, so the walk
 * needs the byte-ordered `graph_id` index the base schema adopts on each anchor
 * table (`graphIdOrderIndexName`). That is read from the catalog rather than
 * assumed: a database whose base schema is not current yet, a schema managed by
 * hand, or an index an operator dropped, is still listed correctly, by the
 * de-duplicating scan, instead of by a walk whose every step would scan a table.
 *
 * The probe reads the index's name and validity only, through the shared
 * `indexStates` catalog member, not its definition. The names are reserved
 * system index names, so a same-named index that is not `graph_id COLLATE "C"`
 * (one created by hand under a reserved name) would be trusted and make the
 * walk slow, never wrong: results stay in byte order because the walk's
 * ordering and bounds are computed by the query, not read from the index.
 */
async function byteOrderedWalkAvailable(
  target: ReadTarget,
  dialect: DialectAdapter,
  tables: readonly string[],
): Promise<boolean> {
  if (dialect.capabilities.textIndexOrderIsBinary) return true;
  const states = await requireCatalog(
    target,
    LIST_GRAPH_IDS_OPERATION,
  ).indexStates(tables.map((table) => graphIdOrderIndexName(table)));
  return states.every((state) => state.exists && !state.invalid);
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
 * Cost: a page walks graph ids by index seek in byte order (one seek per graph
 * per anchor table), never by reading the rows those graphs hold. The walk
 * starts at the cursor or prefix and stops after the page, so a page costs about
 * `limit` seeks wherever it sits and however many graphs the database holds.
 * SQLite serves the seeks from the `graph_id`-leading primary keys. PostgreSQL
 * orders those by the database collation, so it serves them from the
 * byte-ordered `graph_id` index the base schema adds to each anchor table
 * (`COLLATE "C"`, adopted at base-schema version 5). Where that index is absent,
 * or the backend declares no recursive traversal, the page reads and
 * de-duplicates every anchor row instead: the same ids, at a cost that grows
 * with the rows the graphs hold. It is an operator read, not a hot-path lookup.
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
      const dialect = getDialect(target.dialect);
      const walkable =
        resolveRecursiveTraversal(target.capabilities).supported &&
        (await byteOrderedWalkAvailable(target, dialect, tables));
      const rows = await target.execute<GraphIdRow>(
        asCompiledRowsSql(
          listGraphIdsQuery(dialect, walkable ? "walk" : "scan", tables, {
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
 * The session fact that decides whether `target`'s reads share one snapshot,
 * as an expression to fold into a count statement. Absent when no evidence is
 * needed (no transaction to ask about, or a dialect whose transactions are
 * snapshots by construction) or none can be produced (a backend that declares
 * no session isolation read), where the counts are reported per statement.
 */
function sessionIsolationExpression(
  target: ReadTarget,
  dialect: DialectAdapter,
  execution: OptionalTransactionExecution,
): SqlFragment | undefined {
  if (execution.mode !== "interactive-transaction") return undefined;
  if (dialect.capabilities.transactionReadsShareOneSnapshot) return undefined;
  return target.fenceSql?.isolationFactExpression?.();
}

/** What the counting session showed about the snapshot its reads shared. */
type SnapshotEvidence = Readonly<{
  execution: OptionalTransactionExecution;
  dialect: DialectAdapter;
  countStatements: number;
  observedIsolation: GraphCommandIsolation | undefined;
}>;

/**
 * THE decision behind {@link GraphStorageInspection.consistency}. Fewer than
 * two count statements cannot disagree with each other; otherwise one snapshot
 * needs an interactive transaction that either the dialect guarantees or the
 * session was observed to run at a snapshot isolation level. A requested level
 * is never evidence.
 */
function storageConsistency(
  evidence: SnapshotEvidence,
): GraphStorageConsistency {
  if (evidence.countStatements < 2) return "snapshot";
  if (evidence.execution.mode !== "interactive-transaction") {
    return "per-statement";
  }
  if (evidence.dialect.capabilities.transactionReadsShareOneSnapshot) {
    return "snapshot";
  }
  return (
      evidence.observedIsolation === "repeatable_read" ||
        evidence.observedIsolation === "serializable"
    ) ?
      "snapshot"
    : "per-statement";
}

/**
 * Counts one graph's rows in each of `relations` inside one read-only
 * transaction requested at `repeatable read`, where the backend has
 * transactions. A relation whose table does not exist counts as zero.
 *
 * The result says whether the counts share one snapshot rather than promising
 * it: the effective isolation level is read on the counting session, folded
 * into the first count statement, because a backend or wrapper may not honor
 * the request.
 */
export async function countGraphStorage(
  backend: GraphBackend,
  graphId: string,
  relations: readonly GraphStorageRelationTarget[],
  operation: string,
): Promise<GraphStorageInspection> {
  return runOptionallyInTransaction(
    backend,
    async (target, execution) => {
      const present = await existingTables(
        target,
        relations.map((relation) => relation.table),
        operation,
      );
      const dialect = getDialect(target.dialect);
      const isolationExpression = sessionIsolationExpression(
        target,
        dialect,
        execution,
      );
      const counted: GraphStorageRelation[] = [];
      let countStatements = 0;
      let observedIsolation: GraphCommandIsolation | undefined;
      for (const { relation, table } of relations) {
        if (!present.has(table)) {
          counted.push({ relation, table, rows: 0 });
          continue;
        }
        const read = await countRows(
          target,
          table,
          graphId,
          countStatements === 0 ? isolationExpression : undefined,
        );
        countStatements += 1;
        observedIsolation ??= read.isolation;
        counted.push({ relation, table, rows: read.rows });
      }
      return {
        graphId,
        relations: counted,
        totalRows: counted.reduce((total, entry) => total + entry.rows, 0),
        consistency: storageConsistency({
          execution,
          dialect,
          countStatements,
          observedIsolation,
        }),
      };
    },
    { transaction: STORAGE_COUNT_TRANSACTION },
  );
}

async function countRows(
  target: ReadTarget,
  table: string,
  graphId: string,
  isolationExpression: SqlFragment | undefined,
): Promise<
  Readonly<{ rows: number; isolation: GraphCommandIsolation | undefined }>
> {
  const isolationColumn =
    isolationExpression === undefined ?
      sql``
    : sql`, ${isolationExpression} AS ${sql.identifier(SESSION_ISOLATION_COLUMN)}`;
  const [row] = await target.execute<CountRow>(
    asCompiledRowsSql(
      sql`SELECT COUNT(*) AS cnt${isolationColumn} FROM ${sql.identifier(table)} WHERE ${sql.identifier(GRAPH_ID_COLUMN)} = ${graphId}`,
    ),
  );
  return {
    rows: safeCount(row?.cnt, table),
    isolation:
      isolationExpression === undefined ? undefined : (
        normalizeGraphCommandIsolation(row?.[SESSION_ISOLATION_COLUMN])
      ),
  };
}
