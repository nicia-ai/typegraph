/**
 * Pins the package root's export list. The root is the application surface;
 * everything else lives behind a subpath (`etc/root-export-moves.json` maps
 * each name that left the root). Adding a root export, or dropping one, is a
 * deliberate API decision, so it must change this list in the same commit.
 *
 * Runtime names are read from the evaluated module. Type-only names have no
 * runtime presence, so they are read from the TypeScript checker's view of
 * `src/index.ts`, which also classifies every name as value or type: a value
 * re-exported with `export type` would otherwise pass the runtime check by
 * omission. The same view checks the move map: every name it moves to a
 * subpath must be exported there, at the kind the map records.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT_VALUE_EXPORTS = [
  "asEdgeId",
  "asNodeId",
  "avg",
  "broader",
  "CardinalityError",
  "CompositionError",
  "CompositionExistenceError",
  "ConfigurationError",
  "count",
  "countDistinct",
  "createAdapterStore",
  "createAdapterStoreWithSchema",
  "createExternalRef",
  "createStore",
  "createStoreWithSchema",
  "defineEdge",
  "defineGraph",
  "defineNode",
  "DisjointError",
  "disjointWith",
  "EdgeNotFoundError",
  "embedding",
  "EndpointError",
  "EndpointNotFoundError",
  "equivalentTo",
  "exists",
  "expr",
  "externalRef",
  "field",
  "hasPart",
  "having",
  "havingEq",
  "havingGt",
  "havingGte",
  "havingLt",
  "havingLte",
  "implies",
  "inSubquery",
  "inverseOf",
  "isConstraintError",
  "isSystemError",
  "isTypeGraphError",
  "isUserRecoverable",
  "KindNotFoundError",
  "max",
  "MigrationError",
  "min",
  "narrower",
  "NodeNotFoundError",
  "notExists",
  "notInSubquery",
  "param",
  "partOf",
  "ReadSetChangedError",
  "ReadSetUnverifiableError",
  "relatedTo",
  "RestrictedDeleteError",
  "SchemaMismatchError",
  "searchable",
  "StaleVersionError",
  "StoreNotInitializedError",
  "subClassOf",
  "sum",
  "TransactionConflictError",
  "TypeGraphError",
  "UniquenessError",
  "ValidationError",
] as const;

// Type-only names include the ones an inferred graph, node, edge, ontology,
// store or query type is spelled with, so a consumer emitting declarations for
// an exported graph names them through the root it already imports
// (`type-smoke/declaration-emit.ts`).
const ROOT_TYPE_EXPORTS = [
  "DeleteBehavior",
  "Edge",
  "EdgeCollection",
  "EdgeId",
  "EdgeInGraph",
  "EdgeKinds",
  "EdgeProps",
  "EdgeType",
  "EmbeddingSchema",
  "EmbeddingValue",
  "ErrorCategory",
  "ExecutableQuery",
  "ExtensionEdgeDef",
  "ExtensionIndex",
  "ExtensionNodeDef",
  "ExtensionOntologyRelation",
  "GraphAnnotations",
  "GraphBackend",
  "GraphDef",
  "GraphExtensionVersion",
  "KindAnnotations",
  "Node",
  "NodeCollection",
  "NodeId",
  "NodeKinds",
  "NodeProps",
  "NodeRef",
  "NodeType",
  "PaginatedResult",
  "Predicate",
  "ReadSetScope",
  "SearchableSchema",
  "Store",
  "StoreOptions",
  "TemporalMode",
  "TransactionContext",
  "TypedOntologyRelation",
] as const;

const EXPECTED_ROOT_EXPORT_COUNT = 104;

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const ROOT_ENTRY = path.join(PACKAGE_ROOT, "src/index.ts");

type ExportKind = "value" | "type";

type SurfaceDifference = Readonly<{
  unexpected: readonly string[];
  missing: readonly string[];
}>;

function sorted(names: Iterable<string>): string[] {
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

function differenceOf(
  actual: readonly string[],
  expected: readonly string[],
): SurfaceDifference {
  const expectedNames = new Set(expected);
  const actualNames = new Set(actual);
  return {
    unexpected: sorted(actual.filter((name) => !expectedNames.has(name))),
    missing: sorted(expected.filter((name) => !actualNames.has(name))),
  };
}

function isTypeOnlyExportSpecifier(declaration: ts.Declaration): boolean {
  if (!ts.isExportSpecifier(declaration)) return false;
  return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
}

type ExportMove = Readonly<{
  symbol: string;
  kind: ExportKind;
  from: string;
  to: string | null;
}>;

function readExportMoves(): readonly ExportMove[] {
  const movesPath = path.join(PACKAGE_ROOT, "etc/root-export-moves.json");
  return JSON.parse(readFileSync(movesPath, "utf8")) as readonly ExportMove[];
}

function readPackageConfig(): ts.ParsedCommandLine {
  const configPath = path.join(PACKAGE_ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) {
    throw new Error(
      `Could not read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
    );
  }
  return ts.parseJsonConfigFileContent(read.config, ts.sys, PACKAGE_ROOT);
}

/** The source file the package's TypeScript paths map `specifier` to. */
function entryFileOf(config: ts.ParsedCommandLine, specifier: string): string {
  const mapped = config.options.paths?.[specifier]?.[0];
  if (mapped === undefined) {
    throw new Error(`tsconfig.json maps no path for ${specifier}.`);
  }
  return path.resolve(PACKAGE_ROOT, mapped);
}

