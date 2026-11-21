/**
 * The one owner of the SQL-name collision decision for a compiled statement.
 *
 * The standard emitter registers every name it declares, per scope, together
 * with the logical value the name stands for (an alias's CTE, one column of an
 * alias, one result column). A name is checked against the other names of its
 * scope under the strictest comparison a supported engine applies:
 *
 * - PostgreSQL clips every identifier to its first 63 bytes.
 * - PostgreSQL folds unquoted names to lower case, and SQLite compares
 *   relation and column names without regard to ASCII case, quoted or not.
 *   WITH-list names and CTE columns are referenced by name inside the
 *   statement, so they are compared case-insensitively.
 * - Result columns are read back by their exact name (both engines return a
 *   quoted alias as written), so they are compared case-sensitively; a result
 *   column the library decodes by name must also fit in 63 bytes, or
 *   PostgreSQL returns it under a clipped key.
 *
 * Two different values that meet under that comparison make a statement that
 * fails, or silently returns the wrong value, on at least one engine; the
 * statement is refused with one `ValidationError` on every engine instead.
 * The decision does not depend on the dialect, so no query can be accepted on
 * one backend and refused on another.
 */
import { MAX_PG_IDENTIFIER_LENGTH } from "../../constants";
import {
  SQL_IDENTIFIER_COLLISION_CODE,
  SQL_IDENTIFIER_TOO_LONG_CODE,
  ValidationError,
  type ValidationIssue,
} from "../../errors";
import { truncateToBytes } from "../../utils/identifier";
import {
  aliasColumnName,
  aliasCteName,
  selectivePropsColumnName,
} from "./alias-names";

const TEXT_ENCODER = new TextEncoder();

/**
 * How names in one scope are compared:
 *
 * - `"relation"`: WITH-list names. Two that meet are refused by both engines
 *   whether or not anything reads them, and they are compared
 *   case-insensitively.
 * - `"column"`: the columns of one WITH relation, compared case-insensitively.
 *   Two that meet matter only when the statement reads one of them by name:
 *   both engines accept duplicate columns that a `SELECT *` merely carries.
 * - `"result"`: the outermost SELECT list, read back by exact spelling.
 */
type SqlNameComparison = "relation" | "column" | "result";

/** The alias column a CTE column carries, for deciding whether it is read. */
type SqlColumnRead = Readonly<{ alias: string; column: string }>;

type SqlNameEntry = Readonly<{
  /** The logical value this name stands for; equal identities never collide. */
  identity: string;
  /** Human-readable description of the value, used in the refusal message. */
  description: string;
  name: string;
  /**
   * The alias column this name carries. Absent for a column every statement
   * that declares it also reads (sort keys, counts, extracted properties).
   */
  readAs?: SqlColumnRead | undefined;
}>;

/** One scope's registrations: a WITH list, one CTE's columns, or the result columns. */
export type SqlNameScope = Readonly<{
  label: string;
  /** Registers `name` as the SQL name of the value `identity`. */
  register: (
    name: string,
    identity: string,
    description?: string  ,
    readAs?: SqlColumnRead  ,
  ) => void;
  /** Adds every name `source` holds, as a `SELECT source.*` does. */
  inherit: (source: SqlNameScope) => void;
  entries: () => readonly SqlNameEntry[];
}>;

/** The name scopes of one standard statement. */
export type SqlStatementNames = Readonly<{
  /** The statement's WITH list. */
  relations: SqlNameScope;
  /** The SELECT list of one WITH relation, created on first use. */
  relationColumns: (relationName: string) => SqlNameScope;
  /** The statement's outermost SELECT list. */
  results: SqlNameScope;
  /**
   * Records which alias columns the statement reads by name: the compiler's
   * column-pruning read set, or `"every column"` when the statement reads
   * whole CTE rows (`SELECT *`). Until recorded, every column counts as read.
   */
  recordColumnReads: (
    reads: ReadonlyMap<string, ReadonlySet<string>> | "every column",
  ) => void;
  /** Whether the statement reads the column an entry names. */
  isRead: (entry: SqlNameEntry) => boolean;
  scopes: () => readonly Readonly<{
    comparison: SqlNameComparison;
    scope: SqlNameScope;
  }>[];
}>;

