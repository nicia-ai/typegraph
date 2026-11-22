/**
 * The structural gate over the standard emitter's column reads: the by-name
 * column references a statement's SQL text contains must EQUAL the reads the
 * statement recorded, per relation. A reference the text makes that was not
 * recorded is a missed read (the guard cannot see a collision it reads); a
 * recorded read the text does not make is a phantom read (the guard refuses a
 * statement for a collision it never reads).
 *
 * The text side is computed from the rendered SQL alone:
 *
 * - a qualified reference `R.N` (either part may be quoted) counts when `R` is
 *   a relation of the statement's WITH list; `R.*` counts as `N = "*"`;
 * - an unqualified identifier counts when it is a column name some relation
 *   of the statement declares, it is not part of a qualified reference, and
 *   it does not follow `AS` (a declaration). The text does not say which
 *   relation an unqualified name resolves in, so these are compared by name;
 * - `SELECT *` counts as a read of every column.
 *
 * String literals are skipped.
 */
import type { SqlStatementNames } from "../src/query/compiler/sql-name-registry";

type Token = Readonly<{
  kind: "word" | "quoted" | "dot" | "star" | "other";
  value: string;
}>;

function tokenize(text: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text.charAt(index);
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      let value = "";
      index += 1;
      while (index < text.length) {
        const next = text.charAt(index);
        if (next === character) {
          if (text.charAt(index + 1) === character) {
            value += character;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += next;
        index += 1;
      }
      if (character === '"') tokens.push({ kind: "quoted", value });
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(text.slice(index));
    if (word !== null) {
      tokens.push({ kind: "word", value: word[0] });
      index += word[0].length;
      continue;
    }
    const number = /^[0-9][0-9A-Za-z_]*/u.exec(text.slice(index));
    if (number !== null) {
      tokens.push({ kind: "other", value: number[0] });
      index += number[0].length;
      continue;
    }
    tokens.push({
      kind:
        character === "." ? "dot"
        : character === "*" ? "star"
        : "other",
      value: character,
    });
    index += 1;
  }
  return tokens;
}

function isName(token: Token | undefined): boolean {
  return token?.kind === "word" || token?.kind === "quoted";
}

/** The column references of one statement: qualified per relation, unqualified by name. */
export type ColumnReferenceSet = Readonly<{
  qualified: Readonly<Record<string, readonly string[]>>;
  unqualified: readonly string[];
  selectStar: boolean;
}>;

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted();
}

function freeze(
  qualified: Map<string, Set<string>>,
  unqualified: Set<string>,
  selectStar: boolean,
): ColumnReferenceSet {
  return {
    qualified: Object.fromEntries(
      [...qualified.keys()]
        .toSorted()
        .map((relation) => [relation, sorted(qualified.get(relation) ?? [])]),
    ),
    unqualified: sorted(unqualified),
    selectStar,
  };
}

function addTo(map: Map<string, Set<string>>, key: string, value: string) {
  const existing = map.get(key) ?? new Set<string>();
  existing.add(value);
  map.set(key, existing);
}

/** The column references a statement's rendered SQL text makes. */
export function textColumnReferences(
  text: string,
  names: SqlStatementNames,
): ColumnReferenceSet {
  const relations = new Set(
    names.relations.entries().map((entry) => entry.name),
  );
  const columnNames = new Set(
    names
      .scopes()
      .filter(({ comparison }) => comparison === "column")
      .flatMap(({ scope }) => scope.entries().map((entry) => entry.name)),
  );
  const tokens = tokenize(text);
  const qualified = new Map<string, Set<string>>();
  const unqualified = new Set<string>();
  let selectStar = false;
  for (const [index, token] of tokens.entries()) {
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const afterNext = tokens[index + 2];
    if (
      token.kind === "star" &&
      previous?.kind === "word" &&
      previous.value.toUpperCase() === "SELECT"
    ) {
      selectStar = true;
      continue;
    }
    if (!isName(token)) continue;
    if (
      next?.kind === "dot" &&
      afterNext !== undefined &&
      (isName(afterNext) || afterNext.kind === "star")
    ) {
      if (relations.has(token.value))
        addTo(qualified, token.value, afterNext.value);
      continue;
    }
    if (previous?.kind === "dot") continue;
    if (previous?.kind === "word" && previous.value.toUpperCase() === "AS")
      continue;
    if (columnNames.has(token.value)) unqualified.add(token.value);
  }
  return freeze(qualified, unqualified, selectStar);
}

/** The column references a statement recorded, in the same shape. */
export function recordedColumnReferences(
  names: SqlStatementNames,
): ColumnReferenceSet {
  const qualified = new Map<string, Set<string>>();
  const unqualified = new Set<string>();
  let selectStar = false;
  for (const read of names.columnReads()) {
    if (read.qualified) {
      for (const relation of read.relations ?? [])
        addTo(qualified, relation, read.name ?? "*");
      continue;
    }
    if (read.name === undefined) selectStar = true;
    else unqualified.add(read.name);
  }
  return freeze(qualified, unqualified, selectStar);
}
