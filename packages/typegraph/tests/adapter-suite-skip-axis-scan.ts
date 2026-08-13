/**
 * The AST scan of `tests/backends/adapter-test-suite.ts`'s three skip axes:
 * member-presence guards (`if (backend.X === undefined) return;`, singly or
 * `||`-joined into a conjunction), the `skipRawQueries` suite option, and the
 * transaction group's calls, which are unguarded by any member check because
 * `transaction` is a required `GraphBackend` member.
 *
 * `tests/adapter-suite-skip-axes.test.ts` records today's population as a
 * ratchet; `tests/reference/member-inventory.test.ts` (B5) imports THIS
 * module rather than re-implementing the scan, so the guard population has
 * one owner across both consumers.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

/** One member-presence guard: the compared members, and whether they are `||`-joined. */
export type MemberGuard = Readonly<{
  line: number;
  members: readonly string[];
  form: "single" | "conjunction";
}>;

/** The full skip-axis population of the adapter suite. */
export type SkipAxisInventory = Readonly<{
  guards: readonly MemberGuard[];
  /** 1-indexed lines where the `skipRawQueries` identifier occurs. */
  optionAxisSites: readonly number[];
  /**
   * 1-indexed lines where a capability MEMBER is read off
   * `backend.capabilities` — a further property/element access chained off
   * it (`.returning`, `?.returning`, `["returning"]`), or a destructuring
   * binding (`const { returning } = backend.capabilities;`). AST-scanned
   * (property access off `backend.capabilities`), not a `capabilities.`
   * substring match: `backend.capabilities?.returning` and
   * `const { returning } = backend.capabilities;` both read a capability
   * member without ever spelling the literal substring `capabilities.`.
   */
  capabilityReadLines: readonly number[];
  /** 1-indexed lines of every `backend.transaction(` call. */
  unguardedTransactionCallLines: readonly number[];
}>;

const ADAPTER_SUITE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "backends/adapter-test-suite.ts",
);

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

/** Flattens a chain of `||`-joined expressions into its leaves, left to right. */
function flattenLogicalOr(expression: ts.Expression): readonly ts.Expression[] {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
  ) {
    return [
      ...flattenLogicalOr(expression.left),
      ...flattenLogicalOr(expression.right),
    ];
  }
  return [expression];
}

/** If `expression` is `backend.<member> === undefined` (either operand order), the member name. */
function memberUndefinedComparison(
  expression: ts.Expression,
): string | undefined {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return undefined;
  }
  const { left, right } = expression;
  const memberAccess =
    ts.isPropertyAccessExpression(left) ? left
    : ts.isPropertyAccessExpression(right) ? right
    : undefined;
  const otherSide = memberAccess === left ? right : left;
  if (memberAccess === undefined) return undefined;
  if (
    !ts.isIdentifier(memberAccess.expression) ||
    memberAccess.expression.text !== "backend"
  ) {
    return undefined;
  }
  if (!ts.isIdentifier(otherSide) || otherSide.text !== "undefined")
    return undefined;
  return memberAccess.name.text;
}

/** Whether a statement is a bare `return;` — directly, or as a block's sole statement. */
function isBareReturn(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement))
    return statement.expression === undefined;
  if (ts.isBlock(statement) && statement.statements.length === 1) {
    const [onlyStatement] = statement.statements;
    return (
      onlyStatement !== undefined &&
      ts.isReturnStatement(onlyStatement) &&
      onlyStatement.expression === undefined
    );
  }
  return false;
}

function scanMemberGuards(sourceFile: ts.SourceFile): MemberGuard[] {
  const guards: MemberGuard[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isIfStatement(node) &&
      node.elseStatement === undefined &&
      isBareReturn(node.thenStatement)
    ) {
      const leaves = flattenLogicalOr(node.expression);
      const members = leaves.map((leaf) => memberUndefinedComparison(leaf));
      if (
        members.length > 0 &&
        members.every((member) => member !== undefined)
      ) {
        guards.push({
          line: lineOf(sourceFile, node.expression),
          members: members,
          form: members.length > 1 ? "conjunction" : "single",
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return guards;
}

function scanOptionAxisSites(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = [];

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === "skipRawQueries") {
      lines.push(lineOf(sourceFile, node));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return lines;
}

/** Whether `expression` is exactly `backend.capabilities`, optional-chained or not. */
function isCapabilitiesExpression(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "backend" &&
    expression.name.text === "capabilities"
  );
}

function scanCapabilityReadLines(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      isCapabilitiesExpression(node.expression)
    ) {
      lines.push(lineOf(sourceFile, node));
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isObjectBindingPattern(node.name) &&
      isCapabilitiesExpression(node.initializer)
    ) {
      lines.push(lineOf(sourceFile, node));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return lines;
}

function scanTransactionCallLines(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "backend" &&
      node.expression.name.text === "transaction"
    ) {
      lines.push(lineOf(sourceFile, node));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return lines;
}

/** The adapter suite's full skip-axis inventory, scanned fresh from its source. */
export function scanAdapterSuiteSkipAxes(): SkipAxisInventory {
  const text = fs.readFileSync(ADAPTER_SUITE_PATH, "utf8");
  const sourceFile = ts.createSourceFile(
    ADAPTER_SUITE_PATH,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  return {
    guards: scanMemberGuards(sourceFile),
    optionAxisSites: scanOptionAxisSites(sourceFile),
    capabilityReadLines: scanCapabilityReadLines(sourceFile),
    unguardedTransactionCallLines: scanTransactionCallLines(sourceFile),
  };
}
