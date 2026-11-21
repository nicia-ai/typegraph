import { CompilerInvariantError, ConfigurationError } from "../errors";
import { typeGraphGlobalSymbol } from "../utils/global-symbol";
import {
  bindSqlValue,
  getSqlDialectProfile,
  inlineSqlStringLiteral,
} from "./dialect/profile";
import { type SqlDialect } from "./dialect/types";
import { copySqlIntents } from "./sql-intent";

/** Nominal identity shared by every package entrypoint. */
const SQL_FRAGMENT_BRAND: unique symbol = typeGraphGlobalSymbol("sql-fragment");
const SQL_PLACEHOLDER_BRAND: unique symbol =
  typeGraphGlobalSymbol("sql-placeholder");

export type SqlTextChunk = Readonly<{
  kind: "text";
  value: string;
}>;

export type SqlParameterChunk = Readonly<{
  kind: "parameter";
  value: unknown;
}>;

export type SqlIdentifierChunk = Readonly<{
  kind: "identifier";
  value: string;
  /**
   * Present only on an identifier the query compiler generated and has not
   * yet named: `value` is its spelling, `key` its identity (two chunks with
   * one key are the same identifier, two with different keys are different
   * identifiers even when they spell the same text), and `quoted` whether
   * it is written double-quoted or bare. The compiler allocates every such
   * chunk a physical name before a statement leaves it, so a compiled
   * statement never contains one and rendering one is an internal error.
   */
  deferred?: Readonly<{ key: string; quoted: boolean }>;
}>;

export type SqlPlaceholderChunk = Readonly<{
  kind: "placeholder";
  value: Placeholder;
}>;

/** @internal A generated identifier awaiting its physical name. */
export type DeferredSqlIdentifierChunk = SqlIdentifierChunk &
  Readonly<{ deferred: Readonly<{ key: string; quoted: boolean }> }>;

/** One immutable unit in a database-independent SQL fragment. */
export type SqlChunk =
  SqlTextChunk | SqlParameterChunk | SqlIdentifierChunk | SqlPlaceholderChunk;

/**
 * An immutable, database-independent SQL expression.
 *
 * Fragments contain syntax and bound values as separate nodes. A database
 * adapter renders the same fragment with its native placeholder convention at
 * the final execution boundary.
 */
export type SqlFragment = Readonly<{
  [SQL_FRAGMENT_BRAND]: true;
  append: (fragment: SqlFragment) => SqlFragment;
  chunks: readonly SqlChunk[];
}>;

/** A named value resolved when a prepared statement is executed. */
export class Placeholder {
  readonly [SQL_PLACEHOLDER_BRAND] = true as const;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
    Object.freeze(this);
  }
}

class SqlFragmentValue implements SqlFragment {
  readonly [SQL_FRAGMENT_BRAND] = true as const;

  readonly chunks: readonly SqlChunk[];

  constructor(chunks: readonly SqlChunk[]) {
    this.chunks = Object.freeze([...chunks]);
    Object.freeze(this);
  }

  append(fragment: SqlFragment): SqlFragment {
    return createFragment(
      [...this.chunks, ...getChunks(fragment)],
      [this, fragment],
    );
  }
}

function createFragment(
  chunks: readonly SqlChunk[],
  intentSources: readonly SqlFragment[] = [],
): SqlFragment {
  const fragment = new SqlFragmentValue(chunks);
  copySqlIntents(fragment, intentSources);
  return fragment;
}

function getChunks(fragment: SqlFragment): readonly SqlChunk[] {
  if (!isSqlFragment(fragment)) {
    throw new ConfigurationError(
      "Expected a SQL fragment created by TypeGraph's sql helper",
    );
  }
  return fragment.chunks;
}

/** Returns whether a value is a TypeGraph-owned SQL fragment. */
export function isSqlFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    SQL_FRAGMENT_BRAND in value &&
    value[SQL_FRAGMENT_BRAND] === true &&
    "chunks" in value &&
    Array.isArray(value.chunks) &&
    "append" in value &&
    typeof value.append === "function"
  );
}

/** Returns whether a value is a TypeGraph named SQL placeholder. */
export function isSqlPlaceholder(value: unknown): value is Placeholder {
  return (
    typeof value === "object" &&
    value !== null &&
    SQL_PLACEHOLDER_BRAND in value &&
    value[SQL_PLACEHOLDER_BRAND] === true &&
    "name" in value &&
    typeof value.name === "string"
  );
}

/** @internal Enforces exhaustive handling at every fragment boundary. */
export function throwUnsupportedSqlChunk(chunk: never): never {
  throw new ConfigurationError("Unsupported SQL fragment chunk", { chunk });
}

/**
 * @internal Refuses to render a generated identifier whose statement never
 * allocated it a physical name.
 */
export function throwUnresolvedDeferredIdentifier(
  chunk: SqlIdentifierChunk,
): never {
  throw new CompilerInvariantError(
    "A generated SQL identifier was rendered before its statement allocated it a physical name",
    { spelling: chunk.value },
  );
}

