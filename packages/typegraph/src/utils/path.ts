/**
 * Path utilities for variable-length traversal results.
 *
 * SQLite doesn't support native arrays, so paths are stored as pipe-delimited
 * strings of escaped tokens: "|id1|id2|id3|". PostgreSQL returns native arrays.
 */
import {
  PG_ARRAY_ELEMENT_ESCAPE,
  PG_ARRAY_ELEMENT_QUOTE,
  PG_ARRAY_END,
  PG_ARRAY_START,
  PG_ARRAY_WHITESPACE,
  PG_PATH_ELEMENT_SEPARATOR,
  SQLITE_PATH_DELIMITER,
  SQLITE_PATH_TOKEN_ESCAPES,
} from "../constants";
import { ConfigurationError } from "../errors";

/**
 * Parses a SQLite path string into an array of node IDs.
 *
 * Each token was escaped by the SQLite dialect's path seams (see
 * {@link SQLITE_PATH_TOKEN_ESCAPES}), so splitting on the delimiter is exact
 * and every token is decoded back to the id verbatim. A walk's path always
 * holds its start token, so `||` is the path of one empty id.
 *
 * @param path - Pipe-delimited path string like "|id1|id2|id3|"
 * @returns Array of node IDs like ["id1", "id2", "id3"]
 *
 * @example
 * parseSqlitePath("|abc|def|ghi|") // ["abc", "def", "ghi"]
 * parseSqlitePath("|single|") // ["single"]
 * parseSqlitePath("|x%7Cy|") // ["x|y"]
 * parseSqlitePath("||") // [""]
 */
export function parseSqlitePath(path: string): readonly string[] {
  if (path.length < 2 * SQLITE_PATH_DELIMITER.length) return [];

  return path
    .slice(SQLITE_PATH_DELIMITER.length, -SQLITE_PATH_DELIMITER.length)
    .split(SQLITE_PATH_DELIMITER)
    .map((token) => decodeSqlitePathToken(token));
}

function decodeSqlitePathToken(token: string): string {
  let decoded = token;
  for (const escape of SQLITE_PATH_TOKEN_ESCAPES.toReversed()) {
    decoded = decoded.replaceAll(escape.encoded, escape.raw);
  }
  return decoded;
}

/**
 * Type guard to check if a value is a SQLite path string.
 * SQLite paths start and end with "|".
 */
export function isSqlitePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(SQLITE_PATH_DELIMITER) &&
    value.endsWith(SQLITE_PATH_DELIMITER)
  );
}

/**
 * Normalizes a path value to an array.
 * - If already an array (PostgreSQL native), returns as-is
 * - If a SQLite path string (|id1|id2|), parses it
 * - If a PostgreSQL text array ({id1,id2}), parses it
 * - Otherwise returns empty array
 */
export function normalizePath(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value as string[];
  }
  if (isSqlitePath(value)) {
    return parseSqlitePath(value);
  }
  if (isPostgresTextArray(value)) {
    return parsePostgresTextArray(value);
  }
  return [];
}

/**
 * Separator woven into the composite `kind || SEP || id` path tokens that a
 * recursive walk able to visit more than one kind uses for cycle detection, so
 * same-id nodes of different kinds stay distinct. {@link assertPathTokenSafeKind}
 * refuses it in node kind names at graph-definition time, so
 * `kind || SEP || id` never collides across distinct (kind, id) pairs the way a
 * printable delimiter could.
 */
export const KIND_QUALIFIED_PATH_TOKEN_SEPARATOR = "\u001F";

/**
 * Refuses a node kind name containing
 * {@link KIND_QUALIFIED_PATH_TOKEN_SEPARATOR}. With it, `("A" + SEP + "B", "c")`
 * and `("A", "B" + SEP + "c")` would spell one path token, and a walk would
 * drop the second node as a revisit.
 */
export function assertPathTokenSafeKind(kind: string): void {
  if (!kind.includes(KIND_QUALIFIED_PATH_TOKEN_SEPARATOR)) return;
  throw new ConfigurationError(
    `Node kind name ${JSON.stringify(kind)} contains U+001F, which TypeGraph reserves for recursive path tokens.`,
    { name: kind },
    {
      suggestion: "Rename it without the U+001F (unit separator) character.",
    },
  );
}

/**
 * The composite `kind + SEP + id` token for one node. Distinct (kind, id)
 * pairs always spell distinct tokens, because node kinds cannot contain the
 * separator ({@link assertPathTokenSafeKind}).
 */
