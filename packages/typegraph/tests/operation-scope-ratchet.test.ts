/**
 * THE RATCHET for operation-scoped statement targets
 * (`src/store/operation-scope.ts`).
 *
 * Two invariants:
 *
 * 1. **The brand is produced only by the two mints.** The brand key is a
 *    module-private, declared-only unique symbol, so a route that would have
 *    to spell the key (an object literal, a computed property, `satisfies`,
 *    module augmentation) is a type error by construction. TypeScript cannot
 *    refuse an assertion to a subtype, though, so every other route is found
 *    by `forgeSites` (`tests/helpers/operation-scope-scan.ts`): a
 *    checker-backed scan that recognizes the brand by its property, not by a
 *    type name. It must find exactly the two mint assertions in `src`.
 *    ESLint's `OPERATION_BRAND_RESTRICTIONS` is a fast-feedback backstop for
 *    the spellings a selector can see.
 *
 * 2. **The raw surface only shrinks.** Per store family, the number of
 *    exported functions that still accept a raw `TransactionBackend` for
 *    statement-issuing work (`rawStatementTargets`). A parameter counts when a
 *    raw transaction is assignable to it, to its constraint, to a union
 *    constituent, or to a property or array element of it, and that type
 *    exposes a backend member outside the `identity` class. Each count is
 *    pinned exactly: a family that gains a raw parameter fails, and a change
 *    that narrows one lowers the baseline in the same commit.
 *
 * The forge-route table below is the systematic enumeration: every route,
 * the layer that refuses it (type system, lint, scan), or the reason it is an
 * accepted gap. Its fixture is a virtual module inside `src/store` of the
 * SAME program the repository is scanned in, run through the SAME
 * `forgeSites`, and linted with the real ESLint config — there is no second
 * implementation for a fixture to certify.
 */
import path from "node:path";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { OPERATION_BRAND_RESTRICTIONS } from "../eslint.config.mjs";
import {
  brandKeyDeclaration,
  countByFamily,
  createScanProgram,
  errorDiagnostics,
  type ForgeRoute,
  forgeSites,
  MINT_MODULE,
  PACKAGE_ROOT,
  rawStatementTargets,
  type ScanProgram,
  type StoreFamily,
  storeModules,
} from "./helpers/operation-scope-scan";

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
  "operations/write": 36,
  "recorded-capture": 51,
  claims: 25,
  "search-sync": 10,
  collections: 4,
  store: 44,
} as const satisfies Record<StoreFamily, number>;

/** The forge sites `src` may contain: one assertion per mint. */
const MINT_SITES = [
  { file: MINT_MODULE, function: "enterOperation", route: "assertion" },
  { file: MINT_MODULE, function: "scopeWriteFrameTarget", route: "assertion" },
] as const;

// ---------------------------------------------------------------------------
// The forge-route fixture
// ---------------------------------------------------------------------------

/** A path inside `src/store`, so the fixture resolves imports like a store module. */
const FORGE_FIXTURE = "src/store/operation-scope-forge-routes.fixture.ts";

/** A real `src/store` module whose path ESLint borrows; its content is never linted. */
const BORROWED_LINT_PATH = "src/store/edge-fetch.ts";

const FORGE_PREAMBLE = `
import type { GraphBackend, TransactionBackend } from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import type { EdgeCollectionConfig } from "./collections/edge-collection";
import type * as scope from "./operation-scope";
import {
  enterOperation,
  type OperationBackend,
  type StatementBackend,
} from "./operation-scope";
import {
  type EdgeOperationContext,
  executeEdgeCreate,
} from "./operations/edge-operations";
import type { CreateEdgeInput, Edge } from "./types";

declare const raw: TransactionBackend;
declare const ctx: EdgeOperationContext<GraphDef>;
declare const input: CreateEdgeInput;
type Loose = (
  context: typeof ctx,
  edge: CreateEdgeInput,
  backend: TransactionBackend,
) => Promise<Edge>;
type LooseHolder = Readonly<{
  create(
    context: typeof ctx,
    edge: CreateEdgeInput,
    backend: TransactionBackend,
  ): Promise<Edge>;
}>;
function identity<T>(value: unknown): T {
  return value as T;
}
function withValue<T>(
  value: unknown,
  use: (value: T) => Promise<Edge>,
): Promise<Edge> {
  return use(value as T);
}
`;

