/**
 * The L2 module-graph closure scan for Drizzle reachability.
 *
 * Walks the relative-import closure of every published entrypoint — at
 * SOURCE grain (this package's own `.ts` files) and at DIST grain (the
 * shipped, tree-shaken `.js`/`.cjs` artifacts under `dist/`) — and reports,
 * for each entrypoint, whether the walk reaches a `drizzle-orm*` specifier.
 * Two edge kinds are tracked (`static`, the four import/export/require forms;
 * `dynamic`, a relative `await import(...)`), because after this design a
 * portable entrypoint may legitimately defer Drizzle behind a dynamic import,
 * and I2/I3 must be able to tell "reaches Drizzle eagerly" from "reaches
 * Drizzle only if the deferred branch runs" apart. `WalkMode` names which
 * question a given finding answers: `load` follows only static edges (what
 * Node resolves at module-load time); `deferred` follows both.
 *
 * The expectation table (`classifyEntrypoints`) is derived from
 * `package.json#exports` minus a named adapter set (`ADAPTER_ENTRYPOINTS`),
 * so a newly published entrypoint is in scope by default and must be
 * classified — never silently "portable" by omission, never silently
 * skipped.
 *
 * This module is imported by `tests/drizzle-reachability.test.ts` (which
 * records today's measured baseline as the ratchet) and by
 * `tests/entrypoint-rendering-parity.test.ts` (which cross-checks derived
 * source roots against the tsconfig/vitest renderings). It also has a CLI
 * arm for manual reproduction — see the module's acceptance checklist in
 * `design-ws8-port-isolation.md`.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

/** Whether an edge was declared with static import/export/require syntax, or a dynamic `import()`. */
export type EdgeKind = "static" | "dynamic";

/** `load` follows only static edges; `deferred` additionally follows dynamic-import edges. */
export type WalkMode = "load" | "deferred";

/** Which half of a dual-format shipped artifact a dist-grain finding describes. */
export type ArtifactFormat = "import" | "require";

/**
 * An entrypoint's expected shape, derived from `package.json#exports` minus
 * `ADAPTER_ENTRYPOINTS`.
 */
export type EntrypointClassification =
  "portable" | "adapter-static" | "adapter-dynamic-only";

/** Whether a walk reached a `drizzle-orm*` specifier. */
export type ReachabilityVerdict = "clean" | "dirty";

/** One import/export/require edge out of a module, as extracted from its AST. */
export type ModuleEdge = Readonly<{ specifier: string; kind: EdgeKind }>;

/** One hop in a reported chain: `from` the importing module (or the hit module for the final hop), `to` the resolved file (or, on the final hop, the offending specifier text). */
export type ChainEdge = Readonly<{ from: string; to: string; kind: EdgeKind }>;

/** The verdict for one entrypoint at one grain and one walk mode. */
export type ReachabilityFinding = Readonly<{
  entrypoint: string;
  root: string;
  mode: WalkMode;
  verdict: ReachabilityVerdict;
  /** The Drizzle specifier that ended the walk. Present iff `verdict === "dirty"`. */
  specifier?: string;
  /** The shortest chain from `root` to `specifier`. Present iff `verdict === "dirty"`. */
  chain?: readonly ChainEdge[];
}>;

/**
 * A dist-grain finding additionally names which artifact format it was
 * measured against. Named `DistFinding` (not the unicorn-preferred spelling)
 * to match `--grain=dist` and `dist/` — the design's own binding vocabulary,
 * which downstream batches (B4, B4b, B5) import by this exact name.
 */
// eslint-disable-next-line unicorn/name-replacements -- "dist" mirrors the `dist/` build output and `--grain=dist`; renaming would break the design's binding export surface downstream batches import.
export type DistFinding = ReachabilityFinding &
  Readonly<{ format: ArtifactFormat }>;

/** A named severance simulation: the source files whose Drizzle-reaching edges are dropped. */
export type SeveranceStage = Readonly<{
  name: string;
  severedModules: readonly string[];
}>;

/** A declared, reviewed exception to "this entrypoint must eventually be clean". */
export type PortabilityExemption = Readonly<{
  entrypoint: string;
  reason: string;
  followUp: string;
}>;

