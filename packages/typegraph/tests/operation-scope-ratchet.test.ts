/**
 * THE RATCHET for operation-scoped statement targets
 * (`src/store/operation-scope.ts`).
 *
 * Two invariants, each asserted where ESLint cannot reach:
 *
 * 1. **The brand is minted in one module.** ESLint's
 *    `OPERATION_BRAND_RESTRICTIONS` bans the direct spellings of an assertion
 *    to a brand type. This file fires those selectors at a fixture, and then
 *    scans `src` for every assertion site, including spellings the selectors
 *    cannot see: a local alias of a brand type, a renamed import, or a brand
 *    type argument at a call (`identity<StatementBackend>(raw)`). The scan
 *    must find exactly the two mints, so an inline `eslint-disable` added
 *    anywhere else fails here.
 *
 * 2. **The raw surface only shrinks.** Per store family, the number of
 *    exported functions that still accept a raw `TransactionBackend` for
 *    statement-issuing work. A parameter counts when a raw `TransactionBackend`
 *    is assignable to it (so a structural slice such as `WriteTarget` counts,
 *    not only a parameter that spells the name) and its type exposes at least
 *    one backend member outside the `identity` class of
 *    `GRAPH_BACKEND_MEMBER_CLASSES` (a parameter that can only read the
 *    dialect or table names issues no statement). Each count is pinned
 *    exactly: a family that gains a raw parameter fails, and a change that
 *    narrows one lowers the baseline in the same commit.
 *
 * Why the type checker for (2) rather than a syntax scan: a raw transaction
 * reaches most row helpers through structural slices that never name
 * `TransactionBackend`, so counting the name would undercount by more than
 * half and let a slice-typed parameter slip in unseen.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { OPERATION_BRAND_RESTRICTIONS } from "../eslint.config.mjs";
import { GRAPH_BACKEND_MEMBER_CLASSES } from "../src/backend/member-classes";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SOURCE_ROOT = path.join(PACKAGE_ROOT, "src");
const STORE_ROOT = path.join(SOURCE_ROOT, "store");
const MINT_MODULE = "src/store/operation-scope.ts";

const BRAND_TYPE_NAMES = [
  "OperationScoped",
  "OperationBackend",
  "StatementBackend",
] as const;
const MINT_FUNCTION_NAMES = new Set([
  "enterOperation",
  "scopeWriteFrameTarget",
]);

/** The assertion sites the mint module owns: one per mint. */
const MINT_ASSERTION_SITES = [
  { file: MINT_MODULE, function: "enterOperation" },
  { file: MINT_MODULE, function: "scopeWriteFrameTarget" },
] as const;

/**
 * Store families, matched in order against the path relative to `src/store`;
 * the last entry catches every remaining store module.
 */
