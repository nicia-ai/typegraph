/**
 * THE TYPE-AWARE ACCESS SCANNER for {@link OptionalGraphBackendMember}s (I6,
 * T21) — the live counterpart to `tests/capability-operation-cover.test.ts`
 * (T11b), which reads the COMMITTED baseline fixture instead.
 *
 * For every optional `GraphBackend` member — derived at runtime from the
 * checker, never hand-copied (see {@link deriveOptionalGraphBackendMembers})
 * — this walks `src/**` (minus the exclusions below) for every syntactic
 * shape that reads it off a receiver, classifies each live access, and
 * reports the seven-bucket partition `tests/bundle-member-access.test.ts`
 * pins: `pilot`, `annotated-residue`, `statically-required`, `reasoned`,
 * `deferred`, `excluded` ({@link EXCLUDED_ACCESS_SITES} — the WS1-era
 * `backend/drizzle/trusted-import.ts` carve-out, made visible and exactly
 * pinned rather than hidden behind a file-pattern exclusion), and
 * (implicitly, by omission) not-an-access.
 *
 * ## The receiver test, in two arms
 *
 * A candidate node's member name matching one of the 92 optional members is
 * necessary but not sufficient — `currentState.ctx.vectorStrategy`
 * (`query/compiler/standard-pass-pipeline.ts`) also spells `.vectorStrategy`
 * off SOME receiver, and that receiver is a compiler-pass context, not a
 * `GraphBackend` slice. A candidate is a genuine access only when its
 * (non-nullable) receiver type resolves the member to a declaration that:
 *
 * - (a) **`"declared"`**: lives in `src/backend/types.ts` — this is
 *   `GraphBackend`, `TransactionBackend`, and every `Pick<>`/`Omit<>`/role
 *   alias built from them, because `Pick<GraphBackend, K>` over a concrete
 *   object type keeps the ORIGINAL property symbol rather than synthesizing
 *   a new one; or
 * - (b) **`"derived"`**: is itself a `PropertySignature` outside
 *   `types.ts` whose OWN type node textually mentions `GraphBackend`,
 *   `TransactionBackend` or `HistoryStoreBackend` — the shape a bespoke
 *   role type takes when it re-exposes a member via
 *   `NonNullable<GraphBackend["executeStatement"]>` rather than a `Pick`.
 *
 * Neither arm matching means the name match is coincidental — the candidate
 * is dropped, not reported. `NOT_AN_ACCESS_SITES` below is a hand-curated
 * catalog of exactly this: near-misses a naive (grep-shaped) scanner would
 * count that this one correctly excludes, kept so a regression that widens
 * the receiver test has something concrete to fail against.
 *
 * ## The brand skip (I21)
 *
 * A member bound by `bind.ts` (`bindCore`/`bindExtra`/…) comes back branded
 * `{ [BUNDLE_BINDING]: true }` — a unique symbol TypeScript spells
 * `__@BUNDLE_BINDING@<id>` in `checker.getPropertiesOfType`'s output. A
 * candidate whose (non-nullable) receiver type carries a property whose name
 * CONTAINS that substring is a read of an already-bound value, not a raw
 * port read, and is dropped rather than reported. This is the mechanism that
 * makes `pilot === 0` reachable at all — delete the brand (Mutation D) and
 * every rewired call site's binding destructure reappears as a raw access.
 *
 * ## Classification
 *
 * A member that is a `CAPABILITY_BUNDLES` core/extra member classifies (in
 * order) as `statically-required` (the `(file, member)` pair is named in
 * {@link STATICALLY_REQUIRED_SITES}), `annotated-residue` (SOME registry
 * operation `sites[]` entry with the same `(file, member)` — lines are never
 * read — carries a `rewiring` annotation) or `pilot` (neither). A member
 * that is instead in `UNBUNDLED_OPTIONAL_MEMBERS` classifies by its own
 * `kind` (`reasoned`/`deferred`). A member in neither partition is a hard
 * error naming it — the registry's totality proof is compile-time; this is
 * its runtime twin over the members the scanner can actually observe being
 * read.
 *
 * ## Honest statement of its limits
 *
 * - **It sees VALUE accesses only.** A member named inside a string or
 *   template literal — `"...backend.executeStatement..."`,
 *   `` `${prefix}.executeStatement` `` — is invisible by construction: the
 *   candidate node types are `PropertyAccessExpression`,
 *   `ElementAccessExpression` (string-literal key) and `BindingElement`,
 *   never a bare string token. `NOT_AN_ACCESS_SITES` documents the one
 *   pilot-relevant instance so a reader does not mistake the omission for an
 *   oversight.
 * - **`(file, line, member)` collapses onto ACCESS NODES, not physical
 *   lines.** Two accesses on one source line — `backend.tableNames ?
 *   createSqlSchema(backend.tableNames) : undefined` — are two rows sharing
 *   a `line`, which is why `store/store.ts`'s single `tableNames` line
 *   contributes 2 to that member's count.
 * - **Renaming a bound import defeats the brand skip only in the direction
 *   that matters least.** An IMPORT rename of a bound accessor
 *   (`bindCore as customName`) still calls the real function and returns the
 *   really-branded value, so the skip still applies — there is no bypass
 *   here, unlike the recursion-inventory scanner's documented one for
 *   `assumeRecursiveTraversalSupported`.
 * - **Dynamic `port[name]` indexing survives only inside
 *   `src/backend/capabilities/bind.ts`**, which is excluded from the scanned
 *   scope by design (it is the accessor's OWN internal plumbing, not a
 *   consumer read) — Contract R1–R2 residue is therefore nil inside the
 *   scanned scope, not merely unmeasured.
 */