function readExportKinds(
  entries: readonly string[],
): ReadonlyMap<string, ReadonlyMap<string, ExportKind>> {
  const config = readPackageConfig();
  const program = ts.createProgram({
    rootNames: entries,
    options: { ...config.options, noEmit: true },
  });
  const checker = program.getTypeChecker();
  return new Map(
    entries.map((entry) => [
      entry,
      readModuleExportKinds(checker, program, entry),
    ]),
  );
}

function readModuleExportKinds(
  checker: ts.TypeChecker,
  program: ts.Program,
  entry: string,
): ReadonlyMap<string, ExportKind> {
  const sourceFile = program.getSourceFile(entry);
  if (sourceFile === undefined) {
    throw new Error(`The program does not contain ${entry}.`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    throw new Error(`${entry} is not a module.`);
  }

  const kinds = new Map<string, ExportKind>();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target =
      (exported.flags & ts.SymbolFlags.Alias) === 0 ?
        exported
      : checker.getAliasedSymbol(exported);
    const declaration = exported.declarations?.[0];
    const typeOnly =
      declaration !== undefined && isTypeOnlyExportSpecifier(declaration);
    const isValue = !typeOnly && (target.flags & ts.SymbolFlags.Value) !== 0;
    kinds.set(exported.name, isValue ? "value" : "type");
  }
  return kinds;
}

function readRootExportKinds(): ReadonlyMap<string, ExportKind> {
  const kinds = readExportKinds([ROOT_ENTRY]).get(ROOT_ENTRY);
  if (kinds === undefined)
    throw new Error(`No exports read for ${ROOT_ENTRY}.`);
  return kinds;
}

function namesOfKind(
  kinds: ReadonlyMap<string, ExportKind>,
  kind: ExportKind,
): string[] {
  return sorted(
    [...kinds]
      .filter(([, exportKind]) => exportKind === kind)
      .map(([name]) => name),
  );
}

describe("package root export surface", () => {
  it("pins the expected total", () => {
    expect(ROOT_VALUE_EXPORTS.length + ROOT_TYPE_EXPORTS.length).toBe(
      EXPECTED_ROOT_EXPORT_COUNT,
    );
  });

  it("evaluates to exactly the pinned runtime exports", async () => {
    const root: Readonly<Record<string, unknown>> = await import("../src");
    const runtimeNames = sorted(Object.keys(root));

    expect(differenceOf(runtimeNames, ROOT_VALUE_EXPORTS)).toEqual({
      unexpected: [],
      missing: [],
    });
  });

  it("declares exactly the pinned value and type exports", () => {
    const kinds = readRootExportKinds();

    expect({
      values: differenceOf(namesOfKind(kinds, "value"), ROOT_VALUE_EXPORTS),
      types: differenceOf(namesOfKind(kinds, "type"), ROOT_TYPE_EXPORTS),
    }).toEqual({
      values: { unexpected: [], missing: [] },
      types: { unexpected: [], missing: [] },
    });
  });
});

/**
 * Type-checking every destination entrypoint in one program takes several
 * seconds on its own and has exceeded the default timeout under coverage
 * instrumentation on a busy runner.
 */
const EXPORT_KIND_PROGRAM_TIMEOUT_MS = 60_000;

describe("root export move map", () => {
  it(
    "names a subpath that exports each moved name at its recorded kind",
    () => {
      const config = readPackageConfig();
      const moves = readExportMoves().filter(
        (move): move is ExportMove & Readonly<{ to: string }> =>
          move.to !== null,
      );
      const entries = [
        ...new Set(moves.map((move) => entryFileOf(config, move.to))),
      ];
      const kindsByEntry = readExportKinds(entries);

      const stale = moves
        .filter(
          (move) =>
            kindsByEntry.get(entryFileOf(config, move.to))?.get(move.symbol) !==
            move.kind,
        )
        .map((move) => `${move.symbol} (${move.kind}) -> ${move.to}`);

      expect(stale).toEqual([]);
    },
    EXPORT_KIND_PROGRAM_TIMEOUT_MS,
  );
});