/**
 * Matches `drizzle-orm`, `drizzle-orm/*`, `drizzle-kit`, `drizzle-kit/*`, any
 * other `drizzle-*` package, and the `@drizzle-team/*` scope — the full
 * lockfile breadth of "a Drizzle package", not just the one this repo happens
 * to depend on today.
 */
export const DRIZZLE_SPECIFIER_PATTERN =
  /^(drizzle-orm|drizzle-kit|drizzle-|@drizzle-team\/)/;

/**
 * The published entrypoints that are EXPECTED to reach Drizzle, and how.
 *
 * The seven `./adapters/drizzle/*` entrypoints are `adapter-static`: each
 * one's module tree imports a Drizzle package as a value, so it measures
 * dirty at both grains, in every mode and format. Six take a
 * caller-constructed Drizzle handle directly; `./adapters/drizzle/engine`'s
 * one value export (`createSqlBackend`) takes a caller-assembled engine
 * profile instead, but its module tree imports the shared member modules
 * that construct Drizzle-backed row access (`contribution-materializations.ts`
 * and its `drizzle-orm` import, reached through
 * `engine/members/contribution-members.ts`), so it reaches Drizzle exactly
 * the same way the other six do. The two "batteries included" entrypoints
 * (`./sqlite/local`, `./postgres/pglite`) are `adapter-dynamic-only`: their
 * factories moved their connection construction behind an `await
 * import(...)` of a sibling `*-store-impl.ts` module, so Node's module
 * loader never resolves `drizzle-orm` for them (`load` is clean) unless the
 * factory actually runs (`deferred` is dirty) — which is also what makes the
 * typed missing-peer refusal in `src/backend/missing-peer-ledger.ts`
 * reachable in the first place. This is a reviewed diff in this table,
 * never a silent flip: every other published entrypoint not listed here is
 * `portable` by default and must go clean.
 */
export const ADAPTER_ENTRYPOINTS: Readonly<
  Record<string, "adapter-static" | "adapter-dynamic-only">
> = {
  "./adapters/drizzle/sqlite": "adapter-static",
  "./adapters/drizzle/postgres": "adapter-static",
  "./adapters/drizzle/postgres/pglite": "adapter-static",
  "./adapters/drizzle/sqlite/local": "adapter-static",
  "./adapters/drizzle/sqlite/libsql": "adapter-static",
  "./adapters/drizzle/indexes": "adapter-static",
  "./adapters/drizzle/engine": "adapter-static",
  "./sqlite/local": "adapter-dynamic-only",
  "./postgres/pglite": "adapter-dynamic-only",
};

/**
 * Entrypoints that cannot be made portable this phase, with the reason and
 * the workstream that owns closing them. Ships EMPTY: an entrypoint that is
 * not clean and not in {@link ADAPTER_ENTRYPOINTS} is a defect, not a
 * candidate for a quiet exemption.
 */
export const PORTABILITY_EXEMPTIONS: readonly PortabilityExemption[] = [];

/**
 * The three severance routes (R-axis, R-migrate, R-removals — see
 * `design-ws8-port-isolation.md` §3.1), simulated one group at a time so the
 * severance stages this design promises are reproducible before any source
 * file actually changes.
 */
export const SIMULATED_SEVERANCE_STAGES: readonly SeveranceStage[] = [
  { name: "baseline", severedModules: [] },
  {
    name: "axis+migrate",
    severedModules: [
      "src/store/claims/axis.ts",
      "src/backend/migrate-recorded-time.ts",
      "src/backend/migrate-vectors.ts",
    ],
  },
  {
    name: "axis+migrate+removals",
    severedModules: [
      "src/store/claims/axis.ts",
      "src/backend/migrate-recorded-time.ts",
      "src/backend/migrate-vectors.ts",
      "src/store/materialize-removals.ts",
    ],
  },
];

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Resolves a {@link SIMULATED_SEVERANCE_STAGES} entry by name, throwing (and
 * naming every valid stage) rather than degrading to baseline on an
 * unrecognised name. Single owner for stage-name lookup: both the CLI's
 * `--stage` flag and the test suite's stage lookups call this — an
 * unrecognised name must fail loudly in both places, not just one.
 */
export function resolveSeveranceStage(name: string): SeveranceStage {
  const stage = SIMULATED_SEVERANCE_STAGES.find(
    (candidate) => candidate.name === name,
  );
  if (stage === undefined) {
    const validNames = SIMULATED_SEVERANCE_STAGES.map(
      (candidate) => candidate.name,
    ).join(", ");
    throw new Error(
      `Unknown severance stage ${JSON.stringify(name)}. Valid stage names: ${validNames}.`,
    );
  }
  return stage;
}