import path from "node:path";

import * as ts from "typescript";

import {
  CAPABILITY_BUNDLES,
  type CapabilityBundleDefinition,
  type CapabilityBundleOperationSite,
  type OptionalGraphBackendMember,
  UNBUNDLED_OPTIONAL_MEMBERS,
  type UnbundledOptionalMember,
} from "../src/backend/capabilities/bundle-registry";

/** How one live access classifies, per §Classification above. */
export type BundleMemberAccessClass =
  | "pilot"
  | "annotated-residue"
  | "reasoned"
  | "deferred"
  | "statically-required"
  | "excluded";

/** One member access node the scanner accepted (passed the receiver test, not brand-skipped). */
export type BundleMemberAccessRow = Readonly<{
  /** Package-relative, POSIX-separated, relative to `src/`. */
  file: string;
  /** 1-based line of the access node. */
  line: number;
  member: OptionalGraphBackendMember;
  class: BundleMemberAccessClass;
  /** `checker.typeToString` of the receiver expression's own type. */
  receiverType: string;
  /** Which arm of the receiver test accepted this candidate. */
  arm: "declared" | "derived";
}>;

export type BundleMemberAccessScan = Readonly<{
  rows: readonly BundleMemberAccessRow[];
  byClass: Readonly<Record<BundleMemberAccessClass, number>>;
  /** Live count per member name, over every one of the 92 optional members (0 included). */
  perMember: Readonly<Record<string, number>>;
}>;

/**
 * The two `(file, member)` pairs whose executeStatement is a STATIC compile
 * time requirement (`Required<Pick<...>>` / `NonNullable<...>`-typed, never
 * absent by construction) rather than a runtime-verdict-gated read. Asserted
 * POSITIVELY by the test — each must appear in the scan output — so a
 * regression in the receiver test's arm (b) that stops resolving these
 * fails loudly instead of silently shrinking the bucket.
 */
export const STATICALLY_REQUIRED_SITES: readonly Readonly<{
  file: string;
  member: string;
  declaringType: string;
  reason: string;
}>[] = [
  {
    file: "store/materialize-removals.ts",
    member: "executeStatement",
    declaringType: "SchemaWriteTransactionBackend",
    reason:
      'SchemaWriteTransactionBackend (src/backend/types.ts) declares executeStatement as NonNullable<TransactionBackend["executeStatement"]> — the schema-write transaction always carries it.',
  },
  {
    file: "graph-merge/provenance-store.ts",
    member: "executeStatement",
    declaringType: "SidecarClaimPort",
    reason:
      "SidecarClaimPort's own executeStatement field is typed NonNullable<GraphBackend[\"executeStatement\"]> (arm b) — the claim's fenced transaction is required to run the drain statement.",
  },
];

