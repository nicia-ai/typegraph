/**
 * The owner of query-generated SQL identifiers (`src/query/generated-identifier.ts`)
 * and the ratchet that keeps it the only owner.
 *
 * PostgreSQL clips identifiers to 63 bytes. Every name the query layer builds
 * from caller text passes through the owner: a name that fits is emitted
 * verbatim, and a longer one is allocated a physical name per statement that
 * no other name in that statement holds. A second, inline spelling of
 * `${alias}_id` or `lm_${alias}` would compile or decode a name the owner
 * never allocated — the shape of the defect that made long aliases collide on
 * PostgreSQL while running on SQLite.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { createQueryBuilder } from "../src/query";
import { compileQuery } from "../src/query/compiler/index";
import {
  aliasColumnName,
  aliasCteName,
  aliasTableName,
  bindGeneratedIdentifiers,
  generatedColumnName,
  generatedColumnsOf,
  generatedIdentifier,
  restoreGeneratedColumns,
  sealGeneratedIdentifiers,
  shortenedIdentifier,
} from "../src/query/generated-identifier";
import { renderSqlite, sql } from "../src/query/sql-fragment";
import { buildKindRegistry } from "../src/registry";

const MAX_IDENTIFIER_BYTES = 63;

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Every distinct name a rendered statement spells in double quotes or bare. */
function emittedNames(text: string, pattern: RegExp): string[] {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))]
    .filter((name): name is string => name !== undefined)
    .toSorted();
}

/** Renders `parts` as one sealed statement, the way the compiler emits it. */
function sealedText(...parts: readonly string[]): string {
  return renderSqlite(
    sealGeneratedIdentifiers(
      sql.join(
        parts.map((part) => sql.raw(part)),
        sql`, `,
      ),
    ),
  ).sql;
}

const LONG_ALIAS = `a${"b".repeat(62)}`;
const NODE_COLUMNS = [
  "id",
  "kind",
  "props",
  "version",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
  "from_id",
  "to_id",
];

describe("generatedIdentifier", () => {
  it("returns every name of at most 63 bytes verbatim", () => {
    for (const name of [
      "p_id",
      "cte_p",
      `a${"b".repeat(62)}`,
      `a${"b".repeat(49)}_${"é".repeat(6)}`,
    ]) {
      expect(utf8ByteLength(name)).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
      expect(generatedIdentifier(name)).toBe(name);
    }
  });

  it("names a longer name logically, for the statement to allocate", () => {
    const name = aliasColumnName(LONG_ALIAS, "id");

    // Not a usable identifier until a statement allocates it.
    expect(name).not.toMatch(/^\w+$/u);
    expect(sealedText(name)).not.toBe(`${LONG_ALIAS}_id`);
    expect(utf8ByteLength(sealedText(name))).toBeLessThanOrEqual(
      MAX_IDENTIFIER_BYTES,
    );
    // The same logical name is the same logical token every time.
    expect(aliasColumnName(LONG_ALIAS, "id")).toBe(name);
  });

  it("bounds a name that is under 63 characters but over 63 bytes", () => {
    const name = `a${"b".repeat(50)}_${"é".repeat(7)}`;
    expect(name.length).toBeLessThan(MAX_IDENTIFIER_BYTES);
    expect(utf8ByteLength(name)).toBeGreaterThan(MAX_IDENTIFIER_BYTES);

    const emitted = sealedText(
      `"${generatedIdentifier(name)}"`,
      `"${generatedIdentifier(`a${"b".repeat(50)}_${"é".repeat(6)}`)}"`,
    );
    const names = emittedNames(emitted, /"([^"]+)"/gu);

    expect(names).toHaveLength(2);
    for (const emittedName of names) {
      expect(utf8ByteLength(emittedName)).toBeLessThanOrEqual(
        MAX_IDENTIFIER_BYTES,
      );
      expect(emittedName).not.toContain("�");
    }
  });
});