/**
 * Whether the caller decodes the statement's result columns by name
 * (`"decoded"`), or embeds the statement in SQL that reads them itself
 * (`"embedded"`, e.g. a set-update candidate whose id column is read inside the
 * UPDATE, where PostgreSQL clips the reference and the declaration alike).
 */
export type SqlNameUsage = "decoded" | "embedded";

function createSqlNameScope(label: string): SqlNameScope {
  const entries: SqlNameEntry[] = [];
  const seen = new Set<string>();
  function add(entry: SqlNameEntry): void {
    const key = `${entry.identity}\u0000${entry.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  }
  return {
    label,
    register(name, identity, description, readAs) {
      add({
        identity,
        description: description ?? identity,
        name,
        ...(readAs === undefined ? {} : { readAs }),
      });
    },
    inherit(source) {
      for (const entry of source.entries()) add(entry);
    },
    entries: () => entries,
  };
}

/** Creates the empty name scopes of one standard statement. */
export function createSqlStatementNames(): SqlStatementNames {
  const relations = createSqlNameScope("the WITH list");
  const results = createSqlNameScope("the result columns");
  const relationColumns = new Map<string, SqlNameScope>();
  let columnReads: ReadonlyMap<string, ReadonlySet<string>> | "every column" =
    "every column";
  return {
    relations,
    recordColumnReads(reads) {
      columnReads = reads;
    },
    isRead(entry) {
      if (entry.readAs === undefined || columnReads === "every column")
        return true;
      return (
        columnReads.get(entry.readAs.alias)?.has(entry.readAs.column) ?? false
      );
    },
    relationColumns(relationName) {
      const existing = relationColumns.get(relationName);
      if (existing !== undefined) return existing;
      const scope = createSqlNameScope(`the columns of ${relationName}`);
      relationColumns.set(relationName, scope);
      return scope;
    },
    results,
    scopes: () => [
      { comparison: "relation", scope: relations },
      ...[...relationColumns.values()].map((scope) => ({
        comparison: "column" as const,
        scope,
      })),
      { comparison: "result", scope: results },
    ],
  };
}

/**
 * Declares an alias's WITH relation (`cte_<alias>`) in the statement's WITH
 * list and returns its name. Declaring the name through this function is what
 * puts it under the collision check.
 */
export function declareAliasCte(
  names: SqlStatementNames,
  alias: string,
): string {
  const name = aliasCteName(alias);
  names.relations.register(
    name,
    `alias\u0000${alias}`,
    `the rows of alias "${alias}"`,
  );
  return name;
}

/** Declares a fixed, library-owned WITH relation name in the statement's WITH list. */
export function declareFixedCte(
  names: SqlStatementNames,
  name: string,
): string {
  names.relations.register(
    name,
    `fixed\u0000${name}`,
    `the library's own "${name}" relation`,
  );
  return name;
}

/** Declares one physical column of an alias in a CTE's columns and returns its name. */
export function declareAliasColumn(
  scope: SqlNameScope,
  alias: string,
  column: string,
): string {
  const name = aliasColumnName(alias, column);
  scope.register(
    name,
    `column\u0000${alias}\u0000${column}`,
    `column ${column} of alias "${alias}"`,
    { alias, column },
  );
  return name;
}

/** Declares the CTE column that carries one selectively extracted props field. */
export function declareSelectivePropsColumn(
  scope: SqlNameScope,
  alias: string,
  field: string,
): string {
  const name = selectivePropsColumnName(alias, field);
  scope.register(
    name,
    `props\u0000${alias}\u0000${field}`,
    `property ${field} of alias "${alias}"`,
  );
  return name;
}

/**
 * Declares one result column. Every result column is its own value, so two
 * entries of one SELECT list that share a name always collide — including two
 * that a later step would deduplicate by name.
 */