/**
 * Candidates a naive (grep- or name-shaped) scanner would count that the
 * type-aware receiver test correctly drops — kept as a catalog so a reader
 * can tell "correctly excluded" from "not looked at", and so a future
 * regression that widens the receiver test has a concrete fixture to fail.
 * Asserted twice by the test: the `(file, member)` key never appears in the
 * live scan, and `snippet` still occurs verbatim in the file (so the
 * assertion cannot pass vacuously after an unrelated edit moves the line).
 */
export const NOT_AN_ACCESS_SITES: readonly Readonly<{
  file: string;
  member: string;
  snippet: string;
  reason: string;
}>[] = [
  {
    file: "store/recorded-capture/guards.ts",
    member: "executeStatement",
    snippet: "Recorded-time capture requires backend.executeStatement",
    reason:
      "the member is named inside an error-message string literal, not read off a receiver — string and template literals are never candidate nodes",
  },
  {
    file: "query/builder/read-instant-template.ts",
    member: "compileSql",
    snippet: "backend?.compileSql === undefined",
    reason:
      'the receiver is SqlCompilerBackend (Readonly<{ compileSql?: CompileSqlFunction }>, declared in this file) — a bespoke compile port whose compileSql field type ("CompileSqlFunction") names none of GraphBackend/TransactionBackend/HistoryStoreBackend, so neither receiver-test arm accepts it',
  },
  {
    file: "query/builder/read-instant-template.ts",
    member: "compileSql",
    snippet: "backend.compileSql(compiled)",
    reason:
      "the same bespoke SqlCompilerBackend receiver as the guard immediately above it",
  },
  {
    file: "query/compiler/standard-pass-pipeline.ts",
    member: "vectorStrategy",
    snippet: "currentState.ctx.vectorStrategy",
    reason:
      "M-4's compiler-context collision: PredicateCompilerContext (src/query/compiler/predicates.ts) declares its OWN \"vectorStrategy?: VectorStrategy\" field, unrelated to GraphBackend's member of the same name — neither receiver-test arm accepts it",
  },
];

/**
 * `src/backend/drizzle/**` used to be excluded wholesale (`/^backend\/drizzle\//`).
 * That directory-wide glob is broader than what Contract I2 actually ratified:
 * "backend implementations — outside the scanner's scope by construction (they
 * *are* the members)" names three specific files whose accesses are a backend
 * calling a member on an object it just built itself (`postgres.ts:1515`,
 * `sqlite.ts:2020` — `contributionMaterializer.rebuildContribution`; `contribution-
 * materializations.ts:1494,1694` — `executeStatement` on the always-present
 * `SchemaWriteTransactionBackend`). Those three are named below, individually.
 *
 * `backend/drizzle/trusted-import.ts` is NOT excluded by file pattern (B10):
 * its four accesses are classified `excluded` instead, via
 * {@link EXCLUDED_ACCESS_SITES} — a pinned, exactly-four inventory rather than
 * a glob hole, per the B9-checkpoint ruling ("Trusted-import gap: INVENTORIED
 * EXCLUSION, ruled"). Any OTHER file added under `backend/drizzle/**` is
 * in-scope by default — only these three are named here.
 */
const EXCLUDED_FILE_PATTERNS: readonly RegExp[] = [
  /^backend\/drizzle\/postgres\.ts$/,
  /^backend\/drizzle\/sqlite\.ts$/,
  /^backend\/drizzle\/contribution-materializations\.ts$/,
  /^backend\/types\.ts$/,
  /^backend\/graph-backend-keys\.ts$/,
  /^backend\/member-classes\.ts$/,
  /^store\/history-store-backend\.ts$/,
  /^backend\/capabilities\//,
];