describe("sealGeneratedIdentifiers", () => {
  it("returns a statement without long names unchanged", () => {
    const statement = sql`SELECT ${sql.raw(aliasColumnName("p", "id"))} FROM ${sql.raw(aliasCteName("p"))}`;

    expect(sealGeneratedIdentifiers(statement)).toBe(statement);
    expect(generatedColumnsOf(statement).size).toBe(0);
  });

  it("keeps names sharing a 63-byte prefix distinct and within the limit", () => {
    const columns = NODE_COLUMNS.map((column) =>
      aliasColumnName(LONG_ALIAS, column),
    );
    const names = sealedText(...columns).split(", ");

    expect(new Set(names).size).toBe(NODE_COLUMNS.length);
    for (const name of names) {
      expect(utf8ByteLength(name)).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
      expect(name).toMatch(/^\w+$/u);
    }
  });

  it("emits two CTE names that fit in 63 bytes and differ", () => {
    const LongAliasNode = defineNode("LongAliasNode", {
      schema: z.object({ name: z.string() }),
    });
    const link = defineEdge("link");
    const graph = defineGraph({
      id: "generated_identifier_graph",
      nodes: { LongAliasNode: { type: LongAliasNode } },
      edges: {
        link: { type: link, from: [LongAliasNode], to: [LongAliasNode] },
      },
    });
    const first = `${LONG_ALIAS.slice(0, -1)}x` as "first";
    const second = `${LONG_ALIAS.slice(0, -1)}y` as "second";

    const ast = createQueryBuilder<typeof graph>(
      graph.id,
      buildKindRegistry(graph),
    )
      .from("LongAliasNode", first)
      .traverse("link", "e")
      .to("LongAliasNode", second)
      .select((ctx) => ({ from: ctx[first].name, to: ctx[second].name }))
      .toAst();
    const text = renderSqlite(compileQuery(ast, graph.id)).sql;
    const cteNames = emittedNames(text, /(?:^|[\s,])(cte_\w+) AS/gu);

    expect(cteNames).toHaveLength(2);
    for (const name of cteNames) {
      expect(utf8ByteLength(name)).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    }
    expect(cteNames[0]).not.toBe(cteNames[1]);
    // Each still identifies its alias by its leading bytes.
    expect(cteNames.every((name) => name.startsWith("cte_abbb"))).toBe(true);
  });

  it("never hands a long name the physical name a fitting one already owns", () => {
    const longName = `cte_${LONG_ALIAS}`;
    const firstChoice = shortenedIdentifier(longName);
    expect(utf8ByteLength(firstChoice)).toBeLessThanOrEqual(
      MAX_IDENTIFIER_BYTES,
    );

    // The fitting name is emitted verbatim whether it is used before or
    // after the long one; the long one moves to its next candidate.
    for (const order of [
      [firstChoice, generatedIdentifier(longName)],
      [generatedIdentifier(longName), firstChoice],
    ]) {
      const names = sealedText(...order).split(", ");
      expect(names).toContain(firstChoice);
      expect(new Set(names).size).toBe(2);
      expect(names).toContain(shortenedIdentifier(longName, 1));
    }
  });

  it("allocates deterministically from the statement's names", () => {
    const parts = NODE_COLUMNS.map((column) =>
      aliasColumnName(LONG_ALIAS, column),
    );
    expect(sealedText(...parts)).toBe(sealedText(...parts));
    expect(sealedText(aliasTableName(LONG_ALIAS))).toBe(
      shortenedIdentifier(`lm_${LONG_ALIAS}`),
    );
  });

  it("re-keys rows and binds wrappers to the names it allocated", () => {
    const column = aliasColumnName(LONG_ALIAS, "id");
    const statement = sealGeneratedIdentifiers(
      sql`SELECT 1 AS ${sql.identifier(column)}`,
    );
    const physical = generatedColumnName(statement, column);

    expect(renderSqlite(statement).sql).toBe(`SELECT 1 AS "${physical}"`);
    expect(
      restoreGeneratedColumns(
        [{ [physical]: "x", other: 1 }],
        generatedColumnsOf(statement),
      ),
    ).toEqual([{ [column]: "x", other: 1 }]);
    expect(
      renderSqlite(
        bindGeneratedIdentifiers(
          sql`SELECT ${sql.identifier(column)} FROM (${statement}) AS s`,
          statement,
        ),
      ).sql,
    ).toBe(`SELECT "${physical}" FROM (SELECT 1 AS "${physical}") AS s`);
    expect(() =>
      generatedColumnName(statement, aliasColumnName(LONG_ALIAS, "kind")),
    ).toThrow(/never allocated/u);
  });
});

// ============================================================
// Ratchet: no inline spelling of an alias-derived identifier
// ============================================================

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SOURCE_ROOT = path.join(PACKAGE_ROOT, "src");
const OWNER_FILE = path.join(SOURCE_ROOT, "query", "generated-identifier.ts");

/**
 * Concatenations of an alias with other text that build something other than
 * a SQL name. Each entry is a file and the exact source text of the
 * expression.
 */
