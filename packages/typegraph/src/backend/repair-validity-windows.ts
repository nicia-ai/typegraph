/**
 * Offline repair for validity windows that older library versions stored
 * inverted (`valid_from > valid_to`).
 *
 * Such a row is readable at no coordinate at all: `asOf(t)` needs
 * `valid_from <= t < valid_to`, and no `t` satisfies both when the bounds are
 * backwards. The library no longer mints them — a write that stamps a lower
 * bound the caller did not state stores no bound rather than an inverting one —
 * but deploying that fix rewrites nothing, so rows written by an older version
 * (or by direct SQL) stay invisible until an operator repairs them.
 *
 * The repair normalizes those rows to "ended at T, start unknown"
 * (`valid_from = NULL`), which is the shape the current write paths store. It
 * deliberately does **not** bump `version`, touch `updated_at`, or mint a
 * recorded revision: it normalizes a storage convention for rows that were
 * never observable at any coordinate, so it is not a logical write — and
 * minting a revision would make the pre-repair recorded state re-materialize
 * the inverted shape at `asOfRecorded` coordinates.
 *
 * Operator consequences, all of them stated in the docs as well:
 *
 * 1. **Run `"apply"` with writers stopped.** A concurrent window-bearing update
 *    may fence its write on the validity lower bound it read, so a repair that
 *    lands in between can make the peer's first `UPDATE` match no row. Store
 *    node/edge updates re-read and re-judge against the repaired bound; an
 *    interchange update records a per-row target-changed error instead of
 *    claiming the row was written. `"report"` needs no quiescing — it scans in
 *    a read-only transaction, so it cannot write.
 * 2. **Repaired rows become visible** at `asOf` coordinates before their end.
 *    That is the point, and it is a read-visibility change to historical
 *    queries.
 * 3. **Outstanding `base@V` merge tokens are invalidated** for repaired rows —
 *    `valid_from` is part of the base content fingerprint. Quiesce merges,
 *    repair, then re-baseline branches.
 * 4. **Prefer `relations: "live-and-recorded"`.** Repairing only the live axis
 *    leaves the recorded twin carrying the inverted window, which
 *    re-materializes the invisible row at any `asOfRecorded` coordinate.
 */
import { ConfigurationError } from "../errors";
import type {
  ResolvedSqlTableNames,
  SqlTableNames,
} from "../query/compiler/schema";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql, asCompiledStatementSql } from "../query/sql-intent";
import { statementExecutionMembers } from "./capabilities/bind";
import type { STATEMENT_EXECUTION } from "./capabilities/bundle-registry";
import {
  type BundleVerdictOf,
  statementExecutionVerdict,
} from "./capabilities/resolve";
import { resolvedTableNames } from "./table-names";
import {
  type GraphBackend,
  runOptionallyInTransaction,
  type RunOptionallyInTransactionOptions,
  type TransactionBackend,
} from "./types";

/** A relation whose rows carry a validity window this repair can normalize. */
export type RepairRelation =
  "nodes" | "edges" | "recordedNodes" | "recordedEdges";

/**
 * Which relations one call scans.
 *
 * `"live-and-recorded"` is the recommended scope. `"live"` is correct in
 * exactly two cases: the store captures no history and the `recorded_*` tables
 * do not exist, or the operator is deliberately preserving the recorded axis as
 * an audit record of what was stored before the repair — and accepts that
 * historical `asOfRecorded` reads keep returning the invisible shape.
 */
export type RepairRelationScope = "live" | "live-and-recorded";

/** Inputs for detecting or repairing legacy inverted validity windows. */
export type RepairInvertedWindowsOptions = Readonly<{
  backend: GraphBackend;
  /** Omit to sweep every graph in the database. */
  graphId?: string | undefined;
  /** Required: the scope is a decision, not a default. */
  relations: RepairRelationScope;
  /**
   * `"report"` counts and writes nothing; `"apply"` counts and then normalizes
   * the rows it counted.
   */
  mode: "report" | "apply";
  /**
   * Patch selected backend table names, exactly as migrate-recorded-time does.
   * Unstated names continue to come from `backend.tableNames`; see
   * {@link resolvedTableNames}.
   */
  tableNames?: Partial<SqlTableNames> | undefined;
}>;

