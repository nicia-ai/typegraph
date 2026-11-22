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
 * 3. A type that a covered entrypoint's public declarations reference is
 *    nameable by a consumer that imports ONLY that entrypoint. Declaration
 *    emit can spell a type only through a module already in the consumer's
 *    program, so contract 2 is not enough: the type must be exported by the
 *    entrypoint itself or by a covered entrypoint whose declarations that
 *    entrypoint loads (`scripts/declaration-loads.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { reportNameForExport } from "../scripts/api-report-names";
import { extractApiReportBody } from "../scripts/api-surface-compat";
import { DECLARATION_LOADS } from "../scripts/declaration-loads";
import {
  AUTHORING_ENTRYPOINTS,
  COVERED_ENTRYPOINTS,
} from "../scripts/entrypoint-stability";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_NAME = "@nicia-ai/typegraph";

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

/** Every name a covered entrypoint exports. */
const COVERED_NAMES: ReadonlySet<string> = new Set(
  COVERED_ENTRYPOINTS.flatMap((entrypoint) => [
    ...reportFor(entrypoint).exported,
  ]),
);
/** Every name an authoring entrypoint exports. */
const AUTHORING_NAMES: ReadonlySet<string> = new Set(
  AUTHORING_ENTRYPOINTS.flatMap((entrypoint) => [
    ...reportFor(entrypoint).exported,
  ]),
);
const EXPORTED_ANYWHERE: ReadonlySet<string> = new Set([
  ...COVERED_NAMES,
  ...AUTHORING_NAMES,
]);

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

type DeclarationLoads = Readonly<Record<string, readonly string[]>>;

/**
 * An entrypoint and every entrypoint its declarations load under `loads`,
 * transitively. `loads` defaults to the map the build writes into each
 * entry's emitted declarations (`scripts/declaration-loads.ts`); the
 * load-necessity test passes that map with one edge removed.
 */
function loadedEntrypoints(
  entrypoint: string,
  loads: DeclarationLoads = DECLARATION_LOADS,
): ReadonlySet<string> {
  const loaded = new Set<string>();
  const pending = [entrypoint];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (loaded.has(next)) continue;
    loaded.add(next);
    pending.push(...(loads[next] ?? []));
  }
  return loaded;
}

/**
 * A report statement's text with the parts API Extractor varies per report
 * removed: the `export` keyword (a name is exported from one report and
 * rendered as a local in another) and the `$1` / `_2` suffixes it appends to
 * disambiguate two declarations of one name.
 */
function normalizedDeclaration(
  statement: ts.Statement,
  source: string,
): string {
  return source
    .slice(statement.getStart(), statement.getEnd())
    .replace(/^export\s+/, "")
    .replaceAll(/(\w)(?:\$\d+|_\d+)\b/g, "$1");
}

/** A report-local name without the suffix API Extractor disambiguates it with. */
function sourceName(name: string): string {
  return name.replace(/(?:\$\d+|_\d+)$/, "");
}

/**
 * Whether `exporter`'s report exports the declaration `report` renders as
 * `name`. API Extractor renames the second of two colliding declarations in
 * each report (`TraversalDirection$1`), and which one it renames differs per
 * report, so the exporter is searched by the source name and the declarations
 * compared by text: exporting a different declaration of the same source
 * name does not make this one nameable.
 */
function exportsSameDeclaration(
  exporter: ParsedReport,
  report: ParsedReport,
  name: string,
): boolean {
  const exportedName = sourceName(name);
  if (!exporter.exported.has(exportedName)) return false;
  const ours = (report.declarations.get(name) ?? []).map((statement) =>
    normalizedDeclaration(statement, report.source),
  );
  const theirs = new Set(
    (exporter.declarations.get(exportedName) ?? []).map((statement) =>
      normalizedDeclaration(statement, exporter.source),
    ),
  );
  return ours.length > 0 && ours.every((text) => theirs.has(text));
}

/**
 * Whether a `typeof name` query needs `name` itself to be nameable. Declaration
 * emit writes `typeof f` for a function only when `f` is accessible and
 * otherwise spells out its signature, and it resolves `typeof c` for a
 * constant to the constant's type; only a `unique symbol` constant has no
 * spelling but its own name. The types inside the declaration still surface,
 * so the walk descends into it either way.
 */
function typeQueryNeedsName(report: ParsedReport, name: string): boolean {
  const statements = report.declarations.get(name) ?? [];
  return statements.some((statement) => {
    if (ts.isFunctionDeclaration(statement)) return false;
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(
        (declaration) =>
          declaration.type !== undefined &&
          ts.isTypeOperatorNode(declaration.type) &&
          declaration.type.operator === ts.SyntaxKind.UniqueKeyword,
      );
    }
    return true;
  });
}

type Reference = Readonly<{ name: string; viaTypeQuery: boolean }>;

/**
 * The local names a declaration's consumer-visible shape references, each
 * marked when the reference is only a `typeof` query. Skips what
 * `referencedNames` skips.
 */
function referencesOf(
  statement: ts.Statement,
  source: string,
  exportedAnywhere: ReadonlySet<string>,
): readonly Reference[] {
  const references = new Map<string, boolean>();
  function record(name: string, viaTypeQuery: boolean): void {
    references.set(name, (references.get(name) ?? true) && viaTypeQuery);
  }
  function visit(node: ts.Node): void {
    if (
      (ts.isTypeElement(node) || ts.isClassElement(node)) &&
      (isInternal(node, source) ||
        hasUnexportedSymbolKey(node, exportedAnywhere))
    ) {
      return;
    }
    if (ts.isTypeReferenceNode(node))
      record(leftmostIdentifier(node.typeName), false);
    if (ts.isTypeQueryNode(node))
      record(leftmostIdentifier(node.exprName), true);
    if (
      ts.isExpressionWithTypeArguments(node) &&
      ts.isIdentifier(node.expression)
    ) {
      record(node.expression.text, false);
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }
  visit(statement);
  return [...references].map(([name, viaTypeQuery]) => ({
    name,
    viaTypeQuery,
  }));
}

type Unnameable = Readonly<{
  entrypoint: string;
  name: string;
  /** The declaration the walk reached `name` through. */
  namedBy: string;
}>;

/**
 * Whether `name`, referenced from `report`, is a backend-authoring contract:
 * declared in the report and exported only by an authoring entrypoint.
 */
function isAuthoringOnly(
  report: ParsedReport,
  name: string,
  covered: ReadonlySet<string>,
  authoring: ReadonlySet<string>,
): boolean {
  return (
    report.declarations.has(name) && !covered.has(name) && authoring.has(name)
  );
}

/**
 * Every name `entrypoint`'s consumer-visible declarations reference that the
 * entrypoint does not export itself, each with the declaration the walk first
 * reached it through. The walk starts at the entrypoint's exported
 * declarations and descends through every declaration they reference. It
 * treats the authoring-only names and the opaque backend handle exactly as
 * `findAuthoringOnlyLeaks` does — the signatures that reach them are the
 * documented exception `findAuthoringTypeSignatures` enumerates — and a
 * `typeof` query as `typeQueryNeedsName` describes.
 */
function namesNeededFromElsewhere(
  entrypoint: string,
): ReadonlyMap<string, string> {
  const report = reportFor(entrypoint);
  const needed = new Map<string, string>();
  const visited = new Set<string>();
  const pending = [...report.exported];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (visited.has(name) || OPAQUE_BACKEND_HANDLES.has(name)) continue;
    visited.add(name);
    const statements = (report.declarations.get(name) ?? []).filter(
      (statement) => !isInternal(statement, report.source),
    );
    for (const statement of statements) {
      for (const reference of referencesOf(
        statement,
        report.source,
        EXPORTED_ANYWHERE,
      )) {
        if (!report.declarations.has(reference.name)) continue;
        if (
          isAuthoringOnly(
            report,
            reference.name,
            COVERED_NAMES,
            AUTHORING_NAMES,
          )
        ) {
          continue;
        }
        const needsName =
          !reference.viaTypeQuery || typeQueryNeedsName(report, reference.name);
        if (
          needsName &&
          !report.exported.has(reference.name) &&
          !needed.has(reference.name)
        ) {
          needed.set(reference.name, name);
        }
        pending.push(reference.name);
      }
    }
  }
  return needed;
}

/**
 * For each covered entrypoint, each name it needs from elsewhere mapped to
 * the declaration the walk reached it through and to the covered entrypoints
 * (other than itself) that export that same declaration. Independent of the
 * load map, so the load-necessity test can re-judge many maps against it.
 */
const NEEDED_NAMES: ReadonlyMap<
  string,
  ReadonlyMap<
    string,
    Readonly<{ namedBy: string; exporters: ReadonlySet<string> }>
  >
> = new Map(
  COVERED_ENTRYPOINTS.map((entrypoint) => {
    const report = reportFor(entrypoint);
    return [
      entrypoint,
      new Map(
        [...namesNeededFromElsewhere(entrypoint)].map(([name, namedBy]) => [
          name,
          {
            namedBy,
            exporters: new Set(
              COVERED_ENTRYPOINTS.filter(
                (candidate) =>
                  candidate !== entrypoint &&
                  exportsSameDeclaration(reportFor(candidate), report, name),
              ),
            ),
          },
        ]),
      ),
    ];
  }),
);

/**
 * Each name a consumer importing only one covered entrypoint could not name
 * under `loads`: needed from elsewhere, and exported by no entrypoint that
 * entrypoint's declarations load.
 */
function findUnnameableTypes(
  loads: DeclarationLoads = DECLARATION_LOADS,
): readonly Unnameable[] {
  return COVERED_ENTRYPOINTS.flatMap((entrypoint) => {
    const loaded = loadedEntrypoints(entrypoint, loads);
    return [...(NEEDED_NAMES.get(entrypoint) ?? [])].flatMap(
      ([name, { namedBy, exporters }]) =>
        [...exporters].some((exporter) => loaded.has(exporter)) ?
          []
        : [{ entrypoint, name, namedBy }],
    );
  });
}

/** `loads` without the single edge `entrypoint` → `loaded`. */
function withoutLoad(
  loads: DeclarationLoads,
  entrypoint: string,
  loaded: string,
): DeclarationLoads {
  return {
    ...loads,
    [entrypoint]: (loads[entrypoint] ?? []).filter(
      (candidate) => candidate !== loaded,
    ),
  };
}

/**
 * Each declared load whose removal leaves every covered entrypoint able to
 * name every type it needs. Crediting a load with the needed names it can
 * reach is not enough: a load that repeats names another load already
 * supplies, directly or transitively, is redundant. Each edge is therefore
 * judged by comparing reachability with and without it.
 */
function findRedundantLoads(loads: DeclarationLoads): readonly string[] {
  const baseline = findUnnameableTypes(loads).length;
  return Object.entries(loads).flatMap(([entrypoint, targets]) =>
    targets.flatMap((loaded) =>
      (
        findUnnameableTypes(withoutLoad(loads, entrypoint, loaded)).length >
        baseline
      ) ?
        []
      : [
          `${entrypoint} loads ${loaded}, but every needed name stays nameable without it`,
        ],
    ),
  );
}

/**
 * Where a reference sits in a report declaration, for the exception list: the
 * outermost member (property, method, call or index signature) of the
 * declaration that contains it, or `undefined` when it is in the
 * declaration's own type (a function signature, a constant's type, a type
 * alias outside any member).
 */
function memberNameOf(node: ts.Node): string | undefined {
  if (!ts.isTypeElement(node) && !ts.isClassElement(node)) return undefined;
  if (node.name !== undefined) return node.name.getText();
  if (ts.isCallSignatureDeclaration(node)) return "(call)";
  if (ts.isConstructSignatureDeclaration(node)) return "(new)";
  if (ts.isIndexSignatureDeclaration(node)) return "[index]";
  return "(member)";
}

/** How the exception list describes an opaque backend handle's members. */
const OPAQUE_HANDLE_MEMBERS =
  "every member (the backend contract; its vocabulary is exported only by `@nicia-ai/typegraph/backend`)";

type AuthoringTypeSignature = Readonly<{
  /** The covered declaration, by source name. */
  declaration: string;
  /** Its members whose types name an authoring-only type; `""` is the declaration's own type. */
  members: ReadonlySet<string>;
  /** The authoring-only types those signatures name. */
  authoringTypes: ReadonlySet<string>;
}>;

/**
 * The public signatures whose type closure contract 3 does not check: every
 * covered declaration reachable from a covered entrypoint's exports whose own
 * type, or one of whose members, names a backend-authoring contract only
 * `/backend` or `/adapters/drizzle/engine` exports, plus each opaque backend
 * handle (whose members the walk never enters). A consumer that exports a
 * value inferred from one of these signatures cannot name its type through a
 * covered entrypoint (TS2742 / TS2883). Walks exactly what
 * `namesNeededFromElsewhere` walks, so every signature that walk skips is here.
 */
function findAuthoringTypeSignatures(): readonly AuthoringTypeSignature[] {
  const members = new Map<string, Set<string>>();
  const authoringTypes = new Map<string, Set<string>>();
  function record(declaration: string, member: string, type: string): void {
    members.set(
      declaration,
      new Set([...(members.get(declaration) ?? []), member]),
    );
    authoringTypes.set(
      declaration,
      new Set([...(authoringTypes.get(declaration) ?? []), type]),
    );
  }
  for (const entrypoint of COVERED_ENTRYPOINTS) {
    const report = reportFor(entrypoint);
    const visited = new Set<string>();
    const pending = [...report.exported];
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      if (visited.has(name)) continue;
      visited.add(name);
      if (OPAQUE_BACKEND_HANDLES.has(name)) {
        members.set(sourceName(name), new Set([OPAQUE_HANDLE_MEMBERS]));
        authoringTypes.set(sourceName(name), new Set());
        continue;
      }
      const statements = (report.declarations.get(name) ?? []).filter(
        (statement) => !isInternal(statement, report.source),
      );
      for (const statement of statements) {
        const visit = (node: ts.Node, member: string | undefined): void => {
          if (
            (ts.isTypeElement(node) || ts.isClassElement(node)) &&
            (isInternal(node, report.source) ||
              hasUnexportedSymbolKey(node, EXPORTED_ANYWHERE))
          ) {
            return;
          }
          const enclosing = member ?? memberNameOf(node);
          const referenced =
            ts.isTypeReferenceNode(node) ? leftmostIdentifier(node.typeName)
            : ts.isTypeQueryNode(node) ? leftmostIdentifier(node.exprName)
            : (
              ts.isExpressionWithTypeArguments(node) &&
              ts.isIdentifier(node.expression)
            ) ?
              node.expression.text
            : undefined;
          if (referenced !== undefined && report.declarations.has(referenced)) {
            if (
              isAuthoringOnly(
                report,
                referenced,
                COVERED_NAMES,
                AUTHORING_NAMES,
              )
            ) {
              record(sourceName(name), enclosing ?? "", referenced);
            } else {
              pending.push(referenced);
            }
          }
          ts.forEachChild(node, (child) => {
            visit(child, enclosing);
          });
        };
        visit(statement, undefined);
      }
    }
  }
  return sorted(members.keys()).map((declaration) => ({
    declaration,
    members: members.get(declaration) ?? new Set(),
    authoringTypes: authoringTypes.get(declaration) ?? new Set(),
  }));
}

/**
 * The exception list as the docs and the changeset print it: one bullet per
 * declaration, naming the members whose types name an authoring contract
 * ("itself" for the declaration's own type) and the contracts they name.
 */
function renderAuthoringTypeSignatures(
  signatures: readonly AuthoringTypeSignature[],
): string {
  return signatures
    .map(({ declaration, members, authoringTypes }) => {
      const where = sorted(members)
        .map((member) =>
          member === "" ? "itself"
          : /^[A-Za-z_$][\w$]*$/.test(member) ? `\`${member}\``
          : member,
        )
        .join(", ");
      if (authoringTypes.size === 0) return `- \`${declaration}\`: ${where}`;
      const names = sorted(authoringTypes)
        .map((type) => `\`${type}\``)
        .join(", ");
      return `- \`${declaration}\`: ${where} (names ${names})`;
    })
    .join("\n");
}