const NON_IDENTIFIER_SPELLINGS: readonly Readonly<{
  file: string;
  expression: string;
  reason: string;
}>[] = [
  {
    file: "query/builder/validation.ts",
    expression: "`${nodeAlias}_${suffix}`",
    reason:
      "derivedAlias: a logical result key; SQL built from it goes through the owner",
  },
  {
    file: "query/execution/selective-result-mapper.ts",
    expression: "`${alias}_${metaKey}`",
    reason: "a label in a timestamp-decoding error message",
  },
];

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

/** The functions the owner exports; a call to one yields a finished name. */
const OWNER_FUNCTIONS = new Set(
  [
    ...fs
      .readFileSync(OWNER_FILE, "utf8")
      .matchAll(/^export function (\w+)/gmu),
  ].map((match) => match[1]),
);

/**
 * Whether an expression evaluates to a finished name rather than raw alias
 * text: a call to the owner, or a quoted identifier, which SQL cannot extend.
 */
function isFinishedName(expression: ts.Node, file: ts.SourceFile): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression.getText(file);
  return (
    OWNER_FUNCTIONS.has(callee) ||
    callee === "sql.identifier" ||
    callee === "quoteIdentifier"
  );
}

/** Whether an expression names a query alias. */
function namesAlias(expression: ts.Node, file: ts.SourceFile): boolean {
  return (
    /alias/iu.test(expression.getText(file)) &&
    !isFinishedName(expression, file)
  );
}

/** Text that continues an identifier when written directly against one. */
const IDENTIFIER_JUNCTION_END = /[\p{L}\p{N}_$]$/u;
const IDENTIFIER_JUNCTION_START = /^[\p{L}\p{N}_$]/u;

/** Whether the expression is passed straight to the owner. */
function isOwnerArgument(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === "generatedIdentifier"
  );
}

/**
 * Whether a template glues an alias substitution directly to identifier text
 * or to another substitution — `${alias}_id`, `lm_${alias}`,
 * `${PREFIX}${alias}`, `${alias}${SUFFIX}` — rather than separating it with
 * SQL punctuation (`.`, `"`, a space).
 */
function templateConcatenatesAlias(
  node: ts.TemplateExpression,
  source: ts.SourceFile,
): boolean {
  const literals = [
    node.head.text,
    ...node.templateSpans.map((span) => span.literal.text),
  ];
  return node.templateSpans.some((span, index) => {
    if (!namesAlias(span.expression, source)) return false;
    const before = literals[index] ?? "";
    const after = literals[index + 1] ?? "";
    const gluedBefore =
      IDENTIFIER_JUNCTION_END.test(before) || (before === "" && index > 0);
    const gluedAfter =
      IDENTIFIER_JUNCTION_START.test(after) ||
      (after === "" && index < node.templateSpans.length - 1);
    return gluedBefore || gluedAfter;
  });
}

/** The operands of a `+` chain, left to right. */
function concatenationOperands(node: ts.Expression): ts.Expression[] {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return [
      ...concatenationOperands(node.left),
      ...concatenationOperands(node.right),
    ];
  }
  return [node];
}

/**
 * Whether a `+` chain or `.concat()` call glues an alias directly to
 * identifier text or to another operand (`"lm_" + alias`, `alias + "_id"`).
 */
function operandsConcatenateAlias(
  operands: readonly ts.Expression[],
  source: ts.SourceFile,
): boolean {
  return operands.some((operand, index) => {
    // Literal and template operands are text, not an alias value; a template
    // that splices an alias is checked as a template.
    if (
      ts.isStringLiteralLike(operand) ||
      ts.isTemplateExpression(operand) ||
      !namesAlias(operand, source)
    )
      return false;
    const before = operands[index - 1];
    const after = operands[index + 1];
    return (
      (before !== undefined && operandEndsGlued(before)) ||
      (after !== undefined && operandStartsGlued(after))
    );
  });
}

/** Whether text concatenated after `operand` continues an identifier. */
function operandEndsGlued(operand: ts.Expression): boolean {
  if (ts.isStringLiteralLike(operand))
    return IDENTIFIER_JUNCTION_END.test(operand.text);
  if (ts.isTemplateExpression(operand)) {
    const tail = operand.templateSpans.at(-1)?.literal.text ?? "";
    return tail === "" || IDENTIFIER_JUNCTION_END.test(tail);
  }
  return true;
}

/** Whether `operand` continues an identifier written just before it. */
function operandStartsGlued(operand: ts.Expression): boolean {
  if (ts.isStringLiteralLike(operand))
    return IDENTIFIER_JUNCTION_START.test(operand.text);
  if (ts.isTemplateExpression(operand)) {
    const head = operand.head.text;
    return head === "" || IDENTIFIER_JUNCTION_START.test(head);
  }
  return true;
}