const STORE_FAMILIES = [
  { family: "operations/edge", pattern: /^operations\/edge-/ },
  { family: "operations/node", pattern: /^operations\/node-/ },
  { family: "operations/composition", pattern: /^operations\/composition-/ },
  { family: "operations/write", pattern: /^operations\// },
  { family: "recorded-capture", pattern: /^recorded-capture(\.ts$|\/)/ },
  { family: "claims", pattern: /^claims\// },
  { family: "search-sync", pattern: /^(embedding-sync|fulltext-)/ },
  {
    family: "collections",
    pattern: /^(collection-factory\.ts$|collections\/)/,
  },
  { family: "store", pattern: /^/ },
] as const;

type StoreFamily = (typeof STORE_FAMILIES)[number]["family"];

/**
 * Exported functions that accept a raw `TransactionBackend` for
 * statement-issuing work, per family. Each may only ever DECREASE, and the
 * change that narrows a parameter lowers its family here in the same commit.
 * The mint module is excluded: `enterOperation` accepts a raw backend by
 * definition.
 */
const RAW_STATEMENT_TARGET_BASELINE = {
  "operations/edge": 27,
  "operations/node": 41,
  "operations/composition": 16,
  "operations/write": 23,
  "recorded-capture": 51,
  claims: 14,
  "search-sync": 3,
  collections: 2,
  store: 14,
} as const satisfies Record<StoreFamily, number>;

function relativeToPackage(file: string): string {
  return path.relative(PACKAGE_ROOT, file).replaceAll(path.sep, "/");
}

function collectTypeScriptFiles(directory: string): readonly string[] {
  return fs
    .readdirSync(directory, { encoding: "utf8", recursive: true })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(directory, entry))
    .toSorted();
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
}

function referencedTypeName(node: ts.TypeReferenceNode): string {
  return ts.isIdentifier(node.typeName) ?
      node.typeName.text
    : node.typeName.right.text;
}

/** Whether `node` spells a brand type, a local alias of one, or `typeof` a mint. */
function mentionsBrand(
  node: ts.Node,
  brandNames: ReadonlySet<string>,
): boolean {
  if (
    ts.isTypeReferenceNode(node) &&
    brandNames.has(referencedTypeName(node))
  ) {
    return true;
  }
  // `import("./operation-scope").StatementBackend`
  if (
    ts.isImportTypeNode(node) &&
    node.qualifier !== undefined &&
    brandNames.has(
      ts.isIdentifier(node.qualifier) ?
        node.qualifier.text
      : node.qualifier.right.text,
    )
  ) {
    return true;
  }
  if (
    ts.isTypeQueryNode(node) &&
    ts.isIdentifier(node.exprName) &&
    MINT_FUNCTION_NAMES.has(node.exprName.text)
  ) {
    return true;
  }
  return (
    ts.forEachChild(
      node,
      (child) => mentionsBrand(child, brandNames) || undefined,
    ) ?? false
  );
}

/**
 * The brand type names plus every name in `src` that can stand for one: a
 * type alias or interface whose declaration mentions a brand type, and a
 * renamed import of one. Closed to a fixed point, by name, so a chain of
 * aliases across modules is followed. A same-named unrelated type would be
 * swept in too; that fails loudly as an extra site rather than hiding one.
 *
 * The trees are walked once to collect the declarations that can introduce a
 * name; the fixed point iterates over that short list, not over every tree.
 */
function brandNameClosure(
  sources: readonly ts.SourceFile[],
): ReadonlySet<string> {
  const declarations: (
    ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ImportSpecifier
  )[] = [];
  for (const source of sources) {
    const collect = (node: ts.Node): void => {
      if (
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        (ts.isImportSpecifier(node) && node.propertyName !== undefined)
      ) {
        declarations.push(node);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
  }

  function introducesBrandName(
    declaration: (typeof declarations)[number],
    names: ReadonlySet<string>,
  ): boolean {
    if (names.has(declaration.name.text)) return false;
    return ts.isImportSpecifier(declaration) ?
        names.has(declaration.propertyName?.text ?? "")
      : mentionsBrand(declaration, names);
  }

  const names = new Set<string>(BRAND_TYPE_NAMES);
  for (;;) {
    const added = declarations.filter((declaration) =>
      introducesBrandName(declaration, names),
    );
    if (added.length === 0) return names;
    for (const declaration of added) names.add(declaration.name.text);
  }
}

type AssertionSite = Readonly<{ file: string; function: string }>;

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; ; current = current.parent) {
    if (ts.isSourceFile(current)) return "<module>";
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return current.name.text;
    }
  }
}

/**
 * Every place in `src` that produces a branded value from an unbranded one:
 * an `as` / angle-bracket assertion to a type that mentions a brand, and a
 * call or construction whose explicit type arguments mention one.
 */
