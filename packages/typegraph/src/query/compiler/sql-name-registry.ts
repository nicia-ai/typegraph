/**
 * The one owner of the SQL-name collision decision for a compiled statement.
 *
 * The standard emitter registers every name it declares, per scope, together
 * with the logical value the name stands for (an alias's CTE, one column of an
 * alias, one result column), and records every place it refers to a name in a
 * scope. A name is checked against the other names of its scope under the
 * strictest comparison a supported engine applies:
 *
 * - PostgreSQL clips every identifier to its first 63 bytes.
 * - PostgreSQL folds unquoted names to lower case, and SQLite compares
 *   relation, column and output-alias names without regard to ASCII case,
 *   quoted or not. A name SQL refers to inside the statement is therefore
 *   compared case-insensitively.
 * - Result columns are read back by their exact name (both engines return a
 *   quoted alias as written), so they are compared case-sensitively unless SQL
 *   also refers to them; a result column the library decodes by name must also
 *   fit in 63 bytes, or PostgreSQL returns it under a clipped key.
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
 *   Two that meet matter only when the statement refers to that name in that
 *   relation: both engines accept duplicate columns that nothing names.
 * - `"result"`: the outermost SELECT list. Two names with the same exact
 *   spelling always collide (the row comes back keyed by name); two that meet
 *   only without regard to case collide when SQL refers to that name (an
 *   `ORDER BY` of an output alias, or a statement that wraps this one).
 */
type SqlNameComparison = "relation" | "column" | "result";

type SqlNameEntry = Readonly<{
  /** The logical value this name stands for; equal identities never collide. */
  identity: string;
  /** Human-readable description of the value, used in the refusal message. */
  description: string;
  name: string;
}>;

/** One scope's registrations: a WITH list, one CTE's columns, or the result columns. */
export type SqlNameScope = Readonly<{
  label: string;
  /** Registers `name` as the SQL name of the value `identity`. */
  register: (name: string, identity: string, description?: string) => void;
  /** Adds every name `source` holds, as a `SELECT source.*` does. */
  inherit: (source: SqlNameScope) => void;
  /**
   * Records that the statement refers to `name` in this scope by name, and
   * returns it. The emitter calls it where it writes the reference.
   */
  reference: (name: string) => string;
  /**
   * Records that the statement refers to every name of this scope, as a
   * `SELECT *` over the relation does: SQLite renames a duplicate column it
   * returns, so the row no longer carries it under its own name.
   */
  referenceEvery: () => void;
  /** Whether the statement refers to `name`, or to a name that meets it, here. */
  isReferenced: (name: string) => boolean;
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
  scopes: () => readonly Readonly<{
    comparison: SqlNameComparison;
    scope: SqlNameScope;
  }>[];
}>;

/**
 * How the caller uses the statement's result columns:
 *
 * - `"decoded"`: it reads each result column back by its exact name.
 * - `"embedded"`: it embeds the statement in SQL that names none of them
 *   (`count()`/`exists()`), or only one that PostgreSQL clips at the reference
 *   and the declaration alike (a set-update candidate's id column); only
 *   collisions refuse it, not a name's length.
 * - `"wrapped"`: it embeds the statement in SQL that refers to its result
 *   columns by name and then reads them back (relations, checked reads,
 *   `batchOnce()`, set operations), so result names are also compared without
 *   regard to letter case.
 */
export type SqlNameUsage = "decoded" | "embedded" | "wrapped";

/** The name an engine resolves `name` to where SQL refers to it. */
function referenceKey(name: string): string {
  return foldAsciiCase(truncateToBytes(name, MAX_PG_IDENTIFIER_LENGTH));
}

/** The name a row comes back under, after PostgreSQL clips it. */
function resultKey(name: string): string {
  return truncateToBytes(name, MAX_PG_IDENTIFIER_LENGTH);
}

