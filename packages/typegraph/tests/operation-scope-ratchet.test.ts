/**
 * THE RATCHET for operation-scoped statement targets
 * (`src/store/operation-scope.ts`).
 *
 * Four invariants:
 *
 * 1. **The brand is produced only by the mints.** The brand key is a
 *    module-private, declared-only unique symbol, so a route that would have
 *    to spell the key (an object literal, a computed property, `satisfies`,
 *    module augmentation) is a type error by construction. TypeScript cannot
 *    refuse an assertion to a subtype, though, so every other route is found
 *    by `forgeSites` (`tests/helpers/operation-scope-scan.ts`): a
 *    checker-backed scan that recognizes the brand by its property, not by a
 *    type name. It must find exactly the mint assertions in `src`.
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
 * 3. **Store code does not hold the engine's transaction type.** Outside
 *    `src/backend`, a transaction is received as `StoreTransactionBackend`
 *    (no statement member) and statements go through an operation handle.
 *    `rawTransactionSites` finds every place Store code still declares,
 *    produces or asserts the engine `TransactionBackend` (or asserts into the
 *    engine type a `StoreTransactionBackend` records). A name Store code can
 *    use with the raw type is never allowed. The only sites allowed are the
 *    declarations a public API report spells, listed with their reason in
 *    `RAW_TRANSACTION_DECLARATIONS`: bodiless signatures (a public overload,
 *    a port member's function type), which no code can use and whose
 *    implementations the type checker holds to the narrowed type; and two
 *    properties, whose every read this scan checks instead.
 *
 * 4. **A specialised Store transaction exists only where the engine opens
 *    it.** A `StoreTransactionBackend` specialised to the schema-write
 *    transaction or the preflight target (and a handle to one) carries a
 *    required, module-private engine record, so no annotation can claim it:
 *    the type checker refuses an ordinary transaction or handle there.
 *    `forgeSites(…, "engine record")` must find it produced only at the
 *    boundary mints, one per engine member that opens such a transaction.
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
import type { BOUNDARY_MINT_MEMBERS } from "./helpers/operation-scope-scan";
import {
  boundaryMintCalls,
  brandKeyDeclaration,
  countByFamily,
  createScanProgram,
  errorDiagnostics,
  type ForgeRoute,
  forgeSites,
  MINT_MODULE,
  PACKAGE_ROOT,
  rawStatementTargets,
  type RawTransactionRoute,
  rawTransactionSites,
  type ScanProgram,
  storeFacingModules,
  type StoreFamily,
  storeModules,
} from "./helpers/operation-scope-scan";

/**
 * Exported functions that accept a raw `TransactionBackend` for
 * statement-issuing work, per family. Each may only ever DECREASE, and the
 * change that narrows a parameter lowers its family here in the same commit.
 * The mint module is excluded: its mints accept a raw backend by
 * definition.
 *
 * What remains after Store code stopped holding the engine transaction type
 * (254 before that change) are parameters typed as a statement FRAGMENT —
 * `IdentityTarget`, `WriteTarget`, a `Pick<…>` of the backend — to which a
 * raw transaction is structurally assignable. Store code can no longer
 * produce a raw transaction to pass them (invariant 3); narrowing each to the
 * handle is the family conversions' work.
 */
const RAW_STATEMENT_TARGET_BASELINE = {
  "operations/edge": 9,
  "operations/node": 8,
  "operations/composition": 15,
  "operations/write": 3,
  "recorded-capture": 28,
  claims: 17,
  "search-sync": 0,
  collections: 0,
  store: 36,
} as const satisfies Record<StoreFamily, number>;

/** The forge sites `src` may contain: one assertion per mint. */
const MINT_SITES = [
  {
    file: MINT_MODULE,
    function: "legacyTransactionOperation",
    route: "assertion",
  },
  { file: MINT_MODULE, function: "openTransactionSession", route: "assertion" },
  { file: MINT_MODULE, function: "scopeWriteFrameTarget", route: "assertion" },
] as const;

/**
 * The sites `src` may produce a specialised `StoreTransactionBackend` at:
 * one assertion per boundary mint, each at the engine member that opens the
 * specialised transaction.
 */
