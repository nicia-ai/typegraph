/**
 * The one owner of every SQL identifier the query layer derives from caller
 * text.
 *
 * Query aliases are validated to at most 63 characters, but the compiler
 * builds further identifiers from them — `<alias>_<column>` output columns,
 * `cte_<alias>` common table expressions, `lm_<alias>` table aliases,
 * `<alias>_<field>` projections, default `<alias>_depth` / `<alias>_path`
 * columns — and PostgreSQL clips every identifier to 63 bytes. Two generated
 * names that differed only past byte 63 used to become one identifier there
 * (an "ambiguous column" error, or a read of the wrong column), while SQLite
 * kept them apart.
 *
 * A generated name is a {@link GeneratedName}: a value identified by the
 * components it was built from (an alias and a column, an alias and a role),
 * never by the text they concatenate to. `(p, edge_id)` and `(p_edge, id)`
 * both spell `p_edge_id`, and they are two names.
 *
 * Naming happens in two steps, so that uniqueness is guaranteed rather than
 * assumed:
 *
 * 1. The compiler writes each generated name into a statement as a deferred
 *    identifier chunk ({@link bareName}, {@link quotedName}): an identifier
 *    node of the SQL fragment carrying the name's identity, never text. Caller text — field names,
 *    JSON paths, literals, output keys — lives in other chunks and is never
 *    read or rewritten by naming, whatever characters it contains.
 * 2. {@link sealGeneratedIdentifiers} allocates PHYSICAL names for one whole
 *    statement from its deferred chunks alone. In order of first use, every
 *    name whose spelling fits in 63 bytes keeps it unless an earlier name
 *    already holds that spelling; every other name takes its byte-bounded
 *    prefix plus a 64-bit hash, rehashed with an attempt counter until no
 *    generated name and no quoted identifier in the statement holds it.
 *    Names are compared the way both engines compare them, ASCII
 *    case-insensitively, so two names never resolve to one identifier. The
 *    allocation depends only on the statement's generated names, so the same
 *    query always compiles to the same SQL, and a statement whose names all
 *    fit and differ is emitted exactly as written.
 *
 * Rows come back keyed by physical names. Decoders read a generated column
 * through the sealed statement's {@link GeneratedColumns}, and a wrapper that
 * selects a column of a sealed statement binds its own references with
 * {@link bindGeneratedIdentifiers}. The bound is applied on every backend —
 * SQLite has no identifier limit of its own, but compiling the same text
 * everywhere keeps a query valid on one backend valid on the other.
 */
import { CompilerInvariantError } from "../errors";
import { fnv1a64Base36 } from "../utils/hash";
import { truncateToBytes } from "../utils/identifier";
import {
  deferredIdentifiersOf,
  deferredIdentifierSql,
  type DeferredSqlIdentifierChunk,
  identifierNamesOf,
  resolveDeferredIdentifiers,
  sql,
  type SqlFragment,
} from "./sql-fragment";

/** PostgreSQL's identifier limit in bytes, the strictest of every backend. */
const MAX_IDENTIFIER_BYTES = 63;

/** Prefix of the per-alias common table expression (`cte_<alias>`). */
const ALIAS_CTE_PREFIX = "cte_";

/** Prefix of a late-materialized node table alias (`lm_<alias>`). */
const ALIAS_TABLE_PREFIX = "lm_";

const UTF8_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

/**
 * A SQL identifier the query compiler generates.
 *
 * `key` is its identity, built from its components; `spelling` is the text
 * it is written as when nothing else in its statement holds that text.
 */
export type GeneratedName = Readonly<{
  __type: "generated_name";
  key: string;
  spelling: string;
}>;

/** A name the compiler writes: a fixed SQL name, or a generated one. */
export type SqlName = string | GeneratedName;

function generatedName(
  role: string,
  components: readonly string[],
  spelling: string,
): GeneratedName {
  return Object.freeze({
    __type: "generated_name",
    key: JSON.stringify([role, ...components]),
    spelling,
  });
}

/** The column an alias's `column` is projected as: `<alias>_<column>`. */
export function aliasColumnName(alias: string, column: string): GeneratedName {
  return generatedName("column", [alias, column], `${alias}_${column}`);
}

/** The name of an alias's common table expression: `cte_<alias>`. */
export function aliasCteName(alias: string): GeneratedName {
  return generatedName("cte", [alias], `${ALIAS_CTE_PREFIX}${alias}`);
}

/** The table alias a late-materialized node is re-joined as: `lm_<alias>`. */
export function aliasTableName(alias: string): GeneratedName {
  return generatedName("table", [alias], `${ALIAS_TABLE_PREFIX}${alias}`);
}