type ExportsEntry = Readonly<{
  types: string;
  import: string;
  require: string;
}>;

type PackageJsonShape = Readonly<{
  exports: Readonly<Record<string, ExportsEntry>>;
}>;

function readPackageJson(): PackageJsonShape {
  const text = fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8");
  return JSON.parse(text) as PackageJsonShape;
}

function exportsEntryFor(entrypoint: string): ExportsEntry {
  const packageJson = readPackageJson();
  const exportsEntry = packageJson.exports[entrypoint];
  if (exportsEntry === undefined) {
    throw new Error(
      `No published entrypoint named ${JSON.stringify(entrypoint)} in package.json#exports.`,
    );
  }
  return exportsEntry;
}

/** Every published entrypoint, classified as `portable` or one of the adapter arms. */
export function classifyEntrypoints(): Readonly<
  Record<string, EntrypointClassification>
> {
  const packageJson = readPackageJson();
  const classification: Record<string, EntrypointClassification> = {};
  for (const entrypoint of Object.keys(packageJson.exports)) {
    classification[entrypoint] = ADAPTER_ENTRYPOINTS[entrypoint] ?? "portable";
  }
  return classification;
}

type ModuleFileExtraction = Readonly<{
  edges: readonly ModuleEdge[];
  computedSpecifierSites: number;
}>;

function scriptKindForFile(filePath: string): ts.ScriptKind {
  return filePath.endsWith(".ts") || filePath.endsWith(".tsx") ?
      ts.ScriptKind.TS
    : ts.ScriptKind.JS;
}

/**
 * Parses one module file and extracts every import/export/require edge,
 * counting the residual — a `require`/`import()` call whose argument is not
 * a string literal — separately, because a computed specifier names no
 * traversable edge at all.
 *
 * One AST walk, so {@link collectModuleEdges} and
 * {@link countComputedSpecifierSites} cannot drift against each other.
 */