function foldAsciiCase(name: string): string {
  return name.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function createSqlNameScope(label: string): SqlNameScope {
  const entries: SqlNameEntry[] = [];
  const seen = new Set<string>();
  const referencedKeys = new Set<string>();
  let everyNameReferenced = false;
  function add(entry: SqlNameEntry): void {
    const key = `${entry.identity}\u0000${entry.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  }
  return {
    label,
    register(name, identity, description) {
      add({ identity, description: description ?? identity, name });
    },
    inherit(source) {
      for (const entry of source.entries()) add(entry);
    },
    reference(name) {
      referencedKeys.add(referenceKey(name));
      return name;
    },
    referenceEvery() {
      everyNameReferenced = true;
    },
    isReferenced(name) {
      return everyNameReferenced || referencedKeys.has(referenceKey(name));
    },
    entries: () => entries,
  };
}

/** Creates the empty name scopes of one standard statement. */
export function createSqlStatementNames(): SqlStatementNames {
  const relations = createSqlNameScope("the WITH list");
  const results = createSqlNameScope("the result columns");
  const relationColumns = new Map<string, SqlNameScope>();
  return {
    relations,
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
  );
  return name;
}

/**
 * Records a by-name reference to one physical column of an alias in the
 * columns of `relationName`, and returns the column's name.
 */
export function referenceAliasColumn(
  names: SqlStatementNames,
  relationName: string,
  alias: string,
  column: string,
): string {
  return names
    .relationColumns(relationName)
    .reference(aliasColumnName(alias, column));
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

function collisionIssue(
  scope: SqlNameScope,
  earlier: SqlNameEntry,
  entry: SqlNameEntry,
  explanation: string,
): ValidationIssue {
  return {
    path: scope.label,
    code: SQL_IDENTIFIER_COLLISION_CODE,
    message: `"${earlier.name}" (${earlier.description}) and "${entry.name}" (${entry.description}) collide in ${scope.label}${explanation}.`,
  };
}

const CASE_FOLDED_EXPLANATION =
  ", which PostgreSQL clips to 63 bytes and the engines compare without regard to letter case";

/**
 * Every pair of different values in one scope whose names meet under `key`,
 * as long as `matters` holds for the shared name; reports each later entry
 * once, against the first entry it meets.
 */
function findMeetingPairs(
  scope: SqlNameScope,
  key: (name: string) => string,
  matters: (name: string) => boolean,
): readonly Readonly<{ earlier: SqlNameEntry; entry: SqlNameEntry }>[] {
  const pairs: { earlier: SqlNameEntry; entry: SqlNameEntry }[] = [];
  const firstByKey = new Map<string, SqlNameEntry>();
  for (const entry of scope.entries()) {
    const entryKey = key(entry.name);
    const earlier = firstByKey.get(entryKey);
    if (earlier === undefined) {
      firstByKey.set(entryKey, entry);
      continue;
    }
    if (earlier.identity === entry.identity || !matters(entry.name)) continue;
    pairs.push({ earlier, entry });
  }
  return pairs;
}

/** Every collision and over-long decoded name among a statement's registered names. */
export function findSqlNameIssues(
  names: SqlStatementNames,
  usage: SqlNameUsage,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const { comparison, scope } of names.scopes()) {
    switch (comparison) {
      case "relation": {
        for (const { earlier, entry } of findMeetingPairs(
          scope,
          referenceKey,
          () => true,
        ))
          issues.push(
            collisionIssue(scope, earlier, entry, CASE_FOLDED_EXPLANATION),
          );
        break;
      }
      case "column": {
        for (const { earlier, entry } of findMeetingPairs(
          scope,
          referenceKey,
          (name) => scope.isReferenced(name),
        ))
          issues.push(
            collisionIssue(scope, earlier, entry, CASE_FOLDED_EXPLANATION),
          );
        break;
      }
      case "result": {
        if (usage !== "embedded") {
          for (const entry of scope.entries()) {
            if (exceedsSqlIdentifierLimit(entry.name))
              issues.push(
                sqlIdentifierTooLongIssue(entry.name, entry.description),
              );
          }
        }
        const exact = findMeetingPairs(scope, resultKey, () => true);
        for (const { earlier, entry } of exact)
          issues.push(
            collisionIssue(
              scope,
              earlier,
              entry,
              " once PostgreSQL clips them to 63 bytes",
            ),
          );
        const reported = new Set(exact.map(({ entry }) => entry));
        for (const { earlier, entry } of findMeetingPairs(
          scope,
          referenceKey,
          (name) => usage === "wrapped" || scope.isReferenced(name),
        )) {
          if (reported.has(entry)) continue;
          issues.push(
            collisionIssue(
              scope,
              earlier,
              entry,
              ", which SQL refers to by name and the engines compare without regard to letter case",
            ),
          );
        }
        break;
      }
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
        "Use aliases and output keys that differ in more than letter case and within their first 50 characters, keep selected keys and aliases short enough that every result column fits in 63 bytes, and avoid selecting two values whose generated names meet (for example a property `edge_id` of alias `p` and the id of alias `p_edge`).",
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
