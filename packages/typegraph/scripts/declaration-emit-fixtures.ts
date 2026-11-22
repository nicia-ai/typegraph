/**
 * The module dependencies of declaration-emit fixtures and of the
 * declarations a consumer emits from them, read with the TypeScript parser.
 *
 * `scripts/test-types.ts consumer` compiles each fixture in
 * `type-smoke/declaration-emit/` as its own program. A single-entrypoint
 * fixture proves that a consumer importing only that entrypoint can export
 * inferred types, which a second entrypoint in the program would mask: every
 * form that adds a module to the program counts — a side-effect `import "…"`,
 * `import type`, `export … from`, an `import("…")` type or call,
 * `import x = require("…")`, and `/// <reference types | path>` directives.
 */
import ts from "typescript";

import { reportNameForExport } from "./api-report-names";
import { COVERED_ENTRYPOINTS } from "./entrypoint-stability";

export const PACKAGE_NAME = "@nicia-ai/typegraph";

/**
 * Packages other than TypeGraph a fixture, and the declarations a consumer
 * emits from it, may import, with any of their subpaths: the consumer depends
 * on them directly. `@electric-sql/pglite` is the optional peer the PGlite
 * adapter's results are typed with.
 */
const DECLARATION_EMIT_FOREIGN_PACKAGES: readonly string[] = [
  "zod",
  "drizzle-orm",
  "@electric-sql/pglite",
];

function isForeignPackageSpecifier(specifier: string): boolean {
  return DECLARATION_EMIT_FOREIGN_PACKAGES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function specifierOfEntrypoint(entrypoint: string): string {
  return entrypoint === "." ? PACKAGE_NAME : (
      `${PACKAGE_NAME}/${entrypoint.slice(2)}`
    );
}

export type ModuleDependencies = Readonly<{
  /** Every module specifier the file imports, re-exports or references. */
  specifiers: readonly string[];
  /** `/// <reference path>` targets, which pull files in by path. */
  referencedFiles: readonly string[];
}>;

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ?
      node.text
    : undefined;
}

/**
 * Every module a TypeScript or declaration file brings into its program, by
 * parsing it: import and export declarations of every form (including
 * side-effect and type-only ones), `import x = require()`, `import()` types
 * and calls, `require()` calls, and reference directives.
 */
export function moduleDependenciesOf(
  fileName: string,
  source: string,
): ModuleDependencies {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".d.ts") || fileName.endsWith(".d.cts") ?
      ts.ScriptKind.TS
    : undefined,
  );
  const specifiers = new Set<string>(
    sourceFile.typeReferenceDirectives.map((directive) => directive.fileName),
  );
  function visit(node: ts.Node): void {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ?
        stringLiteralText(node.moduleSpecifier)
      : (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) ?
        stringLiteralText(node.moduleReference.expression)
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ?
        stringLiteralText(node.argument.literal)
      : (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) ?
        stringLiteralText(node.arguments[0])
      : ts.isModuleDeclaration(node) ? stringLiteralText(node.name)
      : undefined;
    if (specifier !== undefined) specifiers.add(specifier);
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }
  visit(sourceFile);
  return {
    specifiers: [...specifiers].toSorted(),
    referencedFiles: sourceFile.referencedFiles.map(
      (reference) => reference.fileName,
    ),
  };
}

export type DeclarationEmitFixture = Readonly<{
  /** The fixture's file name without `.ts`. */
  name: string;
  /** The TypeGraph entrypoint specifiers the fixture imports. */
  specifiers: readonly string[];
}>;

/**
 * Validates the fixture set and refuses one that could hide a per-entrypoint
 * gap. Each covered entrypoint has a fixture named after its API report
 * (`typegraph-core.ts` for `/core`) that depends on that entrypoint and no
 * other; any other fixture composes two or more covered entrypoints. A
 * fixture depends on nothing else but the foreign packages a consumer
 * depends on, and references no file by path.
 */