type Spelling = Readonly<{ expression: string; line: number }>;

/** Every expression in `source` that concatenates an alias into a name inline. */
function findInlineAliasSpellings(source: ts.SourceFile): Spelling[] {
  const found: Spelling[] = [];
  function record(node: ts.Node): void {
    found.push({
      expression: node.getText(source),
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  }
  function visit(node: ts.Node): void {
    if (
      ts.isTemplateExpression(node) &&
      !isOwnerArgument(node) &&
      templateConcatenatesAlias(node, source)
    ) {
      record(node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) &&
      !isOwnerArgument(node) &&
      operandsConcatenateAlias(concatenationOperands(node), source)
    ) {
      record(node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "concat" &&
      !isOwnerArgument(node) &&
      operandsConcatenateAlias(
        [node.expression.expression, ...node.arguments],
        source,
      )
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function parse(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
}

/** The prefixes the owner builds alias-derived names with. */
function ownerAliasPrefixes(): string[] {
  const text = fs.readFileSync(OWNER_FILE, "utf8");
  return [...text.matchAll(/const ALIAS_\w+_PREFIX = "([^"]+)";/gu)].map(
    (match) => match[1] ?? "",
  );
}

describe("generated identifier ratchet", () => {
  const spellings = sourceFiles(SOURCE_ROOT)
    .filter((filePath) => filePath !== OWNER_FILE)
    .flatMap((filePath) =>
      findInlineAliasSpellings(
        parse(filePath, fs.readFileSync(filePath, "utf8")),
      ).map((spelling) => ({
        ...spelling,
        file: path.relative(SOURCE_ROOT, filePath),
      })),
    );

  it("finds no alias concatenated into a name outside the owner", () => {
    const unexpected = spellings.filter(
      (spelling) =>
        !NON_IDENTIFIER_SPELLINGS.some(
          (allowed) =>
            allowed.file === spelling.file &&
            allowed.expression === spelling.expression,
        ),
    );
    expect(unexpected).toEqual([]);
  });

  it("has no stale allowlist entry", () => {
    const stale = NON_IDENTIFIER_SPELLINGS.filter(
      (allowed) =>
        !spellings.some(
          (spelling) =>
            spelling.file === allowed.file &&
            spelling.expression === allowed.expression,
        ),
    );
    expect(stale).toEqual([]);
  });

  /** One probe per concatenation form, each of which must be flagged. */
  const FORBIDDEN_FORMS = [
    "const a = `${alias}_id`;",
    "const b = sql`cte_${sql.raw(previousAlias)}.x`;",
    "const c = `${field.alias}_${column}`;",
    "const d = `lm_${alias}`;",
    "const e = `${LATE_MAT_PHYSICAL_ALIAS_PREFIX}${alias}`;",
    "const f = `${nodeAlias}${SUFFIX}`;",
    'const g = "lm_" + alias;',
    'const h = edgeAlias + "_directed_edges";',
    "const i = PREFIX + nodeAlias;",
    "const j = PREFIX.concat(alias);",
  ] as const;

  /** Spellings that join an alias with punctuation or name nothing. */
  const ALLOWED_FORMS = [
    "const k = generatedIdentifier(`${edgeAlias}_directed_edges`);",
    "const l = `${count}_id`;",
    "const m = `${cteAlias}.${column}`;",
    'const n = `Alias "${alias}" is already in use`;',
    'const o = alias + ".id";',
    'const q = `${qualifier}${aliasColumnName(prefix, "id")}`;',
    "const r = sql`${sql.identifier(SOURCE_ALIAS)}${predicate}`;",
  ] as const;

  it("detects every concatenation form it exists to forbid", () => {
    const flagged = findInlineAliasSpellings(
      parse("probe.ts", [...FORBIDDEN_FORMS, ...ALLOWED_FORMS].join("\n")),
    ).map((spelling) => spelling.line);

    expect(flagged).toEqual(FORBIDDEN_FORMS.map((_form, index) => index + 1));
  });

  it("covers every prefix the owner builds names with", () => {
    const prefixes = ownerAliasPrefixes();

    expect(prefixes.toSorted()).toEqual(["cte_", "lm_"]);
    for (const prefix of prefixes) {
      for (const form of [
        `const p = \`${prefix}\${alias}\`;`,
        `const q = "${prefix}" + alias;`,
      ]) {
        expect(findInlineAliasSpellings(parse("prefix.ts", form))).toHaveLength(
          1,
        );
      }
    }
  });
});