/**
 * Which layer refuses a route. `typeErrors`: the diagnostic codes the route's
 * code draws, so a case cannot pass by failing to compile for an unrelated
 * reason (2379: an argument not assignable to the parameter).
 */
type Refusal = Readonly<{
  typeErrors: readonly number[];
  lint: readonly LintCatch[];
  scan: readonly ForgeRoute[];
}>;

/**
 * Lint rules that refuse a forge: the brand ban, and the type-aware `any`
 * rules from the shared config.
 */
type LintCatch =
  | "brand-ban"
  | "@typescript-eslint/ban-ts-comment"
  | "@typescript-eslint/no-explicit-any"
  | "@typescript-eslint/no-unsafe-argument"
  | "@typescript-eslint/no-unsafe-call";

type ForgeCase = Readonly<{
  route: string;
  code: string;
  refusal: Refusal;
  /** Set only on an accepted gap: why no layer refuses it. */
  gap?: string;
}>;

function refusal(
  typeErrors: readonly number[],
  lint: readonly LintCatch[],
  scan: readonly ForgeRoute[],
): Refusal {
  return { typeErrors, lint, scan };
}

/** Argument of type … is not assignable to parameter of type …. */
const NOT_ASSIGNABLE = 2379;

const FORGE_CASES: readonly ForgeCase[] = [
  {
    route: "passes a raw transaction (the baseline)",
    code: `export function forgeNone() { return executeEdgeCreate(ctx, input, raw); }`,
    refusal: refusal([NOT_ASSIGNABLE], [], []),
  },
  {
    route: "as, brand named directly",
    code: `export function forgeDirect() { return executeEdgeCreate(ctx, input, raw as OperationBackend); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "as, through a local alias",
    code: `type Handle = StatementBackend;
export function forgeAlias() { return executeEdgeCreate(ctx, input, raw as Handle); }`,
    refusal: refusal([], [], ["assertion"]),
  },
  {
    route: "as, through a renamed import",
    code: `import { type StatementBackend as Renamed } from "./operation-scope";
export function forgeRenamedImport() { return executeEdgeCreate(ctx, input, raw as Renamed); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "as, namespace-qualified brand",
    code: `export function forgeQualified() { return executeEdgeCreate(ctx, input, raw as scope.StatementBackend); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: 'as, inline import("…") type',
    code: `export function forgeImportType() { return executeEdgeCreate(ctx, input, raw as import("./operation-scope").OperationBackend); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "as, ReturnType of a mint",
    code: `export function forgeMintReturn() { return executeEdgeCreate(ctx, input, raw as ReturnType<typeof enterOperation>); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "as, ReturnType of a namespace-qualified mint",
    code: `export function forgeQualifiedMintReturn() { return executeEdgeCreate(ctx, input, raw as ReturnType<typeof scope.enterOperation>); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "as, ReturnType of an instantiated qualified mint",
    code: `export function forgeInstantiatedMintReturn() { return executeEdgeCreate(ctx, input, raw as ReturnType<typeof scope.scopeWriteFrameTarget<TransactionBackend>>); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "as, Parameters of a brand consumer",
    code: `export function forgeConsumerParameters() { return executeEdgeCreate(ctx, input, raw as Parameters<typeof executeEdgeCreate>[2]); }`,
    refusal: refusal([], [], ["assertion"]),
  },
  {
    route: "as, indexed access into a config type",
    code: `export function forgeIndexedAccess() { return executeEdgeCreate(ctx, input, raw as Parameters<EdgeCollectionConfig["executeCreate"]>[1]); }`,
    refusal: refusal([], [], ["assertion"]),
  },
  {
    route: "as never into a branded parameter",
    code: `export function forgeNever() { return executeEdgeCreate(ctx, input, raw as never); }`,
    refusal: refusal([], [], ["assertion"]),
  },
  {
    route: "as any into a branded parameter",
    code: `export function forgeAny() { return executeEdgeCreate(ctx, input, raw as any); }`,
    refusal: refusal(
      [],
      [
        "@typescript-eslint/no-explicit-any",
        "@typescript-eslint/no-unsafe-argument",
      ],
      ["assertion"],
    ),
  },
  {
    route: "as unknown as the brand",
    code: `export function forgeDoubleAssertion() { return executeEdgeCreate(ctx, input, raw as unknown as StatementBackend); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "an any-typed value into a branded parameter",
    code: `export function forgeAnyValue() { const loose = JSON.parse("{}"); return executeEdgeCreate(ctx, input, loose); }`,
    refusal: refusal(
      [],
      ["@typescript-eslint/no-unsafe-argument"],
      ["any-flow"],
    ),
  },
  {
    route: "satisfies the brand",
    code: `export function forgeSatisfies() { return executeEdgeCreate(ctx, input, raw satisfies StatementBackend); }`,
    refusal: refusal([NOT_ASSIGNABLE, 1360], [], []),
  },
  {
    route: "satisfies, then widened by assertion",
    code: `export function forgeSatisfiesWidened() { return executeEdgeCreate(ctx, input, (raw satisfies TransactionBackend) as StatementBackend); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "a type predicate",
    code: `export function forgeTypePredicate() {
  const isScoped = (backend: TransactionBackend): backend is OperationBackend => backend === raw;
  return isScoped(raw) ? executeEdgeCreate(ctx, input, raw) : undefined;
}`,
    refusal: refusal([], ["brand-ban"], ["type-predicate"]),
  },
  {
    route: "an assertion function",
    code: `export function forgeAssertionFunction() {
  const assertScoped: (backend: TransactionBackend) => asserts backend is OperationBackend = () => undefined;
  const backend = raw;
  assertScoped(backend);
  return executeEdgeCreate(ctx, input, backend);
}`,
    refusal: refusal([], ["brand-ban"], ["type-predicate"]),
  },
  {
    route: "object spread of a raw transaction",
    code: `export function forgeSpreadRaw() { return executeEdgeCreate(ctx, input, { ...raw }); }`,
    refusal: refusal([NOT_ASSIGNABLE], [], []),
  },
  {
    route: "object spread laundering raw members under a borrowed brand",
    code: `export function forgeSpreadLaunder(scoped: OperationBackend) { return executeEdgeCreate(ctx, input, { ...scoped, ...raw }); }`,
    refusal: refusal([], [], ["branded-copy"]),
  },
  {
    route: "Object.assign of a borrowed brand onto a raw transaction",
    code: `export function forgeObjectAssign(scoped: OperationBackend) { return executeEdgeCreate(ctx, input, Object.assign(raw, scoped)); }`,
    refusal: refusal([], [], ["branded-copy"]),
  },
  {
    route: "spelling the brand key",
    code: `export async function forgeSpellKey() {
  const { OPERATION_SCOPED } = await import("./operation-scope");
  return executeEdgeCreate(ctx, input, { ...raw, [OPERATION_SCOPED]: "operation" as const });
}`,
    refusal: refusal([2339, NOT_ASSIGNABLE], [], []),
  },
  {
    route: "a generic call with the brand as explicit type argument",
    code: `export function forgeTypeArgument() { return executeEdgeCreate(ctx, input, identity<StatementBackend>(raw)); }`,
    refusal: refusal([], [], ["generic-instantiation"]),
  },
  {
    route: "a generic call inferring the brand from its return context",
    code: `export function forgeInferredTypeArgument() { return executeEdgeCreate(ctx, input, identity(raw)); }`,
    refusal: refusal([], [], ["generic-instantiation"]),
  },
  {
    route: "a generic call handing the brand to a callback",
    code: `export function forgeCallback() { return withValue(raw, (backend: StatementBackend) => executeEdgeCreate(ctx, input, backend)); }`,
    refusal: refusal([], [], ["generic-instantiation"]),
  },
  {
    route: "an overload promising the brand",
    code: `export function forgeOverload(backend: TransactionBackend): StatementBackend;
export function forgeOverload(backend: TransactionBackend): GraphBackend | TransactionBackend { return backend; }`,
    refusal: refusal([], [], ["unverified-signature"]),
  },
  {
    route: "an ambient declaration of a branded value",
    code: `export declare const forgeDeclared: StatementBackend;`,
    refusal: refusal([], [], ["unverified-binding"]),
  },
  {
    route: "a definite-assignment assertion on a branded binding",
    code: `export function forgeDefiniteAssignment() { let forged!: StatementBackend; return executeEdgeCreate(ctx, input, forged); }`,
    refusal: refusal([], [], ["unverified-binding"]),
  },
  {
    route: "a declared class field of the brand",
    code: `export class ForgeHolder { declare readonly forged: StatementBackend; }`,
    refusal: refusal([], [], ["unverified-binding"]),
  },
  {
    route: "@ts-expect-error over a raw call",
    code: `export function forgeExpectError() {
  // @ts-expect-error -- forged statement target
  return executeEdgeCreate(ctx, input, raw);
}`,
    refusal: refusal([], [], ["suppression"]),
  },
  {
    route: "@ts-ignore over a raw call",
    code: `export function forgeIgnore() {
  // @ts-ignore
  return executeEdgeCreate(ctx, input, raw);
}`,
    refusal: refusal(
      [],
      ["@typescript-eslint/ban-ts-comment"],
      ["suppression"],
    ),
  },
  {
    route: "a function type asserted to return the brand",
    code: `export function forgeFunctionType() {
  const forge = ((backend: TransactionBackend) => backend) as unknown as (backend: TransactionBackend) => StatementBackend;
  return executeEdgeCreate(ctx, input, forge(raw));
}`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "a structure asserted to hold the brand",
    code: `export function forgeStructure() { return executeEdgeCreate(ctx, input, ({ backend: raw } as { backend: StatementBackend }).backend); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "a promise asserted to resolve to the brand",
    code: `export async function forgePromise() { return executeEdgeCreate(ctx, input, await (Promise.resolve(raw) as Promise<StatementBackend>)); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "an array asserted to hold the brand",
    code: `export async function forgeArray() {
  const targets = [raw] as StatementBackend[];
  for (const target of targets) await executeEdgeCreate(ctx, input, target);
}`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route:
      "object spread copying a statement target (a union with one branded constituent)",
    code: `export function forgeUnionSpread(target: StatementBackend) { return executeEdgeCreate(ctx, input, { ...target }); }`,
    refusal: refusal([], [], ["branded-copy"]),
  },
  {
    route: "the consumer asserted to a raw-accepting signature",
    code: `export function forgeConsumerAssertion() { return (executeEdgeCreate as Loose)(ctx, input, raw); }`,
    refusal: refusal([], [], ["consumer-widening"]),
  },
  {
    route: "the consumer as never into a raw-accepting binding",
    code: `export function forgeConsumerNever() { const loose: Loose = executeEdgeCreate as never; return loose(ctx, input, raw); }`,
    refusal: refusal([], [], ["consumer-widening"]),
  },
  {
    route: "the consumer as any",
    code: `export function forgeConsumerAny() { return (executeEdgeCreate as any)(ctx, input, raw); }`,
    refusal: refusal(
      [],
      [
        "@typescript-eslint/no-explicit-any",
        "@typescript-eslint/no-unsafe-call",
      ],
      ["consumer-widening"],
    ),
  },
  {
    route: "the consumer through method-parameter bivariance",
    code: `export function forgeMethodBivariance() {
  const loose: { create(context: typeof ctx, edge: CreateEdgeInput, backend: TransactionBackend): Promise<Edge> } = { create: executeEdgeCreate };
  return loose.create(ctx, input, raw);
}`,
    refusal: refusal([], [], ["consumer-flow"]),
  },
  {
    route: "a consumer holder flowing whole into a bivariant method binding",
    code: `export function forgeHolderFlow() {
  const holder = { create: executeEdgeCreate };
  const loose: LooseHolder = holder;
  return loose.create(ctx, input, raw);
}`,
    refusal: refusal([], [], ["consumer-flow"]),
  },
  {
    route:
      "a consumer holder re-asserted to its own type into a bivariant method binding",
    code: `export function forgeHolderAssertion() {
  const holder = { create: executeEdgeCreate };
  const loose: LooseHolder = holder as typeof holder;
  return loose.create(ctx, input, raw);
}`,
    refusal: refusal([], [], ["consumer-widening"]),
  },
  {
    route: "the consumer as unknown as a raw-accepting signature",
    code: `export function forgeConsumerDoubleAssertion() { return (executeEdgeCreate as unknown as Loose)(ctx, input, raw); }`,
    refusal: refusal([], [], ["consumer-widening"]),
  },
  {
    route: "the consumer hidden in unknown and re-asserted",
    code: `export function forgeConsumerOpaque() { const opaque: unknown = executeEdgeCreate; return (opaque as Loose)(ctx, input, raw); }`,
    refusal: refusal([], [], ["consumer-flow"]),
  },
  {
    route: "the consumer through Reflect.apply's untyped overload",
    code: `export function forgeReflectApply(): unknown { return Reflect.apply(executeEdgeCreate, undefined, [ctx, input, raw]); }`,
    refusal: refusal([], [], ["consumer-flow"]),
  },
  {
    route: "the consumer through Function.prototype.call",
    code: `export function forgeCall() { return executeEdgeCreate.call(undefined, ctx, input, raw); }`,
    refusal: refusal([NOT_ASSIGNABLE], [], []),
  },
  {
    route: "the consumer through Function.prototype.bind",
    code: `export function forgeBind() { return executeEdgeCreate.bind(undefined, ctx, input)(raw); }`,
    refusal: refusal([NOT_ASSIGNABLE], [], []),
  },
  {
    route: "a wrapper with a raw parameter",
    code: `export function forgeWrapper(backend: TransactionBackend) { return executeEdgeCreate(ctx, input, backend); }`,
    refusal: refusal([NOT_ASSIGNABLE], [], []),
  },
  {
    route: "a call to a mint",
    code: `export function forgeMintCall() { return executeEdgeCreate(ctx, input, enterOperation(raw)); }`,
    refusal: refusal([], [], []),
    gap: "Not a forge: minting is the sanctioned route. What the brand proves is that a call path passes a mint where it can be reviewed; where mints may be called is not constrained by this ratchet.",
  },
  {
    route: "a brand demand two members deep, hidden in unknown and re-asserted",
    code: `export function forgeDeepOpaque() {
  const holder = { operations: { create: executeEdgeCreate } };
  const opaque: unknown = holder;
  return (opaque as { operations: { create: Loose } }).operations.create(ctx, input, raw);
}`,
    refusal: refusal([], [], []),
    gap: "A value is flagged entering an opaque type only when the brand demand is at most one member deep. Every store instance holds brand-demanding operations two members deep and is legitimately keyed into WeakMaps and asserted to its public flavor, so a deeper search would flag those instead of forges. Reaching the demand again needs a second assertion from unknown that names the full member path.",
  },
];

function routeLine(index: number): string {
  return `// route ${index}`;
}

const FORGE_SOURCE = [
  FORGE_PREAMBLE,
  ...FORGE_CASES.map(
    (forgeCase, index) => `${routeLine(index)}\n${forgeCase.code}\n`,
  ),
].join("\n");

/** The case index of each 1-based fixture line; preamble lines map to -1. */
function caseIndexOfLine(line: number): number {
  const lines = FORGE_SOURCE.split("\n");
  for (let current = line - 1; current >= 0; current -= 1) {
    const match = /^\/\/ route (\d+)$/.exec(lines[current] ?? "");
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The raw-target fixture
// ---------------------------------------------------------------------------

/** Matches the `operations/edge` family pattern. */
const RAW_TARGET_FIXTURE = "src/store/operations/edge-raw-target.fixture.ts";

const RAW_TARGET_SOURCE = `
import type { TransactionBackend } from "../../backend/types";
import type { StatementBackend } from "../operation-scope";

type Reader = Pick<TransactionBackend, "getNode">;

export async function constrainedGeneric<Target extends Reader>(target: Target): Promise<void> {
  await target.getNode("graph", "Kind", "id");
}
export async function constrainedGenericOrUndefined<Target extends Reader>(target: Target | undefined): Promise<void> {
  await target?.getNode("graph", "Kind", "id");
}
export async function constrainedIntersection<Target extends Reader>(target: Target & Readonly<{ label?: string }>): Promise<void> {
  await target.getNode("graph", "Kind", "id");
}
export async function structuralMember(context: Readonly<{ graphId: string; backend: Reader }>): Promise<void> {
  await context.backend.getNode(context.graphId, "Kind", "id");
}
export async function nestedStructuralMember(context: Readonly<{ write: Readonly<{ target: Reader }> }>): Promise<void> {
  await context.write.target.getNode("graph", "Kind", "id");
}
export async function constrainedStructuralMember<Context extends Readonly<{ backend: Reader }>>(context: Context): Promise<void> {
  await context.backend.getNode("graph", "Kind", "id");
}
export async function arrayOfTargets(targets: readonly Reader[]): Promise<void> {
  for (const target of targets) await target.getNode("graph", "Kind", "id");
}
export async function unionWithNonBackend(target: Reader | Readonly<{ offline: true }>): Promise<void> {
  if ("getNode" in target) await target.getNode("graph", "Kind", "id");
}
export async function fourMembersDeep(context: Readonly<{ a: Readonly<{ b: Readonly<{ c: Readonly<{ backend: Reader }> }> }> }>): Promise<void> {
  await context.a.b.c.backend.getNode("graph", "Kind", "id");
}
export async function readerOrCount(target: Reader | number): Promise<void> {
  if (typeof target !== "number") await target.getNode("graph", "Kind", "id");
}
export const arrowTarget = async (target: Reader): Promise<void> => {
  await target.getNode("graph", "Kind", "id");
};

// Not raw statement targets.
export function identityOnly(target: Pick<TransactionBackend, "dialect">): string {
  return target.dialect;
}
export function unconstrained<T>(value: T): T {
  return value;
}
export function opaque(value: unknown): unknown {
  return value;
}
// Beyond MEMBER_DEPTH (4): the bound of the member search.
export async function fiveMembersDeep(context: Readonly<{ a: Readonly<{ b: Readonly<{ c: Readonly<{ d: Readonly<{ backend: Reader }> }> }> }> }>): Promise<void> {
  await context.a.b.c.d.backend.getNode("graph", "Kind", "id");
}
export async function scopedOnly(target: StatementBackend): Promise<void> {
  await target.getNode("graph", "Kind", "id");
}

declare const raw: TransactionBackend;
async function callsWithRaw(): Promise<void> {
  await constrainedGeneric(raw);
  await constrainedGenericOrUndefined(raw);
  await constrainedIntersection(raw);
  await structuralMember({ graphId: "graph", backend: raw });
  await nestedStructuralMember({ write: { target: raw } });
  await constrainedStructuralMember({ backend: raw });
  await arrayOfTargets([raw]);
  await unionWithNonBackend(raw);
  await fourMembersDeep({ a: { b: { c: { backend: raw } } } });
  await readerOrCount(raw);
  await arrowTarget(raw);
}
void callsWithRaw;
`;

const RAW_TARGET_FIXTURE_COUNTED = [
  "constrainedGeneric",
  "constrainedGenericOrUndefined",
  "constrainedIntersection",
  "structuralMember",
  "nestedStructuralMember",
  "constrainedStructuralMember",
  "arrayOfTargets",
  "unionWithNonBackend",
  "fourMembersDeep",
  "readerOrCount",
  "arrowTarget",
] as const;

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

const eslint = new ESLint({ cwd: PACKAGE_ROOT });

const OPERATION_BRAND_MESSAGES = new Set(
  OPERATION_BRAND_RESTRICTIONS.map((restriction) => restriction.message),
);

const LINT_CATCHES: ReadonlySet<string> = new Set<LintCatch>([
  "@typescript-eslint/ban-ts-comment",
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-unsafe-argument",
  "@typescript-eslint/no-unsafe-call",
]);

async function lintCatches(
  source: string,
): Promise<readonly Readonly<{ line: number; rule: LintCatch }>[]> {
  const results = await eslint.lintText(source, {
    filePath: path.join(PACKAGE_ROOT, BORROWED_LINT_PATH),
  });
  return results
    .flatMap((result) => result.messages)
    .flatMap((message) => {
      if (
        message.ruleId === "no-restricted-syntax" &&
        OPERATION_BRAND_MESSAGES.has(message.message)
      ) {
        return [{ line: message.line, rule: "brand-ban" as const }];
      }
      return message.ruleId !== null && LINT_CATCHES.has(message.ruleId) ?
          [{ line: message.line, rule: message.ruleId as LintCatch }]
        : [];
    });
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].toSorted();
}

// ---------------------------------------------------------------------------

describe("operation-scope ratchet", () => {
  let scan: ScanProgram;

  // Building the checker program over every `src` module is the expensive
  // step; coverage instrumentation slows it well past the default timeout.
  beforeAll(() => {
    scan = createScanProgram({
      [FORGE_FIXTURE]: FORGE_SOURCE,
      [RAW_TARGET_FIXTURE]: RAW_TARGET_SOURCE,
    });
  }, 180_000);

  it("the brand key is declared-only and module-private", () => {
    expect(brandKeyDeclaration(scan)).toEqual({
      declaredOnly: true,
      exported: false,
    });
  });

  // Its own program: the failed augmentation still lists the key among the
  // module's exports, which would let the key-spelling route above compile.
  it(
    "a module augmentation cannot re-export the brand key",
    { timeout: 180_000 },
    () => {
      const augmentation = "src/store/operation-scope-augmentation.fixture.ts";
      const isolated = createScanProgram({
        [augmentation]: [
          'declare module "./operation-scope" {',
          "  export { OPERATION_SCOPED };",
          "}",
          "export {};",
        ].join("\n"),
      });
      // 2666: exports are not permitted in a module augmentation; 2304: the
      // key is not visible to it.
      expect(
        errorDiagnostics(isolated, augmentation).map(([, code]) => code),
      ).toEqual([2666, 2304]);
    },
  );

  it(
    "every forge route is refused by the layer the table names, or is a stated gap",
    { timeout: 180_000 },
    async () => {
      const forgeFixturePath = path.join(PACKAGE_ROOT, FORGE_FIXTURE);
      const typeErrors = errorDiagnostics(scan, FORGE_FIXTURE);
      const typeErrorLines = typeErrors.map(([line]) => line);
      const lintHits = await lintCatches(FORGE_SOURCE);
      const scanHits = forgeSites(scan, [forgeFixturePath]);

      const observed = FORGE_CASES.map((_, index) => ({
        typeErrors: [
          ...new Set(
            typeErrors
              .filter(([line]) => caseIndexOfLine(line) === index)
              .map(([, code]) => code),
          ),
        ].toSorted((left, right) => left - right),
        lint: sortedUnique(
          lintHits
            .filter((hit) => caseIndexOfLine(hit.line) === index)
            .map((hit) => hit.rule),
        ),
        scan: sortedUnique(
          scanHits
            .filter((site) => caseIndexOfLine(site.line) === index)
            .map((site) => site.route),
        ),
      }));
      const expected = FORGE_CASES.map((forgeCase) => ({
        typeErrors: forgeCase.refusal.typeErrors.toSorted(
          (left, right) => left - right,
        ),
        lint: sortedUnique(forgeCase.refusal.lint),
        scan: sortedUnique(forgeCase.refusal.scan),
      }));

      // The preamble compiles, lints and scans clean, so every hit above
      // belongs to a route.
      expect({
        typeErrors: typeErrorLines.filter((line) => caseIndexOfLine(line) < 0),
        lint: lintHits.filter((hit) => caseIndexOfLine(hit.line) < 0),
        scan: scanHits.filter((site) => caseIndexOfLine(site.line) < 0),
      }).toEqual({ typeErrors: [], lint: [], scan: [] });

      expect(
        FORGE_CASES.map((forgeCase, index) => ({
          route: forgeCase.route,
          ...observed[index],
        })),
      ).toEqual(
        FORGE_CASES.map((forgeCase, index) => ({
          route: forgeCase.route,
          ...expected[index],
        })),
      );

      // Every route that is not a stated gap is refused somewhere, and a
      // stated gap is refused nowhere.
      for (const forgeCase of FORGE_CASES) {
        const refused =
          forgeCase.refusal.typeErrors.length > 0 ||
          forgeCase.refusal.lint.length > 0 ||
          forgeCase.refusal.scan.length > 0;
        expect({ route: forgeCase.route, refused }).toEqual({
          route: forgeCase.route,
          refused: forgeCase.gap === undefined,
        });
      }
    },
  );

  it("src forges the brand only at the two mints", { timeout: 180_000 }, () => {
    expect(
      forgeSites(scan, scan.sourceFiles).map((site) => ({
        file: site.file,
        function: site.function,
        route: site.route,
      })),
    ).toEqual(MINT_SITES);
  });

  it(
    "raw statement targets per store family only decrease, and the edge-create entry points are off the raw surface",
    { timeout: 180_000 },
    () => {
      const targets = rawStatementTargets(scan, storeModules(scan));
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

  it("counts a raw target behind a constraint, union, intersection, member or element", () => {
    // Each counted helper is called with a raw transaction and compiles.
    expect(errorDiagnostics(scan, RAW_TARGET_FIXTURE)).toEqual([]);

    const fixture = rawStatementTargets(scan, [
      path.join(PACKAGE_ROOT, RAW_TARGET_FIXTURE),
    ]);
    expect(fixture.map((target) => target.function)).toEqual(
      RAW_TARGET_FIXTURE_COUNTED,
    );
    expect(new Set(fixture.map((target) => target.family))).toEqual(
      new Set(["operations/edge"]),
    );
  });
});
