/**
 * Public-type reachability across the package's entrypoints, read from the
 * checked-in API Extractor reports (`etc/*.api.md`, which `test:api-report`
 * keeps equal to the build).
 *
 * Semver covers every entrypoint except the backend-authoring ones, `/backend`
 * and `/adapters/drizzle/engine` (README "Stability"). Two contracts follow:
 *
 * 1. `etc/root-export-moves.json`, the shipped record of where each name that
 *    left the root in 0.75.0 now lives, sends a consumer to an entrypoint that
 *    really exports the name, and to a covered one whenever a covered one
 *    exports it.
 * 2. A type that a covered entrypoint's public declarations reference is
 *    importable from some covered entrypoint, rather than only from an
 *    authoring entrypoint whose shape may change in any release.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { reportNameForExport } from "../scripts/api-report-names";
import { extractApiReportBody } from "../scripts/api-surface-compat";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_NAME = "@nicia-ai/typegraph";

/**
 * The semver-covered entrypoints, in the order the README's Stability
 * paragraph lists them. This order is the move map's tie-break: when several
 * covered entrypoints export a moved name, the map names the first one here.
 * The vocabulary subpaths created to own the moved names (`/store`, `/query`,
 * `/errors`, `/identity`, `/maintenance`) come before the older concept
 * subpaths, which come before feature and runtime-specific subpaths, so the
 * earliest exporter is the entrypoint that owns the concept.
 */
const COVERED_ENTRYPOINTS = [
  ".",
  "./store",
  "./query",
  "./errors",
  "./identity",
  "./maintenance",
  "./core",
  "./schema",
  "./indexes",
  "./graph-extension",
  "./graph-merge",
  "./interchange",
  "./profiler",
  "./provenance",
  "./sqlite/local",
  "./postgres/pglite",
  "./adapters/drizzle/sqlite",
  "./adapters/drizzle/sqlite/local",
  "./adapters/drizzle/sqlite/libsql",
  "./adapters/drizzle/postgres",
  "./adapters/drizzle/postgres/working-copy",
  "./adapters/drizzle/postgres/pglite",
  "./adapters/drizzle/indexes",
] as const;

/** The backend-authoring entrypoints semver does not cover. */
const AUTHORING_ENTRYPOINTS = [
  "./backend",
  "./adapters/drizzle/engine",
] as const;

/**
 * Covered exports whose BODY is the backend-authoring contract. #869 kept
 * `GraphBackend` at the root because `createStore(graph, backend)` names it;
 * an application passes the value through and never names its members, so
 * the vocabulary its members are spelled with stays on `/backend`.
 */
const OPAQUE_BACKEND_HANDLES: ReadonlySet<string> = new Set(["GraphBackend"]);

type PendingLeak = Readonly<{
  /** The covered declaration whose public shape names `name`. */
  leaksThrough: string;
  /** A covered entrypoint whose report contains that declaration. */
  entrypoint: string;
}>;

/**
 * Backend contracts that covered signatures reference but that only the
 * authoring entrypoints export, pending the ruling tracked in #902 on whether
 * each moves under semver or the covered signature stops naming it. Do not add to
 * this list to silence a new leak: export an application-facing type from the
 * covered entrypoint that owns it instead. Each entry names one covered
 * declaration it leaks through; removing a leak fails until its entry goes.
 */
const PENDING_BACKEND_CONTRACT_LEAKS: Readonly<Record<string, PendingLeak>> = {
  AdapterBackend: { leaksThrough: "createAdapterStore", entrypoint: "." },
  BackendCapabilities: { leaksThrough: "StoreCore", entrypoint: "./store" },
  BATCH_POINT_READ: {
    leaksThrough: "StoreSearchContext",
    entrypoint: "./store",
  },
  BundleVerdictOf: {
    leaksThrough: "StoreSearchContext",
    entrypoint: "./store",
  },
  CompiledRowsSql: {
    leaksThrough: "ExecutableRelationQuery",
    entrypoint: "./query",
  },
  CompiledSelectSql: { leaksThrough: "ExecutableQuery", entrypoint: "." },
  EdgeRow: { leaksThrough: "EdgeMeta", entrypoint: "./store" },
  FenceSql: {
    leaksThrough: "postgresFenceSql",
    entrypoint: "./adapters/drizzle/postgres",
  },
  FulltextStrategy: {
    leaksThrough: "CompileQueryOptions",
    entrypoint: "./query",
  },
  NodeRow: { leaksThrough: "NodeMeta", entrypoint: "./store" },
  RecordedSourceTable: {
    leaksThrough: "RecordedReadSource",
    entrypoint: "./query",
  },
  RecursiveTraversalVerdict: {
    leaksThrough: "CompileQueryOptions",
    entrypoint: "./query",
  },
  ResolvedSqlTableNames: { leaksThrough: "SqlSchema", entrypoint: "./query" },
  SchemaProvisioning: {
    leaksThrough: "PostgresBackendOptions",
    entrypoint: "./adapters/drizzle/postgres",
  },
  SqlFragment: { leaksThrough: "SqlSchema", entrypoint: "./store" },
  TransactionBackend: { leaksThrough: "ExecutableQuery", entrypoint: "." },
  TransactionReadBackend: {
    leaksThrough: "TransactionCollections",
    entrypoint: "./store",
  },
  VectorSlot: { leaksThrough: "resolveGraphVectorSlots", entrypoint: "./core" },
  VectorStrategy: {
    leaksThrough: "CompileQueryOptions",
    entrypoint: "./query",
  },
};