/** Counts and execution guarantees observed by one repair/report call. */
export type RepairInvertedWindowsReport = Readonly<{
  /** Echoes the scope actually scanned — a count of 0 and "not scanned" are different facts. */
  relations: RepairRelationScope;
  /**
   * Rows whose stored window is inverted: found in `"report"` mode, repaired in
   * `"apply"` mode. `undefined` means NOT SCANNED, never "clean".
   */
  counts: Readonly<Record<RepairRelation, number | undefined>>;
  /**
   * Rows whose stored bounds are not canonical ISO and were therefore not
   * classified. SQLite only in substance: on PostgreSQL the columns are
   * `timestamptz`, so a scanned relation always reports `0` (never `undefined`
   * — that value is reserved for "not scanned", on both dialects).
   *
   * `"apply"` refuses while any scanned relation reports a non-zero count:
   * classifying those rows needs a timestamp semantics this repair does not
   * own, and skipping them silently would be an accepted option ignored.
   */
  nonCanonical: Readonly<Record<RepairRelation, number | undefined>>;
  /**
   * Whether every statement of this call ran in ONE transaction. `false` on a
   * backend that reports `capabilities.execution.interactiveTransactions === false`, where the call
   * degrades to per-relation statements.
   *
   * Reported by the seam, not inferred from backend object identity:
   * {@link runOptionallyInTransaction} explicitly tells its callback whether it
   * opened a transaction. "One snapshot" and "four snapshots" are different
   * facts about a report, and the report must state which occurred even when a
   * custom backend passes the same object into its transaction callback.
   *
   * When `false`, a `"report"`'s counts may come from different snapshots and a
   * crash mid-`"apply"` can leave the live axis repaired and the recorded axis
   * not. Both are survivable the same way: each relation's statement is
   * idempotent and convergent, so a re-run finishes the job and a later
   * `"report"` proves it.
   */
  atomic: boolean;
}>;

const LIVE_RELATIONS = [
  "nodes",
  "edges",
] as const satisfies readonly RepairRelation[];

const RECORDED_RELATIONS = [
  "recordedNodes",
  "recordedEdges",
] as const satisfies readonly RepairRelation[];

/**
 * Canonical fixed-width UTC ISO 8601, as a SQLite `GLOB` pattern.
 *
 * SQLite stores the bounds as `TEXT` and compares them lexicographically, which
 * equals chronological order only for canonical values. This repair exists to
 * clean up rows written by older paths and by direct SQL, so it cannot assume
 * canonicality — it establishes it per row instead.
 */
const CANONICAL_INSTANT_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z";

type RepairTarget = GraphBackend | TransactionBackend;

type CountRow = Readonly<{ matches: unknown }>;

function scopedRelations(
  scope: RepairRelationScope,
): readonly RepairRelation[] {
  return scope === "live" ? LIVE_RELATIONS : (
      [...LIVE_RELATIONS, ...RECORDED_RELATIONS]
    );
}

function relationTable(
  tables: ResolvedSqlTableNames,
  relation: RepairRelation,
): string {
  switch (relation) {
    case "nodes": {
      return tables.nodes;
    }
    case "edges": {
      return tables.edges;
    }
    case "recordedNodes": {
      return tables.recordedNodes;
    }
    case "recordedEdges": {
      return tables.recordedEdges;
    }
  }
}

function graphScopeClauses(
  graphId: string | undefined,
): readonly SqlFragment[] {
  return graphId === undefined ? [] : [sql`graph_id = ${graphId}`];
}

function canonicalBoundsClauses(
  dialect: GraphBackend["dialect"],
): readonly SqlFragment[] {
  if (dialect !== "sqlite") return [];
  return [
    sql`valid_from GLOB ${CANONICAL_INSTANT_GLOB}`,
    sql`valid_to GLOB ${CANONICAL_INSTANT_GLOB}`,
  ];
}

/**
 * The one spelling of "this stored window is inverted".
 *
 * Both modes compile it: `"report"` into `SELECT COUNT(*) … WHERE <this>` and
 * `"apply"` into `UPDATE … SET valid_from = NULL WHERE <this>`, so the count
 * and the repair cannot disagree about which rows are in scope.
 *
 * The comparison is strict (`>`). A stored zero-width window is a legal shape a
 * caller may have stated in full, and this repair does not second-guess it.
 */
export function invertedValidityWindowPredicate(
  options: Readonly<{
    dialect: GraphBackend["dialect"];
    graphId?: string | undefined;
  }>,
): SqlFragment {
  return sql.join(
    [
      sql`valid_from IS NOT NULL`,
      sql`valid_to IS NOT NULL`,
      ...canonicalBoundsClauses(options.dialect),
      sql`valid_from > valid_to`,
      ...graphScopeClauses(options.graphId),
    ],
    sql` AND `,
  );
}

/**
 * Rows carrying both bounds where either one is not canonical, and which the
 * inverted predicate therefore refuses to classify. SQLite only: PostgreSQL
 * stores `timestamptz`, where every stored value compares chronologically.
 */