/**
 * The exactly-four `backend/drizzle/trusted-import.ts` accesses this batch
 * (B10) makes VISIBLE rather than hiding them behind the old blanket file
 * exclusion: `requireRawExecution`'s `executeRaw` presence-check-and-return
 * (`:40`, `:46`) and `requireStatementExecution`'s equivalent for
 * `executeStatement` (`:52`, `:58`). Both receivers are a bare
 * `TransactionBackend` parameter — the same shape as the tracked
 * `identity/sql-target.ts` / `store/recorded-capture/guards.ts`
 * STATEMENT_EXECUTION sites, not a backend reading its own guaranteed member —
 * so these are genuine accesses, not self-reference (Contract I2 does not
 * apply). They are a permanent, WS1-era carve-out instead: `trusted-import.ts`
 * is a second, backend-owned write path by design (a bulk, all-or-nothing
 * ingestion session that takes the managed-write fence itself, per its own
 * `WRITE_PIPELINE_EXEMPTIONS` entry in `eslint/write-pipeline-inventory.mjs`),
 * never routed through the bundle model's verdict/binding split. Classified
 * `excluded` FIRST, before statically-required/annotated-residue/pilot/
 * reasoned/deferred, and never absorbed into the reasoned floor or the
 * deferred ceiling — this is a SEVENTH bucket with its own exactly-four pin,
 * asserted both directions by `tests/bundle-member-access.test.ts`: every
 * `snippet` occurs verbatim in the file (a vacuity guard), and every one of
 * these four appears in the scan with class `excluded`.
 */
export const EXCLUDED_ACCESS_SITES: readonly Readonly<{
  file: string;
  member: string;
  count: number;
  snippet: string;
  reason: string;
}>[] = [
  {
    file: "backend/drizzle/trusted-import.ts",
    member: "executeRaw",
    count: 1,
    snippet: "if (backend.executeRaw === undefined) {",
    reason:
      "requireRawExecution's presence guard (:40) — a second, backend-owned write path by design, never routed through the bundle model.",
  },
  {
    file: "backend/drizzle/trusted-import.ts",
    member: "executeRaw",
    count: 1,
    snippet: "return backend.executeRaw;",
    reason:
      "requireRawExecution's return (:46) — a second, backend-owned write path by design, never routed through the bundle model.",
  },
  {
    file: "backend/drizzle/trusted-import.ts",
    member: "executeStatement",
    count: 1,
    snippet: "if (backend.executeStatement === undefined) {",
    reason:
      "requireStatementExecution's presence guard (:52) — a second, backend-owned write path by design, never routed through the bundle model.",
  },
  {
    file: "backend/drizzle/trusted-import.ts",
    member: "executeStatement",
    count: 1,
    snippet: "return backend.executeStatement;",
    reason:
      "requireStatementExecution's return (:58) — a second, backend-owned write path by design, never routed through the bundle model.",
  },
];

/** Textual reference the "derived" receiver-test arm accepts (§ receiver test). */
const BACKEND_TYPE_REFERENCE_PATTERN =
  /\b(GraphBackend|TransactionBackend|HistoryStoreBackend)\b/;

const packageRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(packageRoot, "src");

function toSourceRelativePosixPath(fileName: string): string {
  return path.relative(sourceRoot, fileName).split(path.sep).join("/");
}

function isInScope(sourceRelativeFile: string): boolean {
  if (sourceRelativeFile.endsWith(".d.ts")) return false;
  return !EXCLUDED_FILE_PATTERNS.some((pattern) =>
    pattern.test(sourceRelativeFile),
  );
}

/**
 * Mirrors `tests/backend-derivation-scan.ts`'s `createPackageProgram` shape,
 * with root names filtered to `src/**` — this scanner never needs the
 * `tests/**`/`examples/**`/`scripts/**` trees the shared tsconfig also
 * includes.
 */