function extractModuleFile(filePath: string): ModuleFileExtraction {
  const text = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForFile(filePath),
  );

  const edges: ModuleEdge[] = [];
  let computedSpecifierSites = 0;

  function recordSpecifierArgument(
    specifierExpression: ts.Expression,
    kind: EdgeKind,
  ): void {
    if (ts.isStringLiteral(specifierExpression)) {
      edges.push({ specifier: specifierExpression.text, kind });
    } else {
      computedSpecifierSites += 1;
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      recordSpecifierArgument(node.moduleSpecifier, "static");
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined
    ) {
      // Covers both `export { x } from "specifier"` (ESTree's
      // ExportNamedDeclaration) and `export * from "specifier"`
      // (ExportAllDeclaration) — the TypeScript compiler API represents
      // both as one ExportDeclaration node, distinguished only by whether
      // `exportClause` is present, which does not matter for edge extraction.
      recordSpecifierArgument(node.moduleSpecifier, "static");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [firstArgument] = node.arguments;
        if (firstArgument !== undefined) {
          recordSpecifierArgument(firstArgument, "dynamic");
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        const [firstArgument] = node.arguments;
        if (firstArgument !== undefined) {
          recordSpecifierArgument(firstArgument, "static");
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return { edges, computedSpecifierSites };
}

/** Every import/export/require edge a module declares, in source order. */
export function collectModuleEdges(filePath: string): readonly ModuleEdge[] {
  return extractModuleFile(filePath).edges;
}

/**
 * The number of `require`/`import()` call sites in `filePath` whose argument
 * is not a string literal — the declared residual a traversal cannot follow.
 */
export function countComputedSpecifierSites(filePath: string): number {
  return extractModuleFile(filePath).computedSpecifierSites;
}

type TsupEntryMap = Readonly<Record<string, string>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let cachedTsupEntryMap: TsupEntryMap | undefined;

/**
 * Loads `tsup.config.ts#entry`, requiring — not re-deriving — the dist↔src
 * map's one owner. Narrows the config's default export to a plain object
 * with an `entry` map, throwing a named error otherwise so a future
 * function-form or array-form `tsup.config.ts` fails loudly here rather than
 * silently desyncing {@link sourceRootForEntrypoint}'s cross-check.
 */
function loadTsupEntryMap(): TsupEntryMap {
  if (cachedTsupEntryMap !== undefined) return cachedTsupEntryMap;

  const require = createRequire(import.meta.url);
  const configModule = require(
    path.join(PACKAGE_ROOT, "tsup.config.ts"),
  ) as Readonly<{ default: unknown }>;
  const config = configModule.default;

  if (!isPlainObject(config)) {
    throw new Error(
      "tsup.config.ts's default export is not a plain object; drizzle-reachability-scan.ts's dist<->src derivation requires defineConfig's object form.",
    );
  }
  const entry = config["entry"];
  if (!isPlainObject(entry)) {
    throw new Error(
      "tsup.config.ts's default export has no plain-object `entry` map; drizzle-reachability-scan.ts's dist<->src derivation depends on it.",
    );
  }

  const entryMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value !== "string") {
      throw new TypeError(
        `tsup.config.ts#entry[${JSON.stringify(key)}] is not a string.`,
      );
    }
    entryMap[key] = value;
  }
  cachedTsupEntryMap = entryMap;
  return entryMap;
}

/**
 * The source `.ts` file an entrypoint's shipped artifact is built from,
 * derived from `exports[entrypoint].import` (strip `./dist/`, `.js` -> `.ts`,
 * prefix `src/`) and cross-checked against `tsup.config.ts#entry` so the
 * dist<->src map has exactly one owner. Throws a named error, naming the
 * entrypoint, on any disagreement.
 */
export function sourceRootForEntrypoint(entrypoint: string): string {
  const exportsEntry = exportsEntryFor(entrypoint);
  const importPath = exportsEntry.import;

  const DIST_PREFIX = "./dist/";
  if (!importPath.startsWith(DIST_PREFIX)) {
    throw new Error(
      `Entrypoint ${JSON.stringify(entrypoint)}: import path ${JSON.stringify(importPath)} does not start with "${DIST_PREFIX}".`,
    );
  }
  const withoutDistributionPrefix = importPath.slice(DIST_PREFIX.length);
  if (!withoutDistributionPrefix.endsWith(".js")) {
    throw new Error(
      `Entrypoint ${JSON.stringify(entrypoint)}: import path ${JSON.stringify(importPath)} does not end with ".js".`,
    );
  }
  const outputKey = withoutDistributionPrefix.slice(0, -".js".length);
  const derivedRoot = `src/${outputKey}.ts`;

  const tsupEntryMap = loadTsupEntryMap();
  const tsupSourcePath = tsupEntryMap[outputKey];
  if (tsupSourcePath === undefined) {
    throw new Error(
      `Entrypoint ${JSON.stringify(entrypoint)}: no tsup.config.ts#entry row named ${JSON.stringify(outputKey)}.`,
    );
  }
  if (tsupSourcePath !== derivedRoot) {
    throw new Error(
      `Entrypoint ${JSON.stringify(entrypoint)}: derived source root ${JSON.stringify(derivedRoot)} disagrees with tsup.config.ts#entry[${JSON.stringify(outputKey)}] = ${JSON.stringify(tsupSourcePath)}.`,
    );
  }

  return derivedRoot;
}

/**
 * Both shipped artifact paths for an entrypoint, verbatim from
 * `exports[entrypoint]` — never a `dist/**\/index.js` glob, which misses
 * `local-store.*` / `pglite-store.*`.
 */
// eslint-disable-next-line unicorn/name-replacements -- "dist" mirrors the `dist/` build output and `--grain=dist`; renaming would break the design's binding export surface downstream batches import.
export function distRootsForEntrypoint(
  entrypoint: string,
): Readonly<Record<ArtifactFormat, string>> {
  const exportsEntry = exportsEntryFor(entrypoint);
  return { import: exportsEntry.import, require: exportsEntry.require };
}

/** Whether `pnpm build` has produced shipped artifacts to scan at dist grain. */
// eslint-disable-next-line unicorn/name-replacements -- "dist" mirrors the `dist/` build output and `--grain=dist`; renaming would break the design's binding export surface downstream batches import.
export function distArtifactsPresent(): boolean {
  return (
    fs.existsSync(path.join(PACKAGE_ROOT, "dist", "index.js")) &&
    fs.existsSync(path.join(PACKAGE_ROOT, "dist", "index.cjs"))
  );
}

function normalizeRelative(baseDir: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(baseDir, specifier));
}