/** The aggregate fast path's per-node count CTE: `cte_<alias>_counts`. */
export function aliasCountsCteName(alias: string): GeneratedName {
  return generatedName(
    "counts-cte",
    [alias],
    `${ALIAS_CTE_PREFIX}${alias}_counts`,
  );
}

/** A recursive edge alias's CTE of directed edges: `<alias>_directed_edges`. */
export function aliasDirectedEdgesCteName(alias: string): GeneratedName {
  return generatedName(
    "directed-edges-cte",
    [alias],
    `${alias}_directed_edges`,
  );
}

/**
 * The column a selectively extracted props field is carried in through a
 * CTE. The spelling length-prefixes alias and field, keeping the readable
 * `__tg_...` form; the identity is the pair itself.
 */
export function selectivePropsColumnName(
  alias: string,
  field: string,
): GeneratedName {
  return generatedName(
    "props-column",
    [alias, field],
    `__tg_${alias.length}:${alias}:${field.length}:${field}`,
  );
}

/**
 * A column named by a result key: a recursive traversal's depth or path
 * output, whose key is caller-chosen or derived (`<alias>_depth`).
 */
export function resultColumnName(resultKey: string): GeneratedName {
  return generatedName("result", [resultKey], resultKey);
}

/** A generated name, written bare (unquoted) into a statement. */
export function bareName(name: GeneratedName): SqlFragment {
  return deferredIdentifierSql(name, false);
}

/** A generated name, written as a double-quoted identifier. */
export function quotedName(name: GeneratedName): SqlFragment {
  return deferredIdentifierSql(name, true);
}

/** A fixed or generated name, written bare. */
export function bareSqlName(name: SqlName): SqlFragment {
  return typeof name === "string" ? sql.raw(name) : bareName(name);
}

/** A fixed or generated name, written as a double-quoted identifier. */
export function quotedSqlName(name: SqlName): SqlFragment {
  return typeof name === "string" ? sql.identifier(name) : quotedName(name);
}

/** {@link aliasColumnName}, written bare. */
export function rawAliasColumn(alias: string, column: string): SqlFragment {
  return bareName(aliasColumnName(alias, column));
}

/** {@link aliasCteName}, written bare. */
export function rawAliasCte(alias: string): SqlFragment {
  return bareName(aliasCteName(alias));
}

/**
 * The identity of a name the compiler writes: two names are one column
 * exactly when their identities are equal. A fixed name is identified by its
 * text, a generated one by its components.
 */
export function sqlNameKey(name: SqlName): string {
  return typeof name === "string" ? JSON.stringify(["fixed", name]) : name.key;
}

/** A name in a human-readable form, for error messages. */
export function displayName(name: SqlName): string {
  return typeof name === "string" ? name : name.spelling;
}

/**
 * The physical name a name spelled `spelling` takes on its `attempt`-th
 * hashed try: its longest prefix that leaves room within 63 bytes for
 * `_<hash>`, where the hash covers the full spelling (and the attempt, after
 * the first). Exported so tests can construct a fitting name that equals a
 * long name's first choice.
 */
export function shortenedIdentifier(spelling: string, attempt = 0): string {
  const hash = fnv1a64Base36(
    attempt === 0 ? spelling : `${spelling}\0${attempt}`,
  );
  const prefix = truncateToBytes(
    spelling,
    MAX_IDENTIFIER_BYTES - 1 - hash.length,
  );
  return `${prefix}_${hash}`;
}

/**
 * The form under which SQLite and PostgreSQL compare two identifiers.
 *
 * PostgreSQL folds an unquoted identifier's ASCII letters to lower case, and
 * SQLite compares every identifier, quoted or not, ASCII case-insensitively.
 * Two generated names whose folded forms are equal are therefore one
 * identifier on at least one engine, however each is quoted. Only ASCII is
 * folded: neither engine folds other letters in a UTF-8 database.
 */