function createSourceProgram(): ts.Program {
  const configPath = path.join(packageRoot, "tsconfig.json");
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) {
    throw new Error(
      `Could not read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    packageRoot,
  );
  const sourceRootWithSeparator = `${sourceRoot}${path.sep}`;
  const rootNames = parsed.fileNames.filter((fileName) =>
    fileName.startsWith(sourceRootWithSeparator),
  );
  return ts.createProgram({ rootNames, options: parsed.options });
}

function requireSourceFile(
  program: ts.Program,
  relativePath: string,
): ts.SourceFile {
  const sourceFile = program.getSourceFile(
    path.join(packageRoot, relativePath),
  );
  if (sourceFile === undefined) {
    throw new Error(
      `Could not load ${relativePath} from the scanner's program.`,
    );
  }
  return sourceFile;
}

/**
 * The 88 optional `GraphBackend` members, read off the CHECKER rather than
 * hand-copied — a member added or removed from `GraphBackend` changes this
 * set automatically. The `size === 88` assertion is the scan's own
 * precondition: it throws, rather than silently scanning a stale set, the
 * moment `GraphBackend`'s optional surface moves without this scanner
 * (re-)running.
 */
function deriveOptionalGraphBackendMembers(
  checker: ts.TypeChecker,
  typesSourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const alias = typesSourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "GraphBackend",
  );
  if (alias === undefined) {
    throw new Error(
      `Could not find an exported "GraphBackend" type alias in ${typesSourceFile.fileName}.`,
    );
  }
  const symbol = checker.getSymbolAtLocation(alias.name);
  if (symbol === undefined) {
    throw new Error(
      'Could not resolve the symbol for the "GraphBackend" type alias.',
    );
  }
  const graphBackendType = checker.getDeclaredTypeOfSymbol(symbol);
  const optionalNames = checker
    .getPropertiesOfType(graphBackendType)
    .filter((property) => (property.flags & ts.SymbolFlags.Optional) !== 0)
    .map((property) => property.name);
  if (optionalNames.length !== 88) {
    throw new Error(
      `Expected exactly 88 optional GraphBackend members (the scan's own precondition); found ${optionalNames.length}. GraphBackend's optional surface has changed — re-derive every partition constant before trusting this scan.`,
    );
  }
  return new Set(optionalNames);
}

function bundleMemberNames(
  bundle: CapabilityBundleDefinition,
): readonly string[] {
  const core = bundle.kind === "gated" ? bundle.core : [];
  const extraMembers = (bundle.extras ?? []).flatMap((extra) => extra.members);
  return [...core, ...extraMembers];
}

function collectBundledMembers(): ReadonlySet<string> {
  const members = new Set<string>();
  for (const bundle of CAPABILITY_BUNDLES) {
    for (const member of bundleMemberNames(bundle)) members.add(member);
  }
  return members;
}

function rewiringKey(file: string, member: string): string {
  return `${file} ${member}`;
}

/**
 * Every `(file, member)` pair carrying a `rewiring` annotation on ANY of its
 * registry operation `sites[]` entries. Deliberately (file, member)-keyed,
 * never (file, line, member)-keyed (ruling 4): `sites[].lines` stays
 * commit-pinned for T11b and has drifted from the live source, so the
 * scanner must not read it.
 */
function collectRewiredMemberKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const bundle of CAPABILITY_BUNDLES) {
    for (const operation of bundle.operations) {
      for (const site of operation.sites as readonly CapabilityBundleOperationSite[]) {
        if (site.rewiring !== undefined) {
          keys.add(rewiringKey(site.file, site.member));
        }
      }
    }
  }
  return keys;
}

function excludedAccessKey(file: string, member: string): string {
  return `${file} ${member}`;
}

const EXCLUDED_ACCESS_KEYS: ReadonlySet<string> = new Set(
  EXCLUDED_ACCESS_SITES.map((site) =>
    excludedAccessKey(site.file, site.member),
  ),
);