const AUTHORING_LIST_START = "<!-- authoring-type-signatures:start -->";
const AUTHORING_LIST_END = "<!-- authoring-type-signatures:end -->";

/**
 * The list a document carries between the exception-list markers, with runs
 * of whitespace collapsed: the docs wrap long items for markdownlint, the
 * changeset keeps one line per item, and both say the same thing.
 */
function documentedAuthoringTypeSignatures(relativePath: string): string {
  const text = readFileSync(path.join(PACKAGE_ROOT, relativePath), "utf8");
  const start = text.indexOf(AUTHORING_LIST_START);
  const end = text.indexOf(AUTHORING_LIST_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${relativePath} has no ${AUTHORING_LIST_START} … ${AUTHORING_LIST_END} block.`,
    );
  }
  return collapseWhitespace(
    text.slice(start + AUTHORING_LIST_START.length, end),
  );
}

function collapseWhitespace(text: string): string {
  return text.trim().replaceAll(/\s+/g, " ");
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

describe("per-entrypoint declaration emit", () => {
  it("loads only covered entrypoints, from covered entrypoints", () => {
    const covered: readonly string[] = COVERED_ENTRYPOINTS;
    const invalid = Object.entries(DECLARATION_LOADS).flatMap(
      ([entrypoint, loads]) => [
        ...(covered.includes(entrypoint) ?
          []
        : [`${entrypoint} is not a covered entrypoint`]),
        ...loads.flatMap((loaded) =>
          covered.includes(loaded) && loaded !== entrypoint ?
            []
          : [
              `${entrypoint} loads ${loaded}, which is itself or not semver-covered, so a consumer's declarations must not name types through it`,
            ],
        ),
      ],
    );
    expect(invalid).toEqual([]);
  });

  it("declares only loads whose removal leaves a needed name unnameable", () => {
    expect(findRedundantLoads(DECLARATION_LOADS)).toEqual([]);
  });

  it("reports a load that only repeats names another load already supplies", () => {
    // `/errors` reaches every `/graph-merge` name it needs through the root,
    // so a direct edge supplies nothing new. Every edge it parallels becomes
    // removable on its own too (the root reaches `/graph-merge` through
    // `/errors`, and `/errors` reaches the root through `/graph-merge`), so
    // the check names all three; a load-reachability check that credits an
    // edge with names it can reach accepted this map.
    const redundant: DeclarationLoads = {
      ...DECLARATION_LOADS,
      "./errors": [...(DECLARATION_LOADS["./errors"] ?? []), "./graph-merge"],
    };
    expect(findRedundantLoads(redundant)).toEqual([
      ". loads ./graph-merge, but every needed name stays nameable without it",
      "./errors loads ., but every needed name stays nameable without it",
      "./errors loads ./graph-merge, but every needed name stays nameable without it",
    ]);
  });

  it("names only types the entrypoint or an entrypoint it loads exports", () => {
    const unnameable = findUnnameableTypes().map(
      (finding) =>
        `${finding.entrypoint}: ${finding.name} (named by ${finding.namedBy})`,
    );
    expect(unnameable).toEqual([]);
  });

  // Every public signature the walk above does not check is documented, by
  // name, as not exportable by inference. The list in the docs is the list
  // the walk skips: neither may change without the other.
  it("documents exactly the signatures whose type closure it skips", () => {
    const expected = collapseWhitespace(
      renderAuthoringTypeSignatures(findAuthoringTypeSignatures()),
    );
    // The changeset carries the same list until the release consumes it.
    const changeset = "../../.changeset/declaration-emit-per-entrypoint.md";
    const documents = [
      "../../apps/docs/src/content/docs/project-structure.md",
      ...(existsSync(path.join(PACKAGE_ROOT, changeset)) ? [changeset] : []),
    ];
    expect(
      documents.map((document) => ({
        document,
        list: documentedAuthoringTypeSignatures(document),
      })),
    ).toEqual(documents.map((document) => ({ document, list: expected })));
  });
});
