/**
 * The owner of query-generated SQL identifiers (`src/query/generated-identifier.ts`)
 * and the ratchet that keeps it the only owner.
 *
 * PostgreSQL clips identifiers to 63 bytes. Every name the query layer builds
 * from caller text must pass through the owner, which leaves a name that fits
 * untouched and shortens a longer one with a hash of the full name. A second,
 * inline spelling of `${alias}_id` would compile or decode a name the owner
 * never produced — the shape of the defect that made long aliases collide on
 * PostgreSQL while running on SQLite.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  aliasColumnName,
  aliasCteName,
  generatedIdentifier,
} from "../src/query/generated-identifier";

const MAX_IDENTIFIER_BYTES = 63;

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

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

  it("bounds a longer name by bytes and keeps names sharing a 63-byte prefix distinct", () => {
    const alias = `a${"b".repeat(62)}`;
    const columns = [
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
    const names = columns.map((column) => aliasColumnName(alias, column));

    expect(new Set(names).size).toBe(columns.length);
    for (const name of names) {
      expect(utf8ByteLength(name)).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
      // Distinct after PostgreSQL's own clipping, not just as JS strings.
      expect(name).toMatch(/^[\w]+$/u);
    }
    expect(
      new Set(
        names.map((name) =>
          Buffer.from(name, "utf8")
            .subarray(0, MAX_IDENTIFIER_BYTES)
            .toString("utf8"),
        ),
      ).size,
    ).toBe(columns.length);
  });

  it("bounds a name that is under 63 characters but over 63 bytes", () => {
    const name = `a${"b".repeat(50)}_${"é".repeat(7)}`;
    expect(name.length).toBeLessThan(MAX_IDENTIFIER_BYTES);
    expect(utf8ByteLength(name)).toBeGreaterThan(MAX_IDENTIFIER_BYTES);

    const bounded = generatedIdentifier(name);

    expect(bounded).not.toBe(name);
    expect(utf8ByteLength(bounded)).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    expect(bounded).not.toBe(
      generatedIdentifier(`a${"b".repeat(50)}_${"é".repeat(6)}`),
    );
  });

  it("is deterministic, so a query compiles to the same SQL every time", () => {
    const alias = `a${"b".repeat(62)}`;
    expect(aliasColumnName(alias, "valid_from")).toBe(
      aliasColumnName(alias, "valid_from"),
    );
    expect(aliasCteName(`${alias.slice(0, -1)}x`)).not.toBe(
      aliasCteName(`${alias.slice(0, -1)}y`),
    );
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
 * Template literals that spell `<alias>_<suffix>` for a reason other than
 * naming SQL. Each entry is a file and the exact source text of the template.
 */
const NON_IDENTIFIER_SPELLINGS: readonly Readonly<{
  file: string;
  template: string;
  reason: string;
}>[] = [
  {
    file: "query/builder/validation.ts",
    template: "`${nodeAlias}_${suffix}`",
    reason:
      "derivedAlias: a logical result key; SQL built from it goes through the owner",
  },
  {
    file: "query/execution/selective-result-mapper.ts",
    template: "`${alias}_${metaKey}`",
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

/** Whether a substitution's expression names a query alias. */
function namesAlias(expression: ts.Expression, file: ts.SourceFile): boolean {
  return /alias/iu.test(expression.getText(file));
}

/** Whether the template is passed straight to the owner. */
function isOwnerArgument(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === "generatedIdentifier"
  );
}

type Spelling = Readonly<{ template: string; line: number }>;

/** Every template literal in `source` that spells an alias-derived name inline. */
function findInlineAliasSpellings(source: ts.SourceFile): Spelling[] {
  const found: Spelling[] = [];
  function visit(node: ts.Node): void {
    if (ts.isTemplateExpression(node) && !isOwnerArgument(node)) {
      let preceding = node.head.text;
      for (const span of node.templateSpans) {
        const aliasSubstitution = namesAlias(span.expression, source);
        const suffixed = span.literal.text.startsWith("_");
        const ctePrefixed = preceding.endsWith("cte_");
        if (aliasSubstitution && (suffixed || ctePrefixed)) {
          found.push({
            template: node.getText(source),
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
          });
          break;
        }
        preceding = span.literal.text;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function parse(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
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

  it("finds no inline `<alias>_<suffix>` or `cte_<alias>` outside the owner", () => {
    const unexpected = spellings.filter(
      (spelling) =>
        !NON_IDENTIFIER_SPELLINGS.some(
          (allowed) =>
            allowed.file === spelling.file &&
            allowed.template === spelling.template,
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
            spelling.template === allowed.template,
        ),
    );
    expect(stale).toEqual([]);
  });

  it("detects the spellings it exists to forbid", () => {
    const probe = parse(
      "probe.ts",
      [
        "const a = `${alias}_id`;",
        "const b = sql`cte_${sql.raw(previousAlias)}.x`;",
        "const c = `${field.alias}_${column}`;",
        "const d = generatedIdentifier(`${edgeAlias}_directed_edges`);",
        "const e = `${count}_id`;",
      ].join("\n"),
    );
    const flagged = findInlineAliasSpellings(probe).map(
      (spelling) => spelling.template,
    );

    expect(flagged).toEqual([
      "`${alias}_id`",
      "`cte_${sql.raw(previousAlias)}.x`",
      "`${field.alias}_${column}`",
    ]);
  });
});
