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
 * Naming happens in two steps, so that uniqueness is guaranteed rather than
 * assumed:
 *
 * 1. {@link generatedIdentifier} names a LOGICAL identifier. A name that fits
 *    in 63 bytes is returned verbatim, so compiled SQL for ordinary aliases is
 *    byte-for-byte what it always was. A longer name is returned as a
 *    placeholder token that no SQL engine accepts.
 * 2. {@link sealGeneratedIdentifiers} allocates PHYSICAL names for one whole
 *    statement. Every name already written verbatim in the statement keeps
 *    its spelling and is reserved first; each long name, in order of first
 *    use, then takes its byte-bounded prefix plus a 64-bit hash of the full
 *    name, and if that physical name is already taken in the statement it is
 *    rehashed with an attempt counter until it is free. Two distinct logical
 *    names in a statement therefore never share a physical name, and the
 *    allocation depends only on the statement's text, so the same query
 *    always compiles to the same SQL.
 *
 * Emitters and result decoders both name columns through this module. Rows
 * come back keyed by physical names; {@link restoreGeneratedColumns} maps them
 * back to the logical keys decoders compute, and a wrapper that reads a column
 * of a sealed statement asks {@link generatedColumnName} for its physical name.
 * The bound is applied on every backend — SQLite has no identifier limit of
 * its own, but compiling the same text everywhere keeps a query valid on one
 * backend valid on the other.
 */
import { CompilerInvariantError, ConfigurationError } from "../errors";
import { fnv1a64Base36 } from "../utils/hash";
import { truncateToBytes } from "../utils/identifier";
import { rewriteSqlText, sql, type SqlFragment } from "./sql-fragment";

/** PostgreSQL's identifier limit in bytes, the strictest of every backend. */
const MAX_IDENTIFIER_BYTES = 63;

/** Prefix of the per-alias common table expression (`cte_<alias>`). */
const ALIAS_CTE_PREFIX = "cte_";

/** Prefix of a late-materialized node table alias (`lm_<alias>`). */
const ALIAS_TABLE_PREFIX = "lm_";

/** Opens a long logical name's placeholder token (a private-use character). */
const TOKEN_OPEN = "";
/** Closes a long logical name's placeholder token. */
const TOKEN_CLOSE = "";
const TOKEN_PATTERN = /([^]*)/gu;

const UTF8_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

/**
 * Names a logical SQL identifier: the name itself when it fits in 63 bytes,
 * otherwise a placeholder token that {@link sealGeneratedIdentifiers}
 * replaces with a physical name unique within the statement.
 */
export function generatedIdentifier(name: string): string {
  if (utf8ByteLength(name) <= MAX_IDENTIFIER_BYTES) return name;
  if (name.includes(TOKEN_OPEN) || name.includes(TOKEN_CLOSE)) {
    throw new ConfigurationError(
      "A query name longer than 63 bytes cannot contain the characters U+E000 or U+E001.",
      { name },
    );
  }
  return `${TOKEN_OPEN}${name}${TOKEN_CLOSE}`;
}

/** The column an alias's `column` is projected as: `<alias>_<column>`. */
export function aliasColumnName(alias: string, column: string): string {
  return generatedIdentifier(`${alias}_${column}`);
}

/** The name of an alias's common table expression: `cte_<alias>`. */
export function aliasCteName(alias: string): string {
  return generatedIdentifier(`${ALIAS_CTE_PREFIX}${alias}`);
}

/** The table alias a late-materialized node is re-joined as: `lm_<alias>`. */
export function aliasTableName(alias: string): string {
  return generatedIdentifier(`${ALIAS_TABLE_PREFIX}${alias}`);
}

/** {@link aliasColumnName} as an unquoted SQL fragment. */
export function rawAliasColumn(alias: string, column: string): SqlFragment {
  return sql.raw(aliasColumnName(alias, column));
}

/** {@link aliasCteName} as an unquoted SQL fragment. */
export function rawAliasCte(alias: string): SqlFragment {
  return sql.raw(aliasCteName(alias));
}

/**
 * The physical name a long logical name takes on its `attempt`-th try: its
 * longest prefix that leaves room within 63 bytes for `_<hash>`, where the
 * hash covers the full name (and the attempt, after the first). Exported so
 * tests can construct a fitting name that equals a long name's first choice.
 */
export function shortenedIdentifier(name: string, attempt = 0): string {
  const hash = fnv1a64Base36(attempt === 0 ? name : `${name}\0${attempt}`);
  const prefix = truncateToBytes(name, MAX_IDENTIFIER_BYTES - 1 - hash.length);
  return `${prefix}_${hash}`;
}

/** Long logical name (as its token) to the physical name it was allocated. */
type Allocation = ReadonlyMap<string, string>;

const EMPTY_ALLOCATION: Allocation = new Map();

/** Allocations of every sealed statement that contained a long name. */
const SEALED_ALLOCATIONS = new WeakMap<SqlFragment, Allocation>();

/** A bare identifier, or the body of a double-quoted one. */
const RESERVED_NAME_PATTERN = /"((?:[^"]|"")*)"|[\p{L}\p{N}_$]+/gu;