/**
 * Memoizes a resolver keyed on `${fromFile}\0${specifier}`. The BFS below
 * revisits the same (file, specifier) pair across many entrypoints' walks —
 * every entrypoint whose closure passes through a shared module re-resolves
 * that module's edges — so caching here is what keeps the whole-tree scan
 * fast rather than a correctness concern.
 */
function memoizeRelativeResolver(
  resolver: (fromFile: string, specifier: string) => string | undefined,
): (fromFile: string, specifier: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (fromFile, specifier) => {
    const key = `${fromFile}\0${specifier}`;
    if (cache.has(key)) return cache.get(key);
    const resolved = resolver(fromFile, specifier);
    cache.set(key, resolved);
    return resolved;
  };
}

/** Resolves a relative specifier against the SOURCE tree: exact `.ts`, `.tsx`, then `/index.ts`. */
const resolveSourceRelative = memoizeRelativeResolver((fromFile, specifier) => {
  const baseDir = path.posix.dirname(fromFile);
  const joined = normalizeRelative(baseDir, specifier);
  const candidates = [`${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(PACKAGE_ROOT, candidate))) return candidate;
  }
  return;
});

/** Resolves a relative specifier against a DIST artifact tree: exact, then `.js`, `.cjs`, `.mjs`. */
const resolveDistributionRelative = memoizeRelativeResolver(
  (fromFile, specifier) => {
    const baseDir = path.posix.dirname(fromFile);
    const joined = normalizeRelative(baseDir, specifier);
    const candidates = [
      joined,
      `${joined}.js`,
      `${joined}.cjs`,
      `${joined}.mjs`,
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(PACKAGE_ROOT, candidate))) return candidate;
    }
    return;
  },
);

/** Resolves a dist ROOT (an `exports[key].import`/`.require` value) the same way: exact, then `.js`, `.cjs`, `.mjs`. */
function resolveDistributionRoot(rawExportsPath: string): string {
  const normalized = rawExportsPath.replace(/^\.\//, "");
  const candidates = [
    normalized,
    `${normalized}.js`,
    `${normalized}.cjs`,
    `${normalized}.mjs`,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(PACKAGE_ROOT, candidate))) return candidate;
  }
  throw new Error(
    `Could not resolve a dist artifact for exports path ${JSON.stringify(rawExportsPath)} (tried exact, .js, .cjs, .mjs).`,
  );
}

/**
 * Drops, for a severed module, (i) its own Drizzle-specifier edges and (ii)
 * its relative edges resolving under `src/backend/drizzle/`. Nothing else
 * changes: an unrelated module's edges are untouched, and the severed
 * module's OTHER edges (to a sibling core module, say) still stand.
 */
function applySeverance(
  file: string,
  edges: readonly ModuleEdge[],
  severedModules: ReadonlySet<string>,
): readonly ModuleEdge[] {
  if (!severedModules.has(file)) return edges;
  return edges.filter((edge) => {
    if (DRIZZLE_SPECIFIER_PATTERN.test(edge.specifier)) return false;
    if (edge.specifier.startsWith(".")) {
      const resolved = resolveSourceRelative(file, edge.specifier);
      if (resolved?.startsWith("src/backend/drizzle/") === true) {
        return false;
      }
    }
    return true;
  });
}

type WalkParams = Readonly<{
  entrypoint: string;
  root: string;
  grain: "source" | "dist";
  mode: WalkMode;
  severedModules: ReadonlySet<string>;
  resolveRelative: (fromFile: string, specifier: string) => string | undefined;
}>;

/**
 * BFS from `root` so the first Drizzle hit yields the shortest chain. `mode`
 * decides which edges are followed at all (`load` drops every dynamic edge
 * before traversal, so a Drizzle hit reachable only through one is invisible
 * to it, exactly as Node's own module loader would never resolve it);
 * `severedModules` (source grain only) removes edges per
 * {@link applySeverance} before either filter applies.
 */
/**
 * Raw (pre-severance) edges, memoized across every {@link walk} call in this
 * process — every entrypoint's closure re-visits many shared modules (every
 * portable entrypoint eventually reaches `src/core/index.ts`, say), and
 * severance simulation is applied on top of this cache rather than baked
 * into it, since which edges are dropped depends on which stage is walking.
 */
const rawEdgeCache = new Map<string, readonly ModuleEdge[]>();

function rawEdgesFor(file: string): readonly ModuleEdge[] {
  let cached = rawEdgeCache.get(file);
  if (cached === undefined) {
    cached = collectModuleEdges(path.join(PACKAGE_ROOT, file));
    rawEdgeCache.set(file, cached);
  }
  return cached;
}

function walk(params: WalkParams): ReachabilityFinding {
  const { entrypoint, root, mode, grain, severedModules, resolveRelative } =
    params;

  const visited = new Set<string>([root]);
  const parent = new Map<string, Readonly<{ from: string; kind: EdgeKind }>>();
  const queue: string[] = [root];

  function edgesFor(file: string): readonly ModuleEdge[] {
    const cached = rawEdgesFor(file);
    return grain === "source" ?
        applySeverance(file, cached, severedModules)
      : cached;
  }

  function buildChain(
    hitFile: string,
    finalSpecifier: string,
    finalKind: EdgeKind,
  ): readonly ChainEdge[] {
    const chain: ChainEdge[] = [
      { from: hitFile, to: finalSpecifier, kind: finalKind },
    ];
    let current = hitFile;
    while (current !== root) {
      const parentEntry = parent.get(current);
      if (parentEntry === undefined) break;
      chain.unshift({
        from: parentEntry.from,
        to: current,
        kind: parentEntry.kind,
      });
      current = parentEntry.from;
    }
    return chain;
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    for (const edge of edgesFor(current)) {
      if (mode === "load" && edge.kind === "dynamic") continue;

      if (DRIZZLE_SPECIFIER_PATTERN.test(edge.specifier)) {
        return {
          entrypoint,
          root,
          mode,
          verdict: "dirty",
          specifier: edge.specifier,
          chain: buildChain(current, edge.specifier, edge.kind),
        };
      }

      if (!edge.specifier.startsWith(".")) continue;

      const resolved = resolveRelative(current, edge.specifier);
      if (resolved !== undefined && !visited.has(resolved)) {
        visited.add(resolved);
        parent.set(resolved, { from: current, kind: edge.kind });
        queue.push(resolved);
      }
    }
  }

  return { entrypoint, root, mode, verdict: "clean" };
}

/**
 * Walks the SOURCE-grain relative-import closure of every published
 * entrypoint, at both walk modes. `options.severedModules` simulates one of
 * {@link SIMULATED_SEVERANCE_STAGES} (or an arbitrary set, for the CLI's
 * `--sever` flag) without any source file actually changing.
 */
export function scanSourceReachability(
  options?: Readonly<{ severedModules?: readonly string[] }>,
): readonly ReachabilityFinding[] {
  const severedModules = new Set(options?.severedModules);
  const classifications = classifyEntrypoints();
  const findings: ReachabilityFinding[] = [];

  for (const entrypoint of Object.keys(classifications)) {
    const root = sourceRootForEntrypoint(entrypoint);
    for (const mode of ["load", "deferred"] as const) {
      findings.push(
        walk({
          entrypoint,
          root,
          grain: "source",
          mode,
          severedModules,
          resolveRelative: resolveSourceRelative,
        }),
      );
    }
  }
  return findings;
}

/**
 * Walks the DIST-grain relative-import closure of every published
 * entrypoint's shipped artifact, in both formats and both walk modes.
 * Requires {@link distArtifactsPresent} — call after `pnpm build`.
 */
// eslint-disable-next-line unicorn/name-replacements -- "dist" mirrors the `dist/` build output and `--grain=dist`; renaming would break the design's binding export surface downstream batches import.
export function scanDistReachability(): readonly DistFinding[] {
  const classifications = classifyEntrypoints();
  const findings: DistFinding[] = [];

  for (const entrypoint of Object.keys(classifications)) {
    const roots = distRootsForEntrypoint(entrypoint);
    for (const format of ["import", "require"] as const) {
      const root = resolveDistributionRoot(roots[format]);
      for (const mode of ["load", "deferred"] as const) {
        const finding = walk({
          entrypoint,
          root,
          grain: "dist",
          mode,
          severedModules: new Set(),
          resolveRelative: resolveDistributionRelative,
        });
        findings.push({ ...finding, format });
      }
    }
  }
  return findings;
}

/** Renders findings as a table with chains and an `N / M dirty` summary — a reporter, not a gate. */
export function formatFindings(
  findings: readonly ReachabilityFinding[],
): string {
  const lines: string[] = [];
  for (const finding of findings) {
    const format =
      "format" in finding ? ` [${(finding as DistFinding).format}]` : "";
    lines.push(
      `${finding.entrypoint}${format} (${finding.mode}): ${finding.verdict}`,
    );
    if (finding.chain !== undefined) {
      for (const edge of finding.chain) {
        const arrow = edge.kind === "dynamic" ? "~>" : "->";
        lines.push(`    ${edge.from} ${arrow} ${edge.to}`);
      }
    }
  }
  const dirtyCount = findings.filter(
    (finding) => finding.verdict === "dirty",
  ).length;
  lines.push(`${dirtyCount} / ${findings.length} dirty`);
  return lines.join("\n");
}

function parseFlag(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = args.find((argument) => argument.startsWith(prefix));
  return found?.slice(prefix.length);
}

/** Whether `--<name>` appears among `args` with no `=<value>` — a valueless flag a shell user typed but the parser cannot honor. */
function hasValuelessFlag(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/** The two grains {@link scanDistReachability}/{@link scanSourceReachability} support. */
export type Grain = "source" | "dist";
const VALID_GRAINS: readonly Grain[] = ["source", "dist"];

/**
 * Resolves the CLI's `--grain` flag, throwing (and naming every valid grain)
 * rather than silently falling through to the source-grain scan on a typo
 * (`--grain=dsit` previously printed the SOURCE grain's numbers with no
 * diagnostic under a command line asking for `dist`) — the same
 * throw-rather-than-degrade contract {@link resolveSeveranceStage} applies to
 * `--stage`.
 */
export function resolveGrain(name: string): Grain {
  if ((VALID_GRAINS as readonly string[]).includes(name)) {
    return name as Grain;
  }
  throw new Error(
    `Unknown grain ${JSON.stringify(name)}. Valid grains: ${VALID_GRAINS.join(", ")}.`,
  );
}

/**
 * Resolves `--stage`/`--sever` into the `severedModules` list `runCli` passes
 * to {@link scanSourceReachability}. Single owner for the refuse-or-apply
 * decision on both flags together, since there is exactly one
 * `severedModules` list to build from them:
 *
 * - `--stage` and `--sever` cannot both be given — silently preferring one
 *   over the other (as the previous implementation did, always picking
 *   `--sever` when both were present) is an accepted option applied to the
 *   wrong value, which is indistinguishable from ignoring the other one.
 * - A valueless `--stage` (bare `--stage`, or the space-separated `--stage
 *   axis+migrate` a shell user might reasonably type, which argv splits into
 *   two separate elements neither of which matches the `--stage=` prefix)
 *   throws naming the required `--stage=<name>` form, rather than silently
 *   reporting the unsevered baseline.
 */
export function resolveSeveredModules(
  args: readonly string[],
): readonly string[] {
  const stageName = parseFlag(args, "stage");
  const severFlag = parseFlag(args, "sever");

  if (stageName !== undefined && severFlag !== undefined) {
    throw new Error(
      "--stage and --sever cannot both be given; pass --stage=<name> to select a SIMULATED_SEVERANCE_STAGES entry, or --sever=<comma-separated modules> for an explicit list, but not both.",
    );
  }
  if (hasValuelessFlag(args, "stage")) {
    const validNames = SIMULATED_SEVERANCE_STAGES.map(
      (stage) => stage.name,
    ).join(", ");
    throw new Error(
      `--stage requires a value in the form --stage=<name>. Valid stage names: ${validNames}.`,
    );
  }
  if (severFlag !== undefined) return severFlag.split(",");
  if (stageName !== undefined)
    return resolveSeveranceStage(stageName).severedModules;
  return [];
}

function runCli(): void {
  const args = process.argv.slice(2);
  const grain = resolveGrain(parseFlag(args, "grain") ?? "source");
  const json = args.includes("--json");

  if (grain === "dist") {
    const findings = scanDistReachability();
    console.log(
      json ? JSON.stringify(findings, undefined, 2) : formatFindings(findings),
    );
    return;
  }

  const severedModules = resolveSeveredModules(args);

  const findings = scanSourceReachability({ severedModules });
  console.log(
    json ? JSON.stringify(findings, undefined, 2) : formatFindings(findings),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runCli();
}
