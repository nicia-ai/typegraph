import { ConfigurationError } from "../errors";
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
}>;

export type SqlPlaceholderChunk = Readonly<{
  kind: "placeholder";
  value: Placeholder;
}>;

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
      chunks.push(...getChunks(value));
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
    if (index > 0) chunks.push(...getChunks(separator));
    chunks.push(...getChunks(fragment));
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