function brandAssertionSites(): readonly AssertionSite[] {
  const sources = collectTypeScriptFiles(SOURCE_ROOT).map((file) =>
    parse(file),
  );
  const brandNames = brandNameClosure(sources);
  const sites: AssertionSite[] = [];
  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      const assertedType =
        ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ?
          node.type
        : undefined;
      const typeArguments =
        ts.isCallExpression(node) || ts.isNewExpression(node) ?
          node.typeArguments
        : undefined;
      if (
        (assertedType !== undefined &&
          mentionsBrand(assertedType, brandNames)) ||
        (typeArguments?.some((argument) =>
          mentionsBrand(argument, brandNames),
        ) ??
          false)
      ) {
        sites.push({
          file: relativeToPackage(source.fileName),
          function: enclosingFunctionName(node),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

function storeFamilyOf(file: string): StoreFamily {
  const relative = path.relative(STORE_ROOT, file).replaceAll(path.sep, "/");
  const match = STORE_FAMILIES.find((entry) => entry.pattern.test(relative));
  if (match === undefined) throw new Error(`no store family for ${relative}`);
  return match.family;
}

/** Backend members that issue a statement: every class but `identity`. */
const STATEMENT_MEMBER_NAMES: ReadonlySet<string> = new Set(
  Object.entries(GRAPH_BACKEND_MEMBER_CLASSES)
    .filter(([memberClass]) => memberClass !== "identity")
    .flatMap(([, members]) => [...members]),
);

type RawStatementTarget = Readonly<{
  family: StoreFamily;
  file: string;
  function: string;
}>;

/**
 * Exported functions in `src/store` with a parameter that accepts a raw
 * `TransactionBackend` and exposes a statement-issuing member. A parameter a
 * `number` is also assignable to (`unknown`, an unconstrained generic's
 * erasure) is not a backend parameter and is skipped.
 */
function rawStatementTargets(): readonly RawStatementTarget[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(PACKAGE_ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (parsed === undefined) throw new Error("tsconfig.json did not parse");
  const storeFiles = parsed.fileNames
    .map((file) => path.resolve(file))
    .filter((file) => file.startsWith(STORE_ROOT + path.sep));
  const program = ts.createProgram({
    rootNames: storeFiles,
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();

  const backendTypes = program.getSourceFile(
    path.join(SOURCE_ROOT, "backend", "types.ts"),
  );
  const backendModule =
    backendTypes === undefined ? undefined : (
      checker.getSymbolAtLocation(backendTypes)
    );
  const transactionBackendSymbol =
    backendModule === undefined ? undefined : (
      checker
        .getExportsOfModule(backendModule)
        .find((symbol) => symbol.name === "TransactionBackend")
    );
  if (transactionBackendSymbol === undefined) {
    throw new Error("TransactionBackend not found in src/backend/types.ts");
  }
  const rawTransaction = checker.getDeclaredTypeOfSymbol(
    transactionBackendSymbol,
  );
  const numberType = checker.getNumberType();

  function acceptsRawStatementTarget(
    parameter: ts.ParameterDeclaration,
  ): boolean {
    const parameterType = checker.getTypeAtLocation(parameter);
    if (checker.isTypeAssignableTo(numberType, parameterType)) return false;
    if (!checker.isTypeAssignableTo(rawTransaction, parameterType))
      return false;
    return checker
      .getPropertiesOfType(checker.getNonNullableType(parameterType))
      .some((property) => STATEMENT_MEMBER_NAMES.has(property.name));
  }

  const found: RawStatementTarget[] = [];
  for (const file of storeFiles) {
    if (relativeToPackage(file) === MINT_MODULE) continue;
    const source = program.getSourceFile(file);
    if (source === undefined) continue;
    for (const statement of source.statements) {
      if (
        !ts.isFunctionDeclaration(statement) ||
        statement.name === undefined ||
        statement.body === undefined ||
        !(ts.getModifiers(statement) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        continue;
      }
      if (
        statement.parameters.some((parameter) =>
          acceptsRawStatementTarget(parameter),
        )
      ) {
        found.push({
          family: storeFamilyOf(file),
          file: relativeToPackage(file),
          function: statement.name.text,
        });
      }
    }
  }
  return found;
}

function countByFamily(
  targets: readonly RawStatementTarget[],
): Record<StoreFamily, number> {
  const counts = Object.fromEntries(
    STORE_FAMILIES.map((entry) => [entry.family, 0]),
  ) as Record<StoreFamily, number>;
  for (const target of targets) counts[target.family] += 1;
  return counts;
}

const eslint = new ESLint({ cwd: PACKAGE_ROOT });

/** A `src/store` module whose path the fixture borrows; its content is never linted. */
const BORROWED_STORE_PATH = "src/store/edge-fetch.ts";

const OPERATION_BRAND_MESSAGES = new Set(
  OPERATION_BRAND_RESTRICTIONS.map((restriction) => restriction.message),
);

async function brandReportLines(source: string): Promise<readonly number[]> {
  const results = await eslint.lintText(source, {
    filePath: path.join(PACKAGE_ROOT, BORROWED_STORE_PATH),
  });
  return results
    .flatMap((result) => result.messages)
    .filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        OPERATION_BRAND_MESSAGES.has(message.message),
    )
    .map((message) => message.line);
}

describe("operation-scope ratchet", () => {
  it(
    "the lint ban fires on each direct forge spelling",
    { timeout: 120_000 },
    async () => {
      const fixture = [
        'import type { TransactionBackend } from "../backend/types";',
        'import type * as scope from "./operation-scope";',
        "import {",
        "  type enterOperation,",
        "  type OperationBackend,",
        "  type StatementBackend as Target,",
        '} from "./operation-scope";',
        "declare const raw: TransactionBackend;",
        "export const direct = raw as OperationBackend;",
        "export const qualified = raw as scope.StatementBackend;",
        "export const viaMint = raw as ReturnType<typeof enterOperation>;",
        'export const inline = raw as import("./operation-scope").OperationBackend;',
        "export const renamed: Target | undefined = undefined;",
      ].join("\n");

      // Line 6 is the renamed import; 9–12 are the four assertion spellings.
      expect(await brandReportLines(fixture)).toEqual([6, 9, 10, 11, 12]);
    },
  );

  // Parses every `src` module; coverage instrumentation slows that well past
  // the default timeout.
  it(
    "the brand is asserted only at the two mints",
    { timeout: 120_000 },
    () => {
      expect(brandAssertionSites()).toEqual(MINT_ASSERTION_SITES);
    },
  );

  it("the assertion scan sees aliases, brand type arguments and inline import types", () => {
    const source = ts.createSourceFile(
      "fixture.ts",
      [
        "type Handle = StatementBackend;",
        "declare function identity<T>(value: unknown): T;",
        "const aliased = raw as Handle;",
        "const viaTypeArgument = identity<OperationBackend>(raw);",
        'const inlineImport = raw as import("./operation-scope").StatementBackend;',
      ].join("\n"),
      ts.ScriptTarget.ESNext,
      true,
    );
    const names = brandNameClosure([source]);
    expect(names.has("Handle")).toBe(true);

    const flagged: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node) && mentionsBrand(node.type, names)) {
        flagged.push(node.getText(source));
      }
      if (
        ts.isCallExpression(node) &&
        (node.typeArguments?.some((argument) =>
          mentionsBrand(argument, names),
        ) ??
          false)
      ) {
        flagged.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(flagged).toEqual([
      "raw as Handle",
      "identity<OperationBackend>(raw)",
      'raw as import("./operation-scope").StatementBackend',
    ]);
  });

  // One test, because building the checker program is the expensive step.
  it(
    "raw statement targets per store family only decrease, and the edge-create entry points are off the raw surface",
    { timeout: 120_000 },
    () => {
      const targets = rawStatementTargets();
      expect(countByFamily(targets)).toEqual(RAW_STATEMENT_TARGET_BASELINE);

      const rawFunctions = new Set(targets.map((target) => target.function));
      expect(
        [
          "executeEdgeCreate",
          "executeEdgeCreateNoReturn",
          "executeEdgeGetOrCreateByEndpoints",
        ].filter((entryPoint) => rawFunctions.has(entryPoint)),
      ).toEqual([]);
    },
  );
});