function isDeferredIdentifier(
  chunk: SqlChunk,
): chunk is DeferredSqlIdentifierChunk {
  return chunk.kind === "identifier" && chunk.deferred !== undefined;
}

function textNode(value: string): SqlTextChunk {
  return Object.freeze({ kind: "text", value });
}

function parameterNode(value: unknown): SqlParameterChunk {
  return Object.freeze({ kind: "parameter", value });
}

function identifierNode(value: string): SqlIdentifierChunk {
  return Object.freeze({ kind: "identifier", value });
}

function placeholderNode(value: Placeholder): SqlPlaceholderChunk {
  return Object.freeze({ kind: "placeholder", value });
}

/**
 * @internal A fragment holding one generated identifier, allocated a
 * physical name when its statement is sealed.
 */
export function deferredIdentifierSql(
  name: Readonly<{ key: string; spelling: string }>,
  quoted: boolean,
): SqlFragment {
  return createFragment([
    Object.freeze({
      kind: "identifier",
      value: name.spelling,
      deferred: Object.freeze({ key: name.key, quoted }),
    }),
  ]);
}

/**
 * Appends a fragment's chunks one at a time. Never `push(...chunks)`: a
 * fragment holding a large `VALUES` list has more chunks than an engine
 * accepts as call arguments, and the spread overflows the stack.
 */
function appendChunks(chunks: SqlChunk[], fragment: SqlFragment): void {
  for (const chunk of getChunks(fragment)) chunks.push(chunk);
}

/**
 * The most terms one compound SELECT (`UNION ALL` chain) may join on every
 * engine: SQLite's default `SQLITE_LIMIT_COMPOUND_SELECT`. A statement built
 * from caller-sized input splits its terms at this cap as well as at the
 * bound-parameter budget.
 */
export const PORTABLE_COMPOUND_SELECT_TERMS_LIMIT = 500;

/** How many bound parameters a fragment renders, placeholders included. */
export function countSqlParameters(fragment: SqlFragment): number {
  let count = 0;
  for (const chunk of getChunks(fragment)) {
    if (chunk.kind === "parameter" || chunk.kind === "placeholder") count += 1;
  }
  return count;
}

function templateSql(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): SqlFragment {
  const chunks: SqlChunk[] = [];
  const intentSources: SqlFragment[] = [];

  for (const [index, text] of strings.entries()) {
    if (text.length > 0) chunks.push(textNode(text));

    if (index >= values.length) continue;
    const value = values[index];
    if (isSqlFragment(value)) {
      appendChunks(chunks, value);
      intentSources.push(value);
    } else if (isSqlPlaceholder(value)) {
      chunks.push(placeholderNode(value));
    } else {
      chunks.push(parameterNode(value));
    }
  }

  return createFragment(chunks, intentSources);
}

function rawSql(value: string): SqlFragment {
  return createFragment(value.length === 0 ? [] : [textNode(value)]);
}

function identifierSql(value: string): SqlFragment {
  return createFragment([identifierNode(value)]);
}

function joinSql(
  fragments: readonly SqlFragment[],
  separator: SqlFragment = EMPTY_SQL,
): SqlFragment {
  const chunks: SqlChunk[] = [];
  const intentSources: SqlFragment[] = [separator];

  for (const [index, fragment] of fragments.entries()) {
    if (index > 0) appendChunks(chunks, separator);
    appendChunks(chunks, fragment);
    intentSources.push(fragment);
  }

  return createFragment(chunks, intentSources);
}

function placeholderSql(name: string): SqlFragment {
  return createFragment([placeholderNode(new Placeholder(name))]);
}

const EMPTY_SQL = createFragment([]);

/** TypeGraph's database-independent SQL template and composition helpers. */
export type SqlTag = Readonly<{
  empty: () => SqlFragment;
  identifier: (value: string) => SqlFragment;
  join: (
    fragments: readonly SqlFragment[],
    separator?: SqlFragment,
  ) => SqlFragment;
  placeholder: (name: string) => SqlFragment;
  raw: (value: string) => SqlFragment;
}> &
  ((
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ) => SqlFragment);

/** TypeGraph's database-independent SQL template and composition helpers. */
export const sql: SqlTag = Object.assign(templateSql, {
  empty: function empty(): SqlFragment {
    return EMPTY_SQL;
  },
  identifier: identifierSql,
  join: joinSql,
  placeholder: placeholderSql,
  raw: rawSql,
});

/**
 * @internal Writes a physical name into every generated identifier of
 * `fragment`: a bare one becomes text, a quoted one an identifier chunk.
 * Only deferred identifier chunks are read; text, identifiers, bound values,
 * placeholders, and compiler intents are carried over unchanged, and a
 * fragment without generated identifiers is returned as is.
 */
export function resolveDeferredIdentifiers(
  fragment: SqlFragment,
  physicalName: (chunk: DeferredSqlIdentifierChunk) => string,
): SqlFragment {
  const original = getChunks(fragment);
  if (!original.some((chunk) => isDeferredIdentifier(chunk))) return fragment;
  const chunks = original.map((chunk): SqlChunk => {
    if (!isDeferredIdentifier(chunk)) return chunk;
    const physical = physicalName(chunk);
    return chunk.deferred.quoted ?
        identifierNode(physical)
      : textNode(physical);
  });
  return createFragment(chunks, [fragment]);
}