function nonCanonicalWindowPredicate(graphId: string | undefined): SqlFragment {
  return sql.join(
    [
      sql`valid_from IS NOT NULL`,
      sql`valid_to IS NOT NULL`,
      sql`(valid_from NOT GLOB ${CANONICAL_INSTANT_GLOB} OR valid_to NOT GLOB ${CANONICAL_INSTANT_GLOB})`,
      ...graphScopeClauses(graphId),
    ],
    sql` AND `,
  );
}

function safeCount(value: unknown, table: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ConfigurationError(
      "Validity-window repair returned an invalid row count.",
      { table, value },
    );
  }
  return count;
}

async function countMatching(
  target: RepairTarget,
  table: string,
  predicate: SqlFragment,
): Promise<number> {
  const rows = await target.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS matches
      FROM ${sql.identifier(table)}
      WHERE ${predicate}
    `),
  );
  return safeCount(rows[0]?.matches, table);
}

/**
 * `"apply"` writes, so it needs the optional non-row-returning statement path.
 * `"report"` deliberately does not: `execute` is a required member, so
 * detection stays available on every backend even where repair is not.
 *
 * Shared by both throw sites below: the public entry refuses BEFORE opening a
 * transaction (so an unsupported backend never pays for one), and
 * {@link repairRelation}'s own guard exists ONLY because a nested closure
 * cannot inherit the entry's narrowing of `verdict` to `{ supported: true }` —
 * it can never fire at runtime, since the entry already refused. One message,
 * two structurally-required call sites.
 */
function statementExecutionRequiredError(
  dialect: GraphBackend["dialect"],
): ConfigurationError {
  return new ConfigurationError(
    "Repairing inverted validity windows requires executeStatement support.",
    { dialect, mode: "apply" },
    {
      suggestion:
        'Use a built-in SQLite or PostgreSQL backend to apply the repair. Detection needs no such support: call this with mode: "report" to count the affected rows on any backend.',
    },
  );
}

/**
 * Translates the recorded-capture wrapper's refusal instead of swallowing it.
 *
 * A history-enabled store replaces `executeStatement` with a rejecting stub, so
 * `"apply"` against that backend fails with a message about raw SQL rather than
 * about this repair. The remedy is specific enough to be worth naming: hand the
 * repair the raw backend the history store was constructed from. Bypassing
 * capture is the intended behavior here, not a workaround — the repair mints no
 * revision by design.
 */
function translatedCaptureRefusal(error: unknown): unknown {
  if (
    !(error instanceof ConfigurationError) ||
    error.details["code"] !== "RECORDED_CAPTURE_RAW_SQL_DISABLED"
  ) {
    return error;
  }
  return new ConfigurationError(
    "Repairing inverted validity windows cannot run against a history-capturing backend.",
    { code: "RECORDED_CAPTURE_RAW_SQL_DISABLED", mode: "apply" },
    {
      cause: error,
      suggestion:
        'Pass the raw backend you constructed the history store from. The repair deliberately mints no revision — it normalizes storage for rows that were never visible at any coordinate — so bypassing recorded-time capture is the intended behavior, not a workaround. mode: "report" needs no such care: it runs against the capture-wrapped backend.',
    },
  );
}

async function repairRelation(
  target: RepairTarget,
  verdict: BundleVerdictOf<typeof STATEMENT_EXECUTION>,
  table: string,
  predicate: SqlFragment,
): Promise<void> {
  // Unreachable at runtime: `repairInvertedValidityWindows` already refused an
  // unsupported backend before opening the transaction this runs inside. The
  // check exists only so `verdict` narrows for `statementExecutionMembers` —
  // TypeScript does not carry the entry's narrowing into this closure.
  if (!verdict.supported) {
    throw statementExecutionRequiredError(target.dialect);
  }
  try {
    await statementExecutionMembers(target, verdict).executeStatement(
      asCompiledStatementSql(sql`
        UPDATE ${sql.identifier(table)}
        SET valid_from = NULL
        WHERE ${predicate}
      `),
    );
  } catch (error) {
    throw translatedCaptureRefusal(error);
  }
}

function assertClassifiableBounds(
  nonCanonical: ReadonlyMap<RepairRelation, number>,
): void {
  const unclassified = [...nonCanonical].filter(([, count]) => count > 0);
  if (unclassified.length === 0) return;
  throw new ConfigurationError(
    "Refusing to repair validity windows: some scanned rows store non-canonical bounds.",
    { nonCanonical: Object.fromEntries(unclassified) },
    {
      suggestion:
        'Normalize those bounds to canonical UTC ISO 8601 (YYYY-MM-DDTHH:MM:SS.mmmZ) and re-run, or narrow the call with graphId. Classifying them here would need a timestamp semantics this repair does not own, and skipping them silently would report a repair it did not make. mode: "report" still counts them.',
    },
  );
}

/**
 * Declares `"report"`'s read-only-ness to the ENGINE rather than only to the
 * reader of this file.
 *
 * The docs send an operator to diagnose against the live store's backend and
 * require quiescing only for `"apply"`, so the scan must not behave like a
 * writer: on SQLite a default transaction is `BEGIN IMMEDIATE`, which reserves
 * the single writer slot for the duration of up to four full-table `COUNT(*)`
 * scans and can fail `SQLITE_BUSY` against an active writer; `read_only` issues
 * a plain `BEGIN` instead. On PostgreSQL it issues `BEGIN … READ ONLY`, which
 * makes "report writes nothing" enforced by the engine and not merely asserted
 * by a test.
 *
 * `"apply"` writes, so it takes the default read-write transaction.
 */
function transactionOptionsFor(
  mode: RepairInvertedWindowsOptions["mode"],
): RunOptionallyInTransactionOptions | undefined {
  return mode === "report" ?
      { transaction: { accessMode: "read_only" } }
    : undefined;
}

function relationRecord(
  counts: ReadonlyMap<RepairRelation, number>,
): Readonly<Record<RepairRelation, number | undefined>> {
  return {
    nodes: counts.get("nodes"),
    edges: counts.get("edges"),
    recordedNodes: counts.get("recordedNodes"),
    recordedEdges: counts.get("recordedEdges"),
  };
}

/**
 * Counts — and, in `"apply"` mode, normalizes — rows whose stored validity
 * window is inverted.
 *
 * ```typescript
 * // Diagnose with the store's backend: `report` reads only, so it runs
 * // anywhere, including a capture-wrapped or statement-less backend.
 * const report = await repairInvertedValidityWindows({
 *   backend: anyBackend,
 *   relations: "live-and-recorded",
 *   mode: "report",
 * });
 *
 * // Repair with the raw one, while writers are stopped.
 * await repairInvertedValidityWindows({
 *   backend: rawBackend,
 *   relations: "live-and-recorded",
 *   mode: "apply",
 * });
 * ```
 *
 * Idempotent and convergent: a second `"apply"` reports zero, because the rows
 * the first one repaired no longer match the predicate.
 *
 * No batching, deliberately. Unlike the recorded-time migration, which rewrites
 * every row, this statement touches only rows the library mis-stored — an empty
 * set on a healthy graph. A deployment that reports a count large enough to
 * worry about should run it per `graphId`.
 *
 * @throws ConfigurationError in `"apply"` mode when the backend cannot execute
 *   statements, when the backend is a recorded-capture wrapper, or when any
 *   scanned relation stores non-canonical bounds. A transaction TARGET that
 *   disagrees with the top-level verdict (missing `executeStatement` the
 *   top-level backend has) refuses separately, with I20's
 *   `BUNDLE_PORT_SURFACE_MISMATCH` — the per-bundle port check
 *   `statementExecutionMembers` performs, not a second spelling of this one.
 */
export async function repairInvertedValidityWindows(
  options: RepairInvertedWindowsOptions,
): Promise<RepairInvertedWindowsReport> {
  const tables = resolvedTableNames(options.backend, options.tableNames);
  const relations = scopedRelations(options.relations);
  const verdict = statementExecutionVerdict(options.backend);
  // Refuse before opening a transaction: a backend with no statement path can
  // never apply, whatever the scan finds.
  if (options.mode === "apply" && !verdict.supported) {
    throw statementExecutionRequiredError(options.backend.dialect);
  }

  return runOptionallyInTransaction(
    options.backend,
    async (target, execution) => {
      const predicate = invertedValidityWindowPredicate({
        dialect: target.dialect,
        graphId: options.graphId,
      });
      const inverted = new Map<RepairRelation, number>();
      const nonCanonical = new Map<RepairRelation, number>();
      for (const relation of relations) {
        const table = relationTable(tables, relation);
        nonCanonical.set(
          relation,
          target.dialect === "sqlite" ?
            await countMatching(
              target,
              table,
              nonCanonicalWindowPredicate(options.graphId),
            )
          : 0,
        );
        inverted.set(relation, await countMatching(target, table, predicate));
      }

      if (options.mode === "apply") {
        assertClassifiableBounds(nonCanonical);
        for (const relation of relations) {
          await repairRelation(
            target,
            verdict,
            relationTable(tables, relation),
            predicate,
          );
        }
      }

      return {
        relations: options.relations,
        counts: relationRecord(inverted),
        nonCanonical: relationRecord(nonCanonical),
        // Keep the report's long-standing `atomic` compatibility field while
        // consuming the richer execution-mode decision from the transaction
        // seam. A sequential callback is not an interactive transaction even
        // when an adapter happens to execute one statement atomically.
        atomic: execution.mode === "interactive-transaction",
      };
    },
    transactionOptionsFor(options.mode),
  );
}
