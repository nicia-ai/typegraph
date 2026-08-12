/**
 * The one classifier every perf fixture in this directory reads a statement
 * through — "what class is this statement?" has exactly one owner here, so a
 * fixture that needs a new class teaches this file, once, rather than growing
 * a second inline `.includes(...)` that the next rename silently strands.
 *
 * Two matchers are NOT relation lookups against {@link ResolvedSqlTableNames},
 * because their subject is not a `SqlTableNames` relation:
 *
 * - `advisoryLock` matches the `pg_advisory_xact_lock(...)` call text itself —
 *   PostgreSQL-only, no relation involved.
 * - `schemaFence` matches the schema-versions relation, whose name is owned by
 *   the backend's OWN table config (`PostgresTables` / `SqliteTables` in
 *   `src/backend/drizzle/schema/*.ts`), not by {@link ResolvedSqlTableNames} —
 *   the query compiler's schema never references it. Every fixture in this
 *   directory builds its backend with the default table names (never a custom
 *   prefix), so the literal below is the one this module's own callers can
 *   ever actually see; it is not spelled where a configured prefix could make
 *   it "match nothing" the way a `SqlTableNames` relation could.
 *
 * Every other relation class reads its name from {@link ResolvedSqlTableNames},
 * exactly as the statement-order oracle's own matchers do (see
 * `SCHEMA_TABLES` in `tests/write-plan-statement-order.test.ts`): a configured
 * table prefix must not silently make a substring matcher match nothing.
 */
import { type ResolvedSqlTableNames } from "../../src/query/compiler/schema";
import { type LoggedStatement } from "../statement-recorder";

export type StatementClass =
  | "transactionControl"
  | "advisoryLock"
  | "schemaFence"
  | "nodes"
  | "edges"
  | "nodeUniques"
  | "edgeClaims"
  | "identityAssertions"
  | "identityClosure"
  | "other";

export type StatementVerb = "select" | "insert" | "update" | "delete" | "other";

export type StatementKey = `${StatementClass}:${StatementVerb}`;

export type StatementTally = Readonly<Partial<Record<StatementKey, number>>>;

/**
 * Not part of {@link ResolvedSqlTableNames} — see the module doc. Every
 * fixture in this directory builds its backend with default table names, so
 * this is the one name any of them can ever see.
 */
const SCHEMA_VERSIONS_TABLE = "typegraph_schema_versions";

const TRANSACTION_CONTROL_PATTERN =
  /^\s*(begin|commit|rollback|savepoint|release)/i;

const VERB_PATTERNS: readonly (readonly [StatementVerb, RegExp])[] = [
  ["select", /^\s*select/i],
  ["insert", /^\s*insert/i],
  ["update", /^\s*update/i],
  ["delete", /^\s*delete/i],
];

function classifyVerb(query: string): StatementVerb {
  for (const [verb, pattern] of VERB_PATTERNS) {
    if (pattern.test(query)) return verb;
  }
  return "other";
}

/**
 * Relation classes in the order they are tested. None of the substrings below
 * collide (`typegraph_nodes` is not a substring of `typegraph_node_uniques`,
 * `typegraph_edges` is not a substring of `typegraph_edge_claims`, …), so the
 * order is for readability, not correctness.
 */
function classifyRelation(
  query: string,
  tables: ResolvedSqlTableNames,
): StatementClass | undefined {
  if (query.includes(tables.nodes)) return "nodes";
  if (query.includes(tables.edges)) return "edges";
  if (query.includes(tables.uniques)) return "nodeUniques";
  if (query.includes(tables.edgeClaims)) return "edgeClaims";
  if (query.includes(tables.identityAssertions)) return "identityAssertions";
  if (query.includes(tables.identityClosure)) return "identityClosure";
  return undefined;
}

function classifyStatementClass(
  statement: LoggedStatement,
  tables: ResolvedSqlTableNames,
): StatementClass {
  const { query } = statement;
  if (TRANSACTION_CONTROL_PATTERN.test(query)) return "transactionControl";
  if (query.includes("pg_advisory_xact_lock")) return "advisoryLock";
  if (query.includes(SCHEMA_VERSIONS_TABLE)) return "schemaFence";
  return classifyRelation(query, tables) ?? "other";
}

/** The `${class}:${verb}` key one statement contributes to a tally. */
export function classifyStatement(
  statement: LoggedStatement,
  tables: ResolvedSqlTableNames,
): StatementKey {
  return `${classifyStatementClass(statement, tables)}:${classifyVerb(statement.query)}`;
}

/** Tallies a write's captured statements by `classifyStatement`'s key. */
export function tallyStatements(
  statements: readonly LoggedStatement[],
  tables: ResolvedSqlTableNames,
): StatementTally {
  const tally: Partial<Record<StatementKey, number>> = {};
  for (const statement of statements) {
    const key = classifyStatement(statement, tables);
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
}

/**
 * The statement count a write's tally charges against its budget: every
 * statement except `transactionControl`, which is SQLite's structural fence
 * (`BEGIN IMMEDIATE` / `COMMIT`) rather than payload the write chose to issue.
 * PostgreSQL emits no `transactionControl` statements here (PGlite's own
 * transaction wrapping is outside what the logger reports), so this is a
 * no-op subtraction there and the SQLite-only exclusion this module's doc
 * promises.
 */
export function payloadCount(tally: StatementTally): number {
  let total = 0;
  for (const [key, count] of Object.entries(tally)) {
    if (key.startsWith("transactionControl:")) continue;
    total += count;
  }
  return total;
}