/** @internal The generated identifiers of a fragment, in order of use. */
export function deferredIdentifiersOf(
  fragment: SqlFragment,
): readonly DeferredSqlIdentifierChunk[] {
  const deferred: DeferredSqlIdentifierChunk[] = [];
  for (const chunk of getChunks(fragment)) {
    if (isDeferredIdentifier(chunk)) deferred.push(chunk);
  }
  return deferred;
}

/** @internal The names of a fragment's quoted identifier chunks. */
export function identifierNamesOf(fragment: SqlFragment): readonly string[] {
  const names: string[] = [];
  for (const chunk of getChunks(fragment)) {
    if (chunk.kind === "identifier" && chunk.deferred === undefined)
      names.push(chunk.value);
  }
  return names;
}

/** A rendered statement and its ordered bound parameters. */
export type RenderedSql = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function resolvedPlaceholder(
  placeholder: Placeholder,
  bindings: Readonly<Record<string, unknown>> | undefined,
  dialect: SqlDialect,
): unknown {
  if (bindings === undefined) return placeholder;

  if (!Object.hasOwn(bindings, placeholder.name)) {
    throw new ConfigurationError(
      `Missing binding for parameter "${placeholder.name}"`,
      { parameterName: placeholder.name },
    );
  }
  return bindSqlValue(bindings[placeholder.name], dialect);
}

/**
 * Renders a fragment for a database adapter.
 *
 * Named placeholders remain in `params` when `bindings` is omitted, allowing
 * a prepared template to resolve them later. Passing `bindings` resolves every
 * placeholder eagerly.
 */
export function renderSql(
  fragment: SqlFragment,
  dialect: SqlDialect,
  bindings?: Readonly<Record<string, unknown>>,
): RenderedSql {
  const parts: string[] = [];
  const params: unknown[] = [];
  const profile = getSqlDialectProfile(dialect);

  for (const node of getChunks(fragment)) {
    switch (node.kind) {
      case "text": {
        parts.push(node.value);
        break;
      }
      case "identifier": {
        if (node.deferred !== undefined)
          return throwUnresolvedDeferredIdentifier(node);
        parts.push(quotedIdentifier(node.value));
        break;
      }
      case "parameter": {
        params.push(bindSqlValue(node.value, dialect));
        parts.push(profile.placeholder(params.length));
        break;
      }
      case "placeholder": {
        params.push(resolvedPlaceholder(node.value, bindings, dialect));
        parts.push(profile.placeholder(params.length));
        break;
      }
      default: {
        throwUnsupportedSqlChunk(node);
      }
    }
  }

  return Object.freeze({
    sql: parts.join(""),
    params: Object.freeze(params),
  });
}

/** Renders a fragment using SQLite's `?` placeholders. */
export function renderSqlite(
  fragment: SqlFragment,
  bindings?: Readonly<Record<string, unknown>>,
): RenderedSql {
  return renderSql(fragment, "sqlite", bindings);
}

/** Renders a fragment using PostgreSQL's numbered placeholders. */
export function renderPostgres(
  fragment: SqlFragment,
  bindings?: Readonly<Record<string, unknown>>,
): RenderedSql {
  return renderSql(fragment, "postgres", bindings);
}

function inlineLiteral(value: unknown, dialect: SqlDialect): string {
  if (value === undefined || value === null) return "NULL";
  if (typeof value === "string") return inlineSqlStringLiteral(value, dialect);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ConfigurationError("Cannot inline a non-finite SQL number", {
        value,
      });
    }
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") {
    return getSqlDialectProfile(dialect).booleanLiteralString(value);
  }
  if (value instanceof Date) {
    return inlineSqlStringLiteral(value.toISOString(), dialect);
  }

  throw new ConfigurationError("Cannot inline this SQL parameter value", {
    value,
  });
}

/**
 * Renders a fragment with safe scalar literals instead of bound parameters.
 *
 * This is intentionally limited to DDL paths whose drivers cannot bind values.
 * Application queries should always use {@link renderSql}.
 */
export function renderSqlInline(
  fragment: SqlFragment,
  dialect: SqlDialect,
): string {
  const parts: string[] = [];

  for (const node of getChunks(fragment)) {
    switch (node.kind) {
      case "text": {
        parts.push(node.value);
        break;
      }
      case "identifier": {
        if (node.deferred !== undefined)
          return throwUnresolvedDeferredIdentifier(node);
        parts.push(quotedIdentifier(node.value));
        break;
      }
      case "parameter": {
        parts.push(inlineLiteral(node.value, dialect));
        break;
      }
      case "placeholder": {
        throw new ConfigurationError(
          `Cannot inline unresolved SQL placeholder "${node.value.name}"`,
          { parameterName: node.value.name },
        );
      }
      default: {
        throwUnsupportedSqlChunk(node);
      }
    }
  }

  return parts.join("");
}
