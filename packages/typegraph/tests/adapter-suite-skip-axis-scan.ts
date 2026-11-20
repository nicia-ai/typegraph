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
 *
 * The capability-read axis resolves receivers, not just one spelling of
 * `backend.capabilities`: a local bound directly to `backend.capabilities`
 * (`const caps = backend.capabilities;`) or destructured off `backend` under
 * the name `capabilities` (`const { capabilities } = backend;`) is tracked as
 * an alias, and a property/element access chained off that alias counts as a
 * capability read too — otherwise the ratchet trades one evasion spelling for
 * another instead of closing the axis.
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
   * binding (`const { returning } = backend.capabilities;`) — or off a LOCAL
   * ALIAS of `backend.capabilities`, however that alias was bound: a direct
   * assignment (`const caps = backend.capabilities;`) or a destructure of the
   * `capabilities` property off `backend` (`const { capabilities } =
   * backend;`). AST-scanned (property/element access resolved back to
   * `backend.capabilities`, through at most one local alias), not a
   * `capabilities.` substring match: `backend.capabilities?.returning`,
   * `const { returning } = backend.capabilities;`, `const { capabilities } =
   * backend; capabilities.returning`, and `const caps = backend.capabilities;
   * caps.returning` all read a capability member, and none of them is caught
   * by matching the literal substring `capabilities.` alone.
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

/**
 * Collects the names of local bindings that alias `backend.capabilities`,
 * however they were bound: a direct assignment (`const caps =
 * backend.capabilities;`) or a destructure of the `capabilities` property off
 * `backend` (`const { capabilities } = backend;`, or renamed — `const {
 * capabilities: caps } = backend;`). A property/element access chained off
 * one of these names is a capability read exactly as if it were chained off
 * `backend.capabilities` directly.
 */
function collectCapabilityAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (
        ts.isIdentifier(node.name) &&
        isCapabilitiesExpression(node.initializer)
      ) {
        aliases.add(node.name.text);
      } else if (
        ts.isObjectBindingPattern(node.name) &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === "backend"
      ) {
        for (const element of node.name.elements) {
          const sourcePropertyName =
            (
              element.propertyName !== undefined &&
              ts.isIdentifier(element.propertyName)
            ) ?
              element.propertyName.text
            : ts.isIdentifier(element.name) ? element.name.text
            : undefined;
          if (
            sourcePropertyName === "capabilities" &&
            ts.isIdentifier(element.name)
          ) {
            aliases.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return aliases;
}

/** Whether `expression` resolves to `backend.capabilities`, directly or through one local alias. */
function isCapabilitiesReceiver(
  expression: ts.Expression,
  aliases: ReadonlySet<string>,
): boolean {
  if (isCapabilitiesExpression(expression)) return true;
  return ts.isIdentifier(expression) && aliases.has(expression.text);
}

/**
 * Scans arbitrary TypeScript source text for capability-member reads,
 * exported so the receiver-resolution behavior (direct, optional-chained,
 * destructured, or through a local alias) can be unit-tested against a
 * fixture directly, independent of `tests/backends/adapter-test-suite.ts`'s
 * real, line-pinned contents.
 */
export function scanCapabilityReadLinesFromSource(
  text: string,
): readonly number[] {
  const sourceFile = ts.createSourceFile(
    "fixture.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return scanCapabilityReadLines(sourceFile);
}

function scanCapabilityReadLines(sourceFile: ts.SourceFile): number[] {
  const aliases = collectCapabilityAliases(sourceFile);
  const lines: number[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      isCapabilitiesReceiver(node.expression, aliases)
    ) {
      lines.push(lineOf(sourceFile, node));
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isObjectBindingPattern(node.name) &&
      isCapabilitiesReceiver(node.initializer, aliases)
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