function classifyAccess(
  file: string,
  member: string,
  bundledMembers: ReadonlySet<string>,
  rewiredMemberKeys: ReadonlySet<string>,
): BundleMemberAccessClass {
  // Classified FIRST, before the bundled/unbundled partition: the exclusion
  // is about WHERE the access lives (a permanent, out-of-model write path),
  // not about what kind of member it is, and it must never be absorbed into
  // the reasoned floor or the deferred ceiling (both of which read `perMember`
  // over non-excluded rows only — see `scanBundleMemberAccesses`).
  if (EXCLUDED_ACCESS_KEYS.has(excludedAccessKey(file, member))) {
    return "excluded";
  }
  if (bundledMembers.has(member)) {
    if (
      STATICALLY_REQUIRED_SITES.some(
        (site) => site.file === file && site.member === member,
      )
    ) {
      return "statically-required";
    }
    if (rewiredMemberKeys.has(rewiringKey(file, member))) {
      return "annotated-residue";
    }
    return "pilot";
  }
  const unbundled = (
    UNBUNDLED_OPTIONAL_MEMBERS as Readonly<
      Record<string, UnbundledOptionalMember>
    >
  )[member];
  if (unbundled !== undefined) return unbundled.kind;
  throw new Error(
    `"${member}" (accessed at ${file}) is classified in neither CAPABILITY_BUNDLES nor UNBUNDLED_OPTIONAL_MEMBERS — the registry's own totality proof should have caught this at compile time.`,
  );
}

/** The BUNDLE_BINDING brand skip (I21) — see the docblock's §The brand skip. */
function isBrandSkipped(
  checker: ts.TypeChecker,
  receiverType: ts.Type,
): boolean {
  return checker
    .getPropertiesOfType(receiverType)
    .some((property) => property.name.includes("BUNDLE_BINDING"));
}

/**
 * The receiver test, both arms (§ receiver test in the docblock above).
 * Returns `undefined` when neither arm accepts the candidate — a name match
 * on a non-port receiver, which is not an access at all.
 */
function receiverArm(
  checker: ts.TypeChecker,
  receiverType: ts.Type,
  member: string,
  typesSourceFile: ts.SourceFile,
): "declared" | "derived" | undefined {
  const property = checker.getPropertyOfType(receiverType, member);
  if (property === undefined) return undefined;
  const declarations = property.getDeclarations() ?? [];
  const declaredInTypes = declarations.some(
    (declaration) =>
      declaration.getSourceFile().fileName === typesSourceFile.fileName,
  );
  if (declaredInTypes) return "declared";
  const derived = declarations.some((declaration) => {
    if (
      !ts.isPropertySignature(declaration) ||
      declaration.type === undefined
    ) {
      return false;
    }
    return BACKEND_TYPE_REFERENCE_PATTERN.test(declaration.type.getText());
  });
  return derived ? "derived" : undefined;
}

type Candidate = Readonly<{
  member: string;
  receiverType: ts.Type;
  line: number;
}>;

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

/**
 * The receiver type a destructured `BindingElement` reads off: the
 * initializer's type for a variable destructure, the declaration's own type
 * for a parameter destructure. `undefined` for every other binding shape
 * (nested destructures, catch clauses, `for`/`for..of` bindings) — none of
 * the pilot's live sites take those shapes, so a future one is reported as
 * dropped rather than silently misattributed to the wrong receiver.
 */
function bindingElementReceiverType(
  checker: ts.TypeChecker,
  bindingElement: ts.BindingElement,
): ts.Type | undefined {
  const pattern = bindingElement.parent;
  if (!ts.isObjectBindingPattern(pattern)) return undefined;
  const patternOwner = pattern.parent;
  if (ts.isVariableDeclaration(patternOwner)) {
    if (patternOwner.initializer === undefined) return undefined;
    return checker.getTypeAtLocation(patternOwner.initializer);
  }
  if (ts.isParameter(patternOwner)) {
    return checker.getTypeAtLocation(patternOwner);
  }
  return undefined;
}