export function validateDeclarationEmitFixtures(
  files: readonly Readonly<{ file: string; source: string }>[],
): Readonly<{
  fixtures: readonly DeclarationEmitFixture[];
  problems: readonly string[];
}> {
  const coveredSpecifiers = new Map<string, string>(
    COVERED_ENTRYPOINTS.map((entrypoint) => [
      reportNameForExport(entrypoint),
      specifierOfEntrypoint(entrypoint),
    ]),
  );
  const allowed = new Set(coveredSpecifiers.values());
  const fixtures: DeclarationEmitFixture[] = [];
  const problems: string[] = [];
  for (const { file, source } of files.toSorted((left, right) =>
    left.file.localeCompare(right.file),
  )) {
    const name = file.slice(0, -".ts".length);
    const dependencies = moduleDependenciesOf(file, source);
    if (dependencies.referencedFiles.length > 0) {
      problems.push(
        `${file} references ${dependencies.referencedFiles.join(", ")} by path; a fixture's program holds only what it imports`,
      );
    }
    const specifiers = dependencies.specifiers.filter(
      (specifier) => !isForeignPackageSpecifier(specifier),
    );
    const disallowed = specifiers.filter(
      (specifier) => !allowed.has(specifier),
    );
    if (disallowed.length > 0) {
      problems.push(
        `${file} imports ${disallowed.join(", ")}, which is neither a covered entrypoint nor a foreign package a consumer depends on`,
      );
    }
    const own = coveredSpecifiers.get(name);
    if (
      own !== undefined &&
      (specifiers.length !== 1 || specifiers[0] !== own)
    ) {
      problems.push(
        `${file} must import ${own} and no other entrypoint; it imports ${specifiers.join(", ")}`,
      );
    }
    if (own === undefined && specifiers.length < 2) {
      problems.push(
        `${file} imports ${specifiers.length} entrypoint(s): name a single-entrypoint fixture after its report (${[...coveredSpecifiers.keys()].join(", ")})`,
      );
    }
    fixtures.push({ name, specifiers });
  }
  for (const [name, specifier] of coveredSpecifiers) {
    if (!fixtures.some((fixture) => fixture.name === name)) {
      problems.push(
        `No declaration-emit fixture for ${specifier} (${name}.ts)`,
      );
    }
  }
  return { fixtures, problems };
}

/**
 * Every module specifier in an emitted declaration that is neither a public
 * TypeGraph entrypoint nor an allowed foreign package. A type TypeScript could
 * not name through an entrypoint the program holds surfaces either as a
 * TS2742/TS2883 refusal or, when the path happens to resolve, as a relative
 * `dist/<hashed chunk>` specifier; this catches the second form. A reference
 * directive by path is always non-public.
 */
export function nonPublicDeclarationSpecifiers(
  fileName: string,
  declarationSource: string,
  publicSpecifiers: ReadonlySet<string>,
): readonly string[] {
  const dependencies = moduleDependenciesOf(fileName, declarationSource);
  return [
    ...dependencies.specifiers.filter(
      (specifier) =>
        !publicSpecifiers.has(specifier) &&
        !isForeignPackageSpecifier(specifier),
    ),
    ...dependencies.referencedFiles.map(
      (file) => `/// <reference path="${file}">`,
    ),
  ].toSorted();
}

/**
 * Splits `tsc --pretty false` output into diagnostics and keeps those a
 * declaration-emit run is accountable for: every diagnostic except one
 * located in a third-party package's own declarations. With `skipLibCheck`
 * off, TypeScript also checks every dependency's declarations, and some
 * dependencies do not type-check under a strict consumer configuration on
 * their own (missing optional drivers, `exactOptionalPropertyTypes`); those
 * diagnostics say nothing about TypeGraph's declarations or the consumer's.
 * A diagnostic in TypeGraph's own installed declarations, in the consumer's
 * files or emitted declarations, or with no location at all, is kept.
 */
export function accountableDiagnostics(output: string): Readonly<{
  accountable: readonly string[];
  thirdParty: readonly string[];
}> {
  const diagnostics: string[] = [];
  for (const line of output.split("\n")) {
    if (/^\s/.test(line) && diagnostics.length > 0) {
      diagnostics[diagnostics.length - 1] =
        `${diagnostics.at(-1) ?? ""}\n${line}`;
    } else if (/\berror TS\d+:/.test(line)) {
      diagnostics.push(line);
    }
  }
  const accountable: string[] = [];
  const thirdParty: string[] = [];
  for (const diagnostic of diagnostics) {
    const location = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(diagnostic)?.[1];
    const normalized = location?.split("\\").join("/");
    const isThirdParty =
      normalized !== undefined &&
      normalized.includes("node_modules/") &&
      !normalized.includes(`node_modules/${PACKAGE_NAME}/`);
    (isThirdParty ? thirdParty : accountable).push(diagnostic);
  }
  return { accountable, thirdParty };
}