export function foldedIdentifier(name: string): string {
  return name.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

/** Generated name key to the physical name its statement allocated. */
type Allocation = ReadonlyMap<string, string>;

/** The allocation of every sealed statement. */
const SEALED_ALLOCATIONS = new WeakMap<SqlFragment, Allocation>();

/** Distinct generated names of a statement, by key, in order of first use. */
function distinctNames(
  chunks: readonly DeferredSqlIdentifierChunk[],
): ReadonlyMap<string, string> {
  const spellings = new Map<string, string>();
  for (const chunk of chunks) {
    const known = spellings.get(chunk.deferred.key);
    if (known === undefined) {
      spellings.set(chunk.deferred.key, chunk.value);
    } else if (known !== chunk.value) {
      throw new CompilerInvariantError(
        "One generated SQL identifier was written with two spellings",
        { spellings: [known, chunk.value] },
      );
    }
  }
  return spellings;
}

function allocate(statement: SqlFragment): Allocation {
  const names = distinctNames(deferredIdentifiersOf(statement));
  const allocation = new Map<string, string>();
  const taken = new Set<string>();
  // A name that fits keeps its spelling unless an earlier generated name
  // already holds it: the statement is then exactly what was written.
  for (const [key, spelling] of names) {
    if (utf8ByteLength(spelling) > MAX_IDENTIFIER_BYTES) continue;
    const folded = foldedIdentifier(spelling);
    if (taken.has(folded)) continue;
    taken.add(folded);
    allocation.set(key, spelling);
  }
  // Every other name is hashed into a name nothing in the statement holds:
  // no generated name, and no quoted identifier the compiler wrote.
  const quoted = new Set(
    identifierNamesOf(statement).map((name) => foldedIdentifier(name)),
  );
  for (const [key, spelling] of names) {
    if (allocation.has(key)) continue;
    let attempt = 0;
    let physical = shortenedIdentifier(spelling, attempt);
    while (
      taken.has(foldedIdentifier(physical)) ||
      quoted.has(foldedIdentifier(physical))
    ) {
      attempt += 1;
      physical = shortenedIdentifier(spelling, attempt);
    }
    taken.add(foldedIdentifier(physical));
    allocation.set(key, physical);
  }
  return allocation;
}

function physicalNameIn(allocation: Allocation, key: string): string {
  const physical = allocation.get(key);
  if (physical === undefined) {
    throw new CompilerInvariantError(
      "A generated SQL identifier was read from a statement that never allocated it",
    );
  }
  return physical;
}

/**
 * Allocates the physical name of every generated identifier in one statement
 * and returns the statement with those names written in.
 *
 * Seal a statement exactly once, at the point it leaves the compiler: a
 * statement composed from separately sealed parts would allocate each part
 * on its own, and a part's reference to a column of another could then miss.
 */
export function sealGeneratedIdentifiers<Statement extends SqlFragment>(
  statement: Statement,
): Statement {
  if (SEALED_ALLOCATIONS.has(statement)) return statement;
  const allocation = allocate(statement);
  const sealed = resolveDeferredIdentifiers(statement, (chunk) =>
    physicalNameIn(allocation, chunk.deferred.key),
  );
  SEALED_ALLOCATIONS.set(sealed, allocation);
  return sealed as Statement;
}

const EMPTY_ALLOCATION: Allocation = new Map();

/**
 * The allocation of a sealed statement. A fragment that was never sealed has
 * none, which is only consistent when it holds no generated identifier (a
 * wrapper around a sealed statement, whose names are already written in).
 */
function allocationOf(statement: SqlFragment): Allocation {
  const allocation = SEALED_ALLOCATIONS.get(statement);
  if (allocation !== undefined) return allocation;
  if (deferredIdentifiersOf(statement).length > 0) {
    throw new CompilerInvariantError(
      "Generated SQL identifiers were read from a statement that was never sealed",
    );
  }
  return EMPTY_ALLOCATION;
}

/**
 * The physical name `name` was given in a sealed statement. A wrapper that
 * selects a column of a compiled statement must spell it this way, never by
 * re-deriving it.
 */
export function generatedColumnName(
  statement: SqlFragment,
  name: SqlName,
): string {
  if (typeof name === "string") return name;
  return physicalNameIn(allocationOf(statement), name.key);
}

/**
 * Writes the physical names `statement` allocated into `wrapper`, a fragment
 * built around that sealed statement that refers to its columns by their
 * generated names. Re-sealing the wrapper instead would allocate afresh and
 * could pick a different name than the embedded statement already uses.
 */
export function bindGeneratedIdentifiers<Fragment extends SqlFragment>(
  wrapper: Fragment,
  statement: SqlFragment,
): Fragment {
  const allocation = allocationOf(statement);
  return resolveDeferredIdentifiers(wrapper, (chunk) =>
    physicalNameIn(allocation, chunk.deferred.key),
  ) as Fragment;
}

/** How one sealed statement names its generated columns. */
export type GeneratedColumns = Readonly<{
  /**
   * The row key a generated column is read under, or `undefined` when the
   * statement does not name it. A fixed name is its own row key.
   */
  columnOf: (name: SqlName) => string | undefined;
}>;

/** The generated columns of a sealed statement. */
export function generatedColumnsOf(statement: SqlFragment): GeneratedColumns {
  const allocation = allocationOf(statement);
  return Object.freeze({
    columnOf: (name: SqlName) =>
      typeof name === "string" ? name : allocation.get(name.key),
  });
}

/** Reads the value of a generated column from a row of a sealed statement. */
export function readGeneratedColumn(
  row: Readonly<Record<string, unknown>>,
  columns: GeneratedColumns,
  name: SqlName,
): unknown {
  const column = columns.columnOf(name);
  return column === undefined ? undefined : row[column];
}