type ParsedReport = Readonly<{
  source: string;
  exported: ReadonlySet<string>;
  declarations: ReadonlyMap<string, readonly ts.Statement[]>;
}>;

type MoveEntry = Readonly<{
  symbol: string;
  kind: string;
  from: string;
  to: string | null;
}>;

function readJson(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, relativePath), "utf8"),
  ) as unknown;
}

function packageExportKeys(): readonly string[] {
  const manifest = readJson("package.json") as Readonly<{
    exports: Readonly<Record<string, unknown>>;
  }>;
  return Object.keys(manifest.exports);
}

function hasExportModifier(statement: ts.Statement): boolean {
  if (!ts.canHaveModifiers(statement)) return false;
  return (ts.getModifiers(statement) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function declaredNames(statement: ts.Statement): readonly string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (
    ts.isTypeAliasDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    const name = statement.name;
    return name !== undefined && ts.isIdentifier(name) ? [name.text] : [];
  }
  return [];
}

function parseReport(exportPath: string): ParsedReport {
  const reportPath = path.join(
    PACKAGE_ROOT,
    "etc",
    `${reportNameForExport(exportPath)}.api.md`,
  );
  const source = extractApiReportBody(readFileSync(reportPath, "utf8"));
  const sourceFile = ts.createSourceFile(
    `${reportNameForExport(exportPath)}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const exported = new Set<string>();
  const declarations = new Map<string, ts.Statement[]>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      throw new Error(
        `${reportPath} contains an export list; the report format changed.`,
      );
    }
    for (const name of declaredNames(statement)) {
      if (hasExportModifier(statement)) exported.add(name);
      declarations.set(name, [...(declarations.get(name) ?? []), statement]);
    }
  }
  return { source, exported, declarations };
}

const ENTRYPOINTS = [...COVERED_ENTRYPOINTS, ...AUTHORING_ENTRYPOINTS];
const REPORTS: ReadonlyMap<string, ParsedReport> = new Map(
  ENTRYPOINTS.map((entrypoint) => [entrypoint, parseReport(entrypoint)]),
);

function reportFor(entrypoint: string): ParsedReport {
  const report = REPORTS.get(entrypoint);
  if (report === undefined) throw new Error(`No report for ${entrypoint}.`);
  return report;
}

function exportersOf(
  symbol: string,
  entrypoints: readonly string[],
): readonly string[] {
  return entrypoints.filter((entrypoint) =>
    reportFor(entrypoint).exported.has(symbol),
  );
}

function entrypointOfSpecifier(specifier: string): string {
  if (specifier === PACKAGE_NAME) return ".";
  if (!specifier.startsWith(`${PACKAGE_NAME}/`)) {
    throw new Error(`Move destination ${specifier} is not a package subpath.`);
  }
  return `./${specifier.slice(PACKAGE_NAME.length + 1)}`;
}

function specifierOfEntrypoint(entrypoint: string): string {
  return entrypoint === "." ? PACKAGE_NAME : (
      `${PACKAGE_NAME}/${entrypoint.slice(2)}`
    );
}

/** Whether a node carries an `@internal` release tag in its leading comments. */
function isInternal(node: ts.Node, source: string): boolean {
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [];
  return ranges.some((range) =>
    source.slice(range.pos, range.end).includes("@internal"),
  );
}

/**
 * A member keyed by a `unique symbol` no entrypoint exports: a consumer can
 * neither read nor write it, so its type never has to be named.
 */
function hasUnexportedSymbolKey(
  member: ts.Node,
  exportedAnywhere: ReadonlySet<string>,
): boolean {
  const name = (member as Readonly<{ name?: ts.Node }>).name;
  return (
    name !== undefined &&
    ts.isComputedPropertyName(name) &&
    ts.isIdentifier(name.expression) &&
    !exportedAnywhere.has(name.expression.text)
  );
}

function leftmostIdentifier(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmostIdentifier(name.left);
}

/** The local names a declaration's consumer-visible shape references. */
function referencedNames(
  statement: ts.Statement,
  source: string,
  exportedAnywhere: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      (ts.isTypeElement(node) || ts.isClassElement(node)) &&
      (isInternal(node, source) ||
        hasUnexportedSymbolKey(node, exportedAnywhere))
    ) {
      return;
    }
    if (ts.isTypeReferenceNode(node))
      names.add(leftmostIdentifier(node.typeName));
    if (ts.isTypeQueryNode(node)) names.add(leftmostIdentifier(node.exprName));
    if (
      ts.isExpressionWithTypeArguments(node) &&
      ts.isIdentifier(node.expression)
    ) {
      names.add(node.expression.text);
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }
  visit(statement);
  return names;
}

type Leak = Readonly<{
  name: string;
  leaksThrough: string;
  entrypoint: string;
}>;

/**
 * Walks each covered report from its exported declarations through the
 * declarations they reference, and records every referenced name that only
 * an authoring entrypoint exports. The walk does not descend into such a
 * name (it is the finding), into an opaque backend handle, into an
 * `@internal` declaration or member, or into a member keyed by an unexported
 * symbol.
 */
function findAuthoringOnlyLeaks(): readonly Leak[] {
  const covered = new Set(
    COVERED_ENTRYPOINTS.flatMap((entrypoint) => [
      ...reportFor(entrypoint).exported,
    ]),
  );
  const authoring = new Set(
    AUTHORING_ENTRYPOINTS.flatMap((entrypoint) => [
      ...reportFor(entrypoint).exported,
    ]),
  );
  const exportedAnywhere = new Set([...covered, ...authoring]);
  const leaks: Leak[] = [];
  for (const entrypoint of COVERED_ENTRYPOINTS) {
    const report = reportFor(entrypoint);
    const visited = new Set<string>();
    const pending = [...report.exported];
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      if (visited.has(name) || OPAQUE_BACKEND_HANDLES.has(name)) continue;
      visited.add(name);
      const statements = (report.declarations.get(name) ?? []).filter(
        (statement) => !isInternal(statement, report.source),
      );
      for (const statement of statements) {
        for (const reference of referencedNames(
          statement,
          report.source,
          exportedAnywhere,
        )) {
          if (!report.declarations.has(reference)) continue;
          if (!covered.has(reference) && authoring.has(reference)) {
            leaks.push({ name: reference, leaksThrough: name, entrypoint });
          } else {
            pending.push(reference);
          }
        }
      }
    }
  }
  return leaks;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

describe("public type reachability", () => {
  it("classifies every package entrypoint as covered or authoring", () => {
    expect(sorted(packageExportKeys())).toEqual(sorted(ENTRYPOINTS));
  });

  it("routes every moved name to an entrypoint that exports it, covered first", () => {
    const moves = readJson(
      "etc/root-export-moves.json",
    ) as readonly MoveEntry[];
    const misrouted = moves.flatMap((move) => {
      if (move.to === null) return [];
      const destination = entrypointOfSpecifier(move.to);
      // A moved name left the root, so the root is never its destination even
      // where it is re-exported there for declaration emit.
      const coveredExporters = exportersOf(
        move.symbol,
        COVERED_ENTRYPOINTS.filter((entrypoint) => entrypoint !== "."),
      );
      const expected =
        coveredExporters[0] ??
        exportersOf(move.symbol, AUTHORING_ENTRYPOINTS)[0];
      if (expected === undefined) {
        return [
          `${move.symbol}: no entrypoint exports it (map says ${move.to})`,
        ];
      }
      if (destination === expected) return [];
      return [
        `${move.symbol}: map says ${move.to}, expected ${specifierOfEntrypoint(expected)}`,
      ];
    });
    expect(misrouted).toEqual([]);
  });

  it("names only types importable from a covered entrypoint, apart from the pending backend contracts", () => {
    const leaks = findAuthoringOnlyLeaks();
    const leakedNames = new Set(leaks.map((leak) => leak.name));
    expect(sorted(leakedNames)).toEqual(
      sorted(Object.keys(PENDING_BACKEND_CONTRACT_LEAKS)),
    );
    const unmatched = Object.entries(PENDING_BACKEND_CONTRACT_LEAKS).filter(
      ([name, pendingLeak]) =>
        !leaks.some(
          (leak) =>
            leak.name === name &&
            leak.leaksThrough === pendingLeak.leaksThrough &&
            leak.entrypoint === pendingLeak.entrypoint,
        ),
    );
    expect(unmatched.map(([name]) => name)).toEqual([]);
  });
});