function candidateFromNode(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  optionalMemberNames: ReadonlySet<string>,
): Candidate | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    const member = node.name.text;
    if (!optionalMemberNames.has(member)) return undefined;
    return {
      member,
      receiverType: checker.getTypeAtLocation(node.expression),
      line: lineOf(sourceFile, node),
    };
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    const member = node.argumentExpression.text;
    if (!optionalMemberNames.has(member)) return undefined;
    return {
      member,
      receiverType: checker.getTypeAtLocation(node.expression),
      line: lineOf(sourceFile, node),
    };
  }
  if (ts.isBindingElement(node)) {
    const propertyNameNode = node.propertyName ?? node.name;
    const member =
      (
        ts.isIdentifier(propertyNameNode) ||
        ts.isStringLiteral(propertyNameNode)
      ) ?
        propertyNameNode.text
      : undefined;
    if (member === undefined || !optionalMemberNames.has(member)) {
      return undefined;
    }
    const receiverType = bindingElementReceiverType(checker, node);
    if (receiverType === undefined) return undefined;
    return { member, receiverType, line: lineOf(sourceFile, node) };
  }
  return undefined;
}

const EMPTY_BY_CLASS: Readonly<Record<BundleMemberAccessClass, number>> = {
  pilot: 0,
  "annotated-residue": 0,
  reasoned: 0,
  deferred: 0,
  "statically-required": 0,
  excluded: 0,
};

let cachedScan: BundleMemberAccessScan | undefined;

/**
 * Every live `OptionalGraphBackendMember` access under `src/**` (minus the
 * scope exclusions above), classified per §Classification. Memoized:
 * building the program costs a couple of seconds and every test reads the
 * same answer.
 */
export function scanBundleMemberAccesses(): BundleMemberAccessScan {
  if (cachedScan !== undefined) return cachedScan;

  const program = createSourceProgram();
  const checker = program.getTypeChecker();
  const typesSourceFile = requireSourceFile(program, "src/backend/types.ts");
  const optionalMemberNames = deriveOptionalGraphBackendMembers(
    checker,
    typesSourceFile,
  );
  const bundledMembers = collectBundledMembers();
  const rewiredMemberKeys = collectRewiredMemberKeys();

  const rows: BundleMemberAccessRow[] = [];
  const sourceRootWithSeparator = `${sourceRoot}${path.sep}`;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!sourceFile.fileName.startsWith(sourceRootWithSeparator)) continue;
    const file = toSourceRelativePosixPath(sourceFile.fileName);
    if (!isInScope(file)) continue;

    const visit = (node: ts.Node): void => {
      const candidate = candidateFromNode(
        checker,
        sourceFile,
        node,
        optionalMemberNames,
      );
      if (candidate !== undefined) {
        const nonNullableReceiver = checker.getNonNullableType(
          candidate.receiverType,
        );
        if (!isBrandSkipped(checker, nonNullableReceiver)) {
          const arm = receiverArm(
            checker,
            nonNullableReceiver,
            candidate.member,
            typesSourceFile,
          );
          if (arm !== undefined) {
            rows.push({
              file,
              line: candidate.line,
              member: candidate.member as OptionalGraphBackendMember,
              class: classifyAccess(
                file,
                candidate.member,
                bundledMembers,
                rewiredMemberKeys,
              ),
              receiverType: checker.typeToString(candidate.receiverType),
              arm,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }

  const byClass: Record<BundleMemberAccessClass, number> = {
    ...EMPTY_BY_CLASS,
  };
  const perMember: Record<string, number> = Object.fromEntries(
    [...optionalMemberNames].map((member) => [member, 0]),
  );
  for (const row of rows) {
    byClass[row.class] += 1;
    // The reasoned floor and the deferred ceiling both read `perMember`, and
    // the ruling forbids those buckets absorbing the trusted-import
    // carve-out: excluded rows are counted in `byClass` and `rows`, never in
    // `perMember`.
    if (row.class === "excluded") continue;
    perMember[row.member] = (perMember[row.member] ?? 0) + 1;
  }

  cachedScan = { rows, byClass, perMember };
  return cachedScan;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const scan = scanBundleMemberAccesses();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(scan.rows, undefined, 2));
  } else {
    console.log("Bundle member access scan");
    console.log("==========================");
    for (const [accessClass, count] of Object.entries(scan.byClass)) {
      console.log(`${accessClass}: ${count}`);
    }
    console.log(`total: ${scan.rows.length}`);
  }
}