const BOUNDARY_MINT_SITES = [
  {
    file: MINT_MODULE,
    function: "storeSchemaWriteTransaction",
    route: "assertion",
  },
  {
    file: MINT_MODULE,
    function: "storeCommitSchemaVersionWithPreflight",
    route: "assertion",
  },
  {
    file: MINT_MODULE,
    function: "storeSetActiveVersionWithPreflight",
    route: "assertion",
  },
  {
    file: MINT_MODULE,
    function: "storeAdoptSchemaWriteTransaction",
    route: "assertion",
  },
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
  type OperationBackend,
  scopeWriteFrameTarget,
  type StatementBackend,
} from "./operation-scope";
import {
  type EdgeOperationContext,
  executeEdgeCreate as executeEdgeCreateEntry,
} from "./operations/edge-operations";
import { legacyWriteEntry } from "./operations/write-transaction";
import type { CreateEdgeInput, Edge } from "./types";

// The brand's consumer: a statement-issuing Store function that takes the
// handle it is given. (An edge create itself now takes a write entry, which a
// handle alone is not.)
function executeEdgeCreate(
  context: EdgeOperationContext<GraphDef>,
  edge: CreateEdgeInput,
  backend: StatementBackend,
): Promise<Edge> {
  return executeEdgeCreateEntry(context, edge, legacyWriteEntry(backend));
}

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
class Holder<T> {
  value: T | undefined;
  constructor() {
    this.value = undefined;
  }
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
    code: `export function forgeMintReturn() { return executeEdgeCreate(ctx, input, raw as ReturnType<typeof scopeWriteFrameTarget<TransactionBackend>>); }`,
    refusal: refusal([], ["brand-ban"], ["assertion"]),
  },
  {
    route: "as, ReturnType of a namespace-qualified mint",
    code: `export function forgeQualifiedMintReturn() { return executeEdgeCreate(ctx, input, raw as ReturnType<typeof scope.legacyTransactionOperation<TransactionBackend>>); }`,
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
    code: `export function forgeIndexedAccess() { return executeEdgeCreate(ctx, input, raw as Parameters<EdgeCollectionConfig["executeFindByEndpoints"]>[5]); }`,
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
    route: "an opener asserted to hand the brand to its callback",
    code: `type BrandOpener = (fn: (tx: OperationBackend) => Promise<Edge>) => Promise<Edge>;
export function forgeOpener(root: GraphBackend) {
  return (root.transaction as unknown as BrandOpener)((tx) => executeEdgeCreate(ctx, input, tx));
}`,
    refusal: refusal([], [], ["assertion"]),
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
    code: `export function forgeMintCall() { return executeEdgeCreate(ctx, input, scopeWriteFrameTarget(raw)); }`,
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
  {
    route:
      "an ECMAScript-private method demanding the brand, its instance hidden in unknown",
    code: `export class PrivateDemand {
  #create(backend: StatementBackend) { return executeEdgeCreate(ctx, input, backend); }
  run() { return this.#create(scopeWriteFrameTarget(raw)); }
}
export function forgePrivateDemand(): unknown { const opaque: unknown = new PrivateDemand(); return opaque; }`,
    refusal: refusal([], [], []),
    gap: "Not a forge: a #private member cannot be read or called outside its class body, so hiding the instance loses no demand any outside code could meet; every call inside the body is scanned where it is written.",
  },
  {
    route:
      "a TypeScript-private method demanding the brand, its instance hidden in unknown",
    code: `export class TsPrivateDemand {
  private create(backend: StatementBackend) { return executeEdgeCreate(ctx, input, backend); }
  run() { return this.create(scopeWriteFrameTarget(raw)); }
}
export function forgeTsPrivateDemand(): unknown { const opaque: unknown = new TsPrivateDemand(); return opaque; }`,
    refusal: refusal([], [], ["consumer-flow"]),
  },
  {
    route: "a brand consumer used as a WeakMap key",
    code: `const DEMANDS = new WeakMap<object, number>();
export function forgeWeakKey() {
  const holder = { create: (backend: StatementBackend) => executeEdgeCreate(ctx, input, backend) };
  DEMANDS.set(holder, 1);
  return DEMANDS.get(holder);
}`,
    refusal: refusal([], [], []),
    gap: "Not a forge: a WeakMap or WeakSet never hands a key back (no iteration, no key read), so a value used only as a key cannot be read out and re-asserted; its demand is unreachable through the collection. Store instances are keyed this way.",
  },
  {
    route: "a brand consumer used as a Map key",
    code: `const ITERABLE = new Map<object, number>();
export function forgeIterableKey() {
  const holder = { create: (backend: StatementBackend) => executeEdgeCreate(ctx, input, backend) };
  ITERABLE.set(holder, 1);
  return [...ITERABLE.keys()];
}`,
    refusal: refusal([], [], ["consumer-flow"]),
  },
  {
    route: "an empty library collection instantiated to the brand",
    code: `export function forgeEmptyCollection() { return new Map<string, StatementBackend>(); }`,
    refusal: refusal([], [], []),
    gap: "Not a forge: an argument-less construction of a library container holds no value for the instantiation to have branded, and every value later put in is checked against the instantiated type where it is put.",
  },
  {
    route: "a library collection seeded with a raw transaction",
    code: `export function forgeSeededCollection() { return new Set<StatementBackend>([raw]); }`,
    refusal: refusal([2769], [], ["generic-instantiation"]),
  },
  {
    route:
      "an argument-less construction of a src generic instantiated to the brand",
    code: `export function forgeHolder() { return new Holder<StatementBackend>(); }`,
    refusal: refusal([], [], ["generic-instantiation"]),
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
// Raw engine transactions in Store code
// ---------------------------------------------------------------------------

/**
 * The declarations outside `src/backend` still typed as the engine
 * transaction, by `file#declaring type or function`. Each is spelled by a
 * public API report, which this change keeps byte-identical; the value each
 * carries reaches statement work only through the shim (or, for
 * `ExecutableAggregateQuery.executeOn`, by delegating to the relation's
 * `executeOn`, which shims).
 */
const RAW_TRANSACTION_DECLARATIONS: Readonly<
  Record<
    string,
    Readonly<{
      sites: number;
      route: Extract<RawTransactionRoute, "signature" | "property">;
      reason: string;
    }>
  >
> = {
  "src/store/runtime-port.ts#StoreRuntime": {
    sites: 14,
    route: "signature",
    reason:
      "The Store runtime port's member signatures appear in the store, graph-merge, identity and other reports. They are function types with no body; their implementations in store.ts annotate the narrowed type, which the type checker holds them to.",
  },
  "src/query/builder/types.ts#BatchableQuery": {
    sites: 1,
    route: "signature",
    reason:
      "The public `BatchableQuery.executeOn` signature, a function type with no body. Its implementations are the overloads below.",
  },
  "src/query/builder/executable-query.ts#ExecutableQuery.executeOn": {
    sites: 1,
    route: "signature",
    reason:
      "The public overload of `executeOn`. The implementation receives the Store-facing transaction, so a statement on it is a type error; the body shims once.",
  },
  "src/query/builder/executable-projection-query.ts#ExecutableProjectionQuery.executeOn":
    {
      sites: 1,
      route: "signature",
      reason:
        "The public overload of `executeOn`. The implementation receives the Store-facing transaction, so a statement on it is a type error; the body shims once.",
    },
  "src/query/builder/relation.ts#ExecutableRelationQuery.executeOn": {
    sites: 1,
    route: "signature",
    reason:
      "The public overload of `executeOn`. The implementation receives the Store-facing transaction, so a statement on it is a type error; the body shims once.",
  },
  "src/query/builder/unionable-query.ts#UnionableQuery.executeOn": {
    sites: 1,
    route: "signature",
    reason:
      "The public overload of `executeOn`. The implementation receives the Store-facing transaction, so a statement on it is a type error; the body shims once.",
  },
  "src/query/builder/executable-aggregate-query.ts#ExecutableAggregateQuery.executeOn":
    {
      sites: 1,
      route: "signature",
      reason:
        "The public overload of `executeOn`. The implementation receives the Store-facing transaction and hands the relation's `executeOn` the shimmed handle.",
    },
  "src/store/types.ts#TransactionRuntime": {
    sites: 1,
    route: "property",
    reason:
      "`TransactionRuntime.backend` appears in the store reports. A property has one type for every reader and no overload, so the type checker cannot narrow it for Store code; each read is checked by this scan instead. Its one reader, `transactionBackend()`, returns `StoreTransactionBackend`.",
  },
  "src/identity/service-types.ts#IdentityServiceContext": {
    sites: 1,
    route: "property",
    reason:
      "`IdentityServiceContext.backend` appears in the reports through the runtime port's `identityContext`. A property has one type for every reader and no overload, so the type checker cannot narrow it for Store code; each read is checked by this scan instead, and every statement-issuing read goes through the shim.",
  },
};

/** A path inside `src/store`, so the fixture resolves imports like a store module. */
const RAW_TRANSACTION_FIXTURE = "src/store/raw-transaction-routes.fixture.ts";

/** A second store module that re-exports the engine type under another name. */
const RAW_TRANSACTION_REEXPORT_FIXTURE =
  "src/store/raw-transaction-reexport.fixture.ts";

const RAW_TRANSACTION_REEXPORT_SOURCE = `
export type { TransactionBackend as Session } from "../backend/types";
`;

const RAW_TRANSACTION_PREAMBLE = `
import type {
  GraphBackend,
  SchemaCommitPreflightBackend,
  SchemaWriteTransactionBackend,
  TransactionBackend,
} from "../backend/types";
import type * as types from "../backend/types";
import {
  legacyTransactionOperation,
  storeSchemaWriteTransaction,
  type StoreSchemaWriteTransaction,
  type StoreTransactionBackend,
} from "./operation-scope";
import type { Session } from "./raw-transaction-reexport.fixture";

declare const root: GraphBackend;
type Engine = TransactionBackend;
declare const narrowed: StoreTransactionBackend;
declare function engineTransaction(): ReturnType<() => TransactionBackend>;
function keyOnly(key: object): void {
  void key;
}
`;

type RawTransactionCase = Readonly<{
  route: string;
  code: string;
  /** Diagnostic codes the case's code draws. */
  typeErrors: readonly number[];
  /** What `rawTransactionSites` reports for the case. */
  scan: readonly RawTransactionRoute[];
  /** Set only on a case that is allowed: why it is not a raw transaction. */
  allowed?: string;
}>;

const RAW_TRANSACTION_CASES: readonly RawTransactionCase[] = [
  {
    route: "a statement on the Store-facing transaction",
    code: `export async function statementOnNarrowed() { await narrowed.getNode("graph", "Kind", "id"); }`,
    typeErrors: [2339],
    scan: [],
  },
  {
    route: "a transaction callback left to infer the engine type",
    code: `export function inferredCallback() { return root.transaction(async (tx) => tx.getNode("graph", "Kind", "id")); }`,
    typeErrors: [],
    scan: ["declaration"],
  },
  {
    route: "a transaction callback that receives the Store-facing type",
    code: `export function narrowedCallback() { return root.transaction(async (tx: StoreTransactionBackend) => legacyTransactionOperation(tx).getNode("graph", "Kind", "id")); }`,
    typeErrors: [],
    scan: [],
    allowed:
      "The callback narrows the transaction where it is opened, and its statement goes through the shim.",
  },
  {
    route: "a call producing the engine type",
    code: `export async function producedValue() { await engineTransaction().getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: ["value"],
  },
  {
    route: "the engine type handed straight to the shim",
    code: `export async function shimmedValue() { await legacyTransactionOperation(engineTransaction()).getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: [],
    allowed:
      "The shim consumes the value; what it returns is the counted handle.",
  },
  {
    route: "the engine type narrowed on arrival into an identity-only position",
    code: `export function keyedValue() { keyOnly(engineTransaction()); }`,
    typeErrors: [],
    scan: [],
    allowed:
      "The position exposes no statement member, so the raw type does not survive its arrival.",
  },
  {
    route: "the engine type read only for its identity",
    code: `export function identityRead() { return engineTransaction().dialect; }`,
    typeErrors: [],
    scan: [],
    allowed: "`dialect` is a member the Store-facing type carries.",
  },
  {
    route: "an assertion to the engine type",
    code: `export async function assertedEngine() { await (narrowed as TransactionBackend).getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: ["assertion"],
  },
  {
    route: "an assertion through unknown to the engine type",
    code: `export async function assertedThroughUnknown() { await (narrowed as unknown as TransactionBackend).getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: ["assertion"],
  },
  {
    route: "as never into an engine-typed parameter",
    code: `export function assertedNever() { const engineOnly = (tx: TransactionBackend) => tx.dialect; return engineOnly(narrowed as never); }`,
    typeErrors: [],
    scan: ["assertion", "declaration"],
  },
  {
    route: "an assertion forging the engine type a Store transaction records",
    code: `export async function forgedRecord() { await legacyTransactionOperation(narrowed as StoreTransactionBackend<SchemaWriteTransactionBackend>).executeSchemaDdl("SELECT 1"); }`,
    typeErrors: [],
    scan: ["assertion"],
  },
  {
    route:
      "an ordinary transaction callback annotated as the schema-write transaction",
    code: `export function claimedSchemaWrite() { return root.transaction(async (tx: StoreTransactionBackend<SchemaWriteTransactionBackend>) => legacyTransactionOperation(tx).executeSchemaDdl("SELECT 1")); }`,
    typeErrors: [2345],
    scan: [],
  },
  {
    route: "an ordinary transaction callback annotated as the preflight target",
    code: `export function claimedPreflight() { return root.transaction(async (tx: StoreTransactionBackend<SchemaCommitPreflightBackend>) => legacyTransactionOperation(tx).executeSchemaDdl?.("SELECT 1")); }`,
    typeErrors: [2345],
    scan: [],
  },
  {
    route: "the schema-write transaction through its boundary mint",
    code: `export function mintedSchemaWrite() { return storeSchemaWriteTransaction(root.schemaWriteTransaction)?.("graph", async (tx) => legacyTransactionOperation(tx).executeSchemaDdl("SELECT 1")); }`,
    typeErrors: [],
    scan: [],
    allowed:
      "The engine member that opens the schema-write transaction is the one place its specialised type is granted.",
  },
  {
    route: "an ordinary opener asserted to the schema-write opener",
    code: `export function forgedOpener() { return (root.transaction as unknown as StoreSchemaWriteTransaction)("graph", async (tx) => legacyTransactionOperation(tx).executeSchemaDdl("SELECT 1")); }`,
    typeErrors: [],
    scan: ["assertion"],
  },
  {
    route: "an assertion to the engine type through a local alias",
    code: `export async function assertedAlias() { await (narrowed as Engine).getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: ["assertion"],
  },
  {
    route: "an assertion to the engine type through a namespace",
    code: `export async function assertedNamespace() { await (narrowed as types.TransactionBackend).getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: ["assertion"],
  },
  {
    route: 'an assertion to the engine type through an inline import("…") type',
    code: `export async function assertedImportType() { await (narrowed as import("../backend/types").TransactionBackend).getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: ["assertion"],
  },
  {
    route: "an assertion to the engine type through a renamed re-export",
    code: `export async function assertedReexport() { await (narrowed as Session).getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: ["assertion"],
  },
  {
    route:
      "an assertion to the engine type through an indexed access into the opener",
    code: `export async function assertedIndexed() { await (narrowed as Parameters<Parameters<GraphBackend["transaction"]>[0]>[0]).getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: ["assertion"],
  },
  {
    route:
      "a public overload keeping the engine type over a narrowed implementation",
    code: `export function overloaded(tx: TransactionBackend): string;
export function overloaded(tx: StoreTransactionBackend): string { return tx.dialect; }`,
    typeErrors: [],
    scan: ["signature"],
    allowed:
      "A bodiless signature: no code can use its parameter, and the implementation's parameter is held to the Store-facing type by the type checker.",
  },
  {
    route: "a statement on an overloaded implementation's narrowed parameter",
    code: `export async function overloadedStatement(tx: GraphBackend | TransactionBackend): Promise<void>;
export async function overloadedStatement(tx: GraphBackend | StoreTransactionBackend): Promise<void> { await tx.getNode("graph", "Kind", "id"); }`,
    typeErrors: [2339],
    scan: ["signature"],
  },
  {
    route: "a public signature whose implementation keeps the engine type",
    code: `export async function rawImplementation(tx: TransactionBackend): Promise<void>;
export async function rawImplementation(tx: TransactionBackend): Promise<void> { await tx.getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: ["declaration", "signature"],
  },
  {
    route: "a read of a property declared with the engine type",
    code: `export async function propertyRead(holder: Readonly<{ backend: TransactionBackend }>) { await holder.backend.getNode("graph", "Kind", "id"); }`,
    typeErrors: [],
    scan: ["property", "value"],
  },
];

const RAW_TRANSACTION_SOURCE = [
  RAW_TRANSACTION_PREAMBLE,
  ...RAW_TRANSACTION_CASES.map(
    (rawCase, index) => `${routeLine(index)}\n${rawCase.code}\n`,
  ),
].join("\n");

/** The case index of each 1-based raw-transaction fixture line; preamble lines map to -1. */
function rawCaseIndexOfLine(line: number): number {
  const lines = RAW_TRANSACTION_SOURCE.split("\n");
  for (let current = line - 1; current >= 0; current -= 1) {
    const match = /^\/\/ route (\d+)$/.exec(lines[current] ?? "");
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The boundary mints' arguments
// ---------------------------------------------------------------------------

/**
 * Each boundary mint's calls in `src`, by mint. Every one passes a read of
 * the mint's own engine member.
 */
const BOUNDARY_MINT_CALLS = {
  storeSchemaWriteTransaction: 4,
  storeCommitSchemaVersionWithPreflight: 2,
  storeSetActiveVersionWithPreflight: 1,
  storeAdoptSchemaWriteTransaction: 1,
} as const satisfies Record<keyof typeof BOUNDARY_MINT_MEMBERS, number>;

/** A path inside `src/store`, so the fixture resolves imports like a store module. */
const BOUNDARY_ARGUMENT_FIXTURE =
  "src/store/boundary-mint-arguments.fixture.ts";

const BOUNDARY_ARGUMENT_SOURCE = `
import type {
  CommitSchemaVersionParams,
  GraphBackend,
  SchemaCommitPreflightBackend,
  SchemaVersionRow,
} from "../backend/types";
import * as scope from "./operation-scope";
import { storeCommitSchemaVersionWithPreflight } from "./operation-scope";

declare const backend: GraphBackend;

export function memberRead() { return storeCommitSchemaVersionWithPreflight(backend.commitSchemaVersionWithPreflight); }
export function optionalMemberRead(maybe: GraphBackend | undefined) { return storeCommitSchemaVersionWithPreflight(maybe?.commitSchemaVersionWithPreflight); }
export function throughNamespace() { return scope.storeCommitSchemaVersionWithPreflight(backend.commitSchemaVersionWithPreflight); }
export function adapter() {
  return storeCommitSchemaVersionWithPreflight(
    (params: CommitSchemaVersionParams, preflight: (target: SchemaCommitPreflightBackend) => Promise<void>): Promise<SchemaVersionRow> =>
      backend.transaction(async (tx) => { await preflight(tx); return backend.commitSchemaVersion(params); }),
  );
}
export function stored() { const commit = backend.commitSchemaVersionWithPreflight; return storeCommitSchemaVersionWithPreflight(commit); }
export function literalProperty(commit: GraphBackend["commitSchemaVersionWithPreflight"]) { return storeCommitSchemaVersionWithPreflight({ commitSchemaVersionWithPreflight: commit }.commitSchemaVersionWithPreflight); }
`;

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
      [RAW_TRANSACTION_FIXTURE]: RAW_TRANSACTION_SOURCE,
      [RAW_TRANSACTION_REEXPORT_FIXTURE]: RAW_TRANSACTION_REEXPORT_SOURCE,
      [BOUNDARY_ARGUMENT_FIXTURE]: BOUNDARY_ARGUMENT_SOURCE,
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

  it("src forges the brand only at the mints", { timeout: 180_000 }, () => {
    expect(
      forgeSites(scan, scan.sourceFiles).map((site) => ({
        file: site.file,
        function: site.function,
        route: site.route,
      })),
    ).toEqual(MINT_SITES);
  });

  it(
    "src produces a specialised Store transaction only at the boundary mints",
    { timeout: 180_000 },
    () => {
      expect(
        forgeSites(scan, scan.sourceFiles, "engine record").map((site) => ({
          file: site.file,
          function: site.function,
          route: site.route,
        })),
      ).toEqual(BOUNDARY_MINT_SITES);
    },
  );

  it(
    "every boundary mint in src is handed a read of its own engine member",
    { timeout: 180_000 },
    () => {
      const calls = boundaryMintCalls(scan, scan.sourceFiles);
      expect(
        calls
          .filter((call) => call.argument !== "member-read")
          .map((call) => `${call.file}:${call.line} ${call.mint}`),
      ).toEqual([]);
      const counts: Record<string, number> = {};
      for (const call of calls)
        counts[call.mint] = (counts[call.mint] ?? 0) + 1;
      expect(counts).toEqual(BOUNDARY_MINT_CALLS);
    },
  );

  it("refuses a boundary mint handed anything but its engine member", () => {
    // Every case compiles: the adapter is exactly the function no type refuses.
    expect(errorDiagnostics(scan, BOUNDARY_ARGUMENT_FIXTURE)).toEqual([]);
    expect(
      boundaryMintCalls(scan, [
        path.join(PACKAGE_ROOT, BOUNDARY_ARGUMENT_FIXTURE),
      ]).map((call) => ({ function: call.function, argument: call.argument })),
    ).toEqual([
      { function: "memberRead", argument: "member-read" },
      { function: "optionalMemberRead", argument: "member-read" },
      { function: "throughNamespace", argument: "member-read" },
      { function: "adapter", argument: "other" },
      { function: "stored", argument: "other" },
      { function: "literalProperty", argument: "other" },
    ]);
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

  it(
    "Store code holds the engine transaction type only where a public API report spells it",
    { timeout: 180_000 },
    () => {
      const sites = rawTransactionSites(scan, storeFacingModules(scan));
      // A name Store code can use, a value or an assertion is never allowed:
      // only a bodiless signature or a property the reports spell.
      expect(
        sites
          .filter(
            (site) => site.route !== "signature" && site.route !== "property",
          )
          .map(
            (site) => `${site.file}:${site.line} ${site.route} ${site.text}`,
          ),
      ).toEqual([]);
      const counts: Record<string, number> = {};
      for (const site of sites) {
        const label = `${site.file}#${site.function} ${site.route}`;
        counts[label] = (counts[label] ?? 0) + 1;
      }
      expect(counts).toEqual(
        Object.fromEntries(
          Object.entries(RAW_TRANSACTION_DECLARATIONS).map(([label, entry]) => [
            `${label} ${entry.route}`,
            entry.sites,
          ]),
        ),
      );
    },
  );

  it("every raw-transaction route is reported, refused by the type checker, or a stated allowance", () => {
    const fixturePath = path.join(PACKAGE_ROOT, RAW_TRANSACTION_FIXTURE);
    const typeErrors = errorDiagnostics(scan, RAW_TRANSACTION_FIXTURE);
    const sites = rawTransactionSites(scan, [fixturePath]);

    // The preamble compiles and scans clean, so every hit belongs to a case.
    expect({
      typeErrors: typeErrors.filter(([line]) => rawCaseIndexOfLine(line) < 0),
      scan: sites.filter((site) => rawCaseIndexOfLine(site.line) < 0),
    }).toEqual({ typeErrors: [], scan: [] });

    expect(
      RAW_TRANSACTION_CASES.map((rawCase, index) => ({
        route: rawCase.route,
        typeErrors: [
          ...new Set(
            typeErrors
              .filter(([line]) => rawCaseIndexOfLine(line) === index)
              .map(([, code]) => code),
          ),
        ].toSorted((left, right) => left - right),
        scan: sortedUnique(
          sites
            .filter((site) => rawCaseIndexOfLine(site.line) === index)
            .map((site) => site.route),
        ),
      })),
    ).toEqual(
      RAW_TRANSACTION_CASES.map((rawCase) => ({
        route: rawCase.route,
        typeErrors: rawCase.typeErrors.toSorted((left, right) => left - right),
        scan: sortedUnique(rawCase.scan),
      })),
    );

    for (const rawCase of RAW_TRANSACTION_CASES) {
      const refused =
        rawCase.typeErrors.length > 0 ||
        rawCase.scan.some(
          (route) => route !== "signature" && route !== "property",
        );
      expect({ route: rawCase.route, refused }).toEqual({
        route: rawCase.route,
        refused: rawCase.allowed === undefined,
      });
    }
  });
});