/**
 * Every name the statement already spells verbatim: bare words and quoted
 * identifiers in its text. This is a superset of the fitting generated names
 * (keywords and fixed names are reserved too, which only makes a long name
 * avoid them as well).
 */
function reservedNames(statementText: string): Set<string> {
  const reserved = new Set<string>();
  for (const match of statementText.matchAll(RESERVED_NAME_PATTERN)) {
    const quoted = match[1];
    reserved.add(
      quoted === undefined ? match[0] : quoted.replaceAll('""', '"'),
    );
  }
  return reserved;
}

/** The statement's text, with identifier chunks quoted as rendered. */
function statementText(statement: SqlFragment): string {
  return statement.chunks
    .map((chunk) => {
      switch (chunk.kind) {
        case "text": {
          return chunk.value;
        }
        case "identifier": {
          return `"${chunk.value.replaceAll('"', '""')}"`;
        }
        case "parameter":
        case "placeholder": {
          return " ";
        }
        default: {
          return " ";
        }
      }
    })
    .join("");
}

function allocate(text: string): Allocation {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    tokens.push(match[0]);
  }
  const taken = reservedNames(text.replaceAll(TOKEN_PATTERN, " "));
  const allocation = new Map<string, string>();
  for (const token of tokens) {
    const logical = token.slice(TOKEN_OPEN.length, -TOKEN_CLOSE.length);
    let attempt = 0;
    let physical = shortenedIdentifier(logical, attempt);
    while (taken.has(physical)) {
      attempt += 1;
      physical = shortenedIdentifier(logical, attempt);
    }
    taken.add(physical);
    allocation.set(token, physical);
  }
  return allocation;
}

/**
 * Allocates the physical name of every long generated identifier in one
 * statement and returns the statement with those names written in. A
 * statement without long names is returned unchanged.
 *
 * Seal a statement exactly once, at the point it leaves the compiler: a
 * statement composed from separately sealed parts would allocate each part
 * on its own, and a part's reference to a column of another could then miss.
 */
export function sealGeneratedIdentifiers<Statement extends SqlFragment>(
  statement: Statement,
): Statement {
  const text = statementText(statement);
  if (!text.includes(TOKEN_OPEN)) return statement;
  const allocation = allocate(text);
  const sealed = rewriteSqlText(statement, (value) =>
    value.includes(TOKEN_OPEN) ?
      value.replaceAll(TOKEN_PATTERN, (token) => allocation.get(token) ?? token)
    : value,
  );
  const leftover = statementText(sealed);
  if (leftover.includes(TOKEN_OPEN) || leftover.includes(TOKEN_CLOSE)) {
    throw new CompilerInvariantError(
      "A generated SQL identifier was split across statement text and could not be allocated",
    );
  }
  SEALED_ALLOCATIONS.set(sealed, allocation);
  return sealed as Statement;
}

function allocationOf(statement: SqlFragment): Allocation {
  return SEALED_ALLOCATIONS.get(statement) ?? EMPTY_ALLOCATION;
}

/**
 * The physical name `name` (as {@link generatedIdentifier} returned it) was
 * given in a sealed statement. A wrapper that selects a column of a compiled
 * statement must spell it this way, never by re-deriving it.
 */
export function generatedColumnName(
  statement: SqlFragment,
  name: string,
): string {
  if (!name.startsWith(TOKEN_OPEN)) return name;
  const physical = allocationOf(statement).get(name);
  if (physical === undefined) {
    throw new CompilerInvariantError(
      "A generated SQL identifier was read from a statement that never allocated it",
    );
  }
  return physical;
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
  return rewriteSqlText(wrapper, (value) =>
    value.includes(TOKEN_OPEN) ?
      value.replaceAll(TOKEN_PATTERN, (token) =>
        generatedColumnName(statement, token),
      )
    : value,
  ) as Fragment;
}

/** Physical column name to the logical key result decoders read it by. */
export type GeneratedColumns = ReadonlyMap<string, string>;

/** The physical-to-logical column map of a sealed statement. */
export function generatedColumnsOf(statement: SqlFragment): GeneratedColumns {
  const allocation = allocationOf(statement);
  if (allocation.size === 0) return EMPTY_ALLOCATION;
  return new Map(
    [...allocation].map(([token, physical]) => [physical, token] as const),
  );
}

/**
 * Re-keys rows read from a sealed statement by the logical names decoders
 * compute. Rows of a statement without long names are returned as is.
 */
export function restoreGeneratedColumns<Row extends Record<string, unknown>>(
  rows: readonly Row[],
  columns: GeneratedColumns,
): readonly Row[] {
  if (columns.size === 0) return rows;
  return rows.map((row) => {
    const restored: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      restored[columns.get(key) ?? key] = value;
    }
    return restored as Row;
  });
}

/** A logical name in a human-readable form, for error messages. */
export function displayGeneratedIdentifier(name: string): string {
  return name.replaceAll(TOKEN_PATTERN, (_token, logical: string) => logical);
}