export function declareResultColumn(
  names: SqlStatementNames,
  name: string,
  description: string,
): string {
  const ordinal = names.results.entries().length;
  names.results.register(name, `result\u0000${ordinal}`, description);
  return name;
}

/** Whether a name is longer than PostgreSQL's 63-byte identifier limit. */
export function exceedsSqlIdentifierLimit(name: string): boolean {
  return TEXT_ENCODER.encode(name).byteLength > MAX_PG_IDENTIFIER_LENGTH;
}

/** The name an engine resolves `name` to under one scope's comparison. */
function comparisonKey(name: string, comparison: SqlNameComparison): string {
  const clipped = truncateToBytes(name, MAX_PG_IDENTIFIER_LENGTH);
  return comparison === "result" ? clipped : foldAsciiCase(clipped);
}

function foldAsciiCase(name: string): string {
  return name.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

/** The issue that refuses a result column the library would read back under a clipped name. */
export function sqlIdentifierTooLongIssue(
  name: string,
  description: string,
): ValidationIssue {
  return {
    path: "the result columns",
    code: SQL_IDENTIFIER_TOO_LONG_CODE,
    message: `The result column "${name}" (${description}) is ${TEXT_ENCODER.encode(name).byteLength} bytes long; PostgreSQL clips SQL names to ${MAX_PG_IDENTIFIER_LENGTH} bytes, so the value would come back under a different name.`,
  };
}

/** Every collision and over-long decoded name among a statement's registered names. */
export function findSqlNameIssues(
  names: SqlStatementNames,
  usage: SqlNameUsage,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const { comparison, scope } of names.scopes()) {
    const byKey = new Map<string, SqlNameEntry>();
    for (const entry of scope.entries()) {
      if (
        comparison === "result" &&
        usage === "decoded" &&
        exceedsSqlIdentifierLimit(entry.name)
      ) {
        issues.push(sqlIdentifierTooLongIssue(entry.name, entry.description));
      }
      const key = comparisonKey(entry.name, comparison);
      const earlier = byKey.get(key);
      if (earlier === undefined) {
        byKey.set(key, entry);
        continue;
      }
      if (earlier.identity === entry.identity) continue;
      if (
        comparison === "column" &&
        !names.isRead(earlier) &&
        !names.isRead(entry)
      )
        continue;
      issues.push({
        path: scope.label,
        code: SQL_IDENTIFIER_COLLISION_CODE,
        message: `"${earlier.name}" (${earlier.description}) and "${entry.name}" (${entry.description}) collide in ${scope.label}${comparison === "result" ? " once PostgreSQL clips them to 63 bytes" : ", which PostgreSQL clips to 63 bytes and the engines compare without regard to letter case"}.`,
      });
    }
  }
  return issues;
}

/** Builds the refusal for a statement whose generated SQL names cannot be told apart. */
export function sqlNameRefusal(
  issues: readonly ValidationIssue[],
): ValidationError {
  const first = issues[0];
  return new ValidationError(
    `Query refused before any SQL was sent: ${first?.message ?? "its generated SQL names cannot be told apart on every database engine."}`,
    { issues },
    {
      suggestion:
        "Use aliases that differ in more than letter case and within their first 50 characters, keep selected keys and aliases short enough that every result column fits in 63 bytes, and avoid selecting two values whose generated names meet (for example a property `edge_id` of alias `p` and the id of alias `p_edge`).",
    },
  );
}

/**
 * Whether a caller-chosen result key falls in the library's reserved `__tg_`
 * namespace, in any letter case: hidden columns the library adds (ordering,
 * relation order, batch envelopes) are named there, and SQLite compares names
 * without regard to case.
 */
export function isReservedResultKey(key: string): boolean {
  return foldAsciiCase(key).startsWith("__tg_");
}

/** Throws the typed refusal when a statement's registered names collide. */
export function refuseConflictingSqlNames(
  names: SqlStatementNames,
  usage: SqlNameUsage,
): void {
  const issues = findSqlNameIssues(names, usage);
  if (issues.length > 0) throw sqlNameRefusal(issues);
}