export function kindQualifiedToken(kind: string, id: string): string {
  return `${kind}${KIND_QUALIFIED_PATH_TOKEN_SEPARATOR}${id}`;
}

/**
 * Strips the composite wrapper from kind-qualified recursive path tokens,
 * restoring the bare node ids that the public path contract promises.
 *
 * Splits at the FIRST separator: node kinds cannot contain U+001F (see
 * {@link assertPathTokenSafeKind}), so the first occurrence is always the
 * (kind, id) boundary and everything after it is the id verbatim — including
 * an id that itself contains the separator. Tokens with no separator are
 * returned unchanged.
 */
export function stripKindQualifiedPathTokens(
  path: readonly string[],
): readonly string[] {
  return path.map((token) => stripKindQualifiedPathToken(token));
}

function stripKindQualifiedPathToken(token: string): string {
  const separatorIndex = token.indexOf(KIND_QUALIFIED_PATH_TOKEN_SEPARATOR);
  if (separatorIndex === -1) return token;
  return token.slice(
    separatorIndex + KIND_QUALIFIED_PATH_TOKEN_SEPARATOR.length,
  );
}

/**
 * Type guard for PostgreSQL text array format: {id1,id2,id3}
 */
function isPostgresTextArray(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(PG_ARRAY_START) &&
    value.endsWith(PG_ARRAY_END)
  );
}

/**
 * Parses a one-dimensional PostgreSQL text array literal, as a driver that
 * does not decode arrays returns it: `{id1,id2}`, or `{}` for empty.
 *
 * PostgreSQL double-quotes an element that is empty or holds a separator,
 * brace, quote, backslash or whitespace, and backslash-escapes quotes and
 * backslashes inside the quotes, so `{plain,"a,b","say \"hi\""}` holds three
 * elements. Unquoted elements are taken verbatim minus surrounding whitespace,
 * where whitespace is PostgreSQL's ASCII set ({@link PG_ARRAY_WHITESPACE}), not
 * JavaScript's: PostgreSQL leaves an id ending in U+00A0 unquoted.
 * A path element is a node id or path token and is never SQL NULL, so an
 * unquoted `NULL` cannot occur here.
 */
function parsePostgresTextArray(value: string): readonly string[] {
  const inner = value.slice(PG_ARRAY_START.length, -PG_ARRAY_END.length);
  if (trimPostgresArrayWhitespace(inner) === "") return [];

  const elements: string[] = [];
  let index = 0;
  while (index <= inner.length) {
    const element = readPostgresArrayElement(inner, index);
    elements.push(element.value);
    index = element.end + PG_PATH_ELEMENT_SEPARATOR.length;
  }
  return elements;
}

/**
 * Reads the array element starting at `start` (leading whitespace allowed) and
 * returns its value with the index of the separator, or `inner.length`, that
 * ends it.
 */
function readPostgresArrayElement(
  inner: string,
  start: number,
): Readonly<{ value: string; end: number }> {
  let index = start;
  while (index < inner.length && isPostgresArrayWhitespace(inner[index]))
    index += 1;

  if (inner[index] !== PG_ARRAY_ELEMENT_QUOTE) {
    const separatorIndex = inner.indexOf(PG_PATH_ELEMENT_SEPARATOR, index);
    const end = separatorIndex === -1 ? inner.length : separatorIndex;
    return {
      value: trimPostgresArrayWhitespace(inner.slice(index, end)),
      end,
    };
  }

  const characters: string[] = [];
  index += PG_ARRAY_ELEMENT_QUOTE.length;
  while (index < inner.length && inner[index] !== PG_ARRAY_ELEMENT_QUOTE) {
    if (inner[index] === PG_ARRAY_ELEMENT_ESCAPE) index += 1;
    characters.push(inner[index] ?? "");
    index += 1;
  }
  index += PG_ARRAY_ELEMENT_QUOTE.length;
  const separatorIndex = inner.indexOf(PG_PATH_ELEMENT_SEPARATOR, index);
  return {
    value: characters.join(""),
    end: separatorIndex === -1 ? inner.length : separatorIndex,
  };
}

function isPostgresArrayWhitespace(character: string | undefined): boolean {
  return character !== undefined && PG_ARRAY_WHITESPACE.has(character);
}

function trimPostgresArrayWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isPostgresArrayWhitespace(text[start])) start += 1;
  while (end > start && isPostgresArrayWhitespace(text[end - 1])) end -= 1;
  return text.slice(start, end);
}
