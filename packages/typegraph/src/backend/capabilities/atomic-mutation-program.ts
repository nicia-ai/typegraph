/**
 * Exact-resource execution profile for closed semantic mutation programs.
 *
 * The transport-level atomic SQL executor answers only "can this exact resource
 * submit a closed statement sequence atomically?" This profile is the next
 * layer up: it names the TypeGraph mutations the backend can lower onto that
 * transport. Keeping every mutation family in one exact-resource registration
 * prevents each new operation from inventing another provenance WeakMap.
 */
import { ConfigurationError } from "../../errors";
import type {
  ClaimEdgeCardinalityParams,
  EdgeConvergenceMatch,
  EdgeRow,
  GraphBackend,
  InsertEdgeParams,
  InsertNodeParams,
  NodeInsertClaim,
  NodeRow,
  SchemaWriteFenceParams,
  TransactionBackend,
} from "../types";
import { supportsAtomicBatch } from "../types";
import {
  hasAtomicSqlProgramRegistration,
  registerAtomicSqlProgram,
  resolveRegisteredAtomicSqlBatchExecutor,
} from "./atomic-sql-program";

/** How a node batch member obtained the identifier stored by its program. */
export type AtomicNodeBatchIdSource = "generated" | "caller";
/** Whether a node batch returns only its count or its ordered postimages. */
export type AtomicNodeBatchResultMode = "count" | "rows";

/** Independently provable claim semantics accepted by a node mutation family. */
export type AtomicNodeClaimFamily = "disjointness" | "uniqueness";

/** Closed claim envelope advertised by one node mutation executor. */
export type AtomicNodeClaimSupport = Readonly<{
  /** Pure-family member ceilings; an omitted family is unsupported. */
  maxEntriesByFamily: Readonly<Partial<Record<AtomicNodeClaimFamily, number>>>;
  /** Total claimed-member ceiling when more than one family is present. */
  maxMixedEntries?: number;
}>;

function isAtomicNodeClaimFamily(
  value: unknown,
): value is AtomicNodeClaimFamily {
  return value === "disjointness" || value === "uniqueness";
}

function assertAtomicNodeClaimFamilies(
  family: keyof AtomicMutationProgramRegistration,
  name: string,
  value: unknown,
): void {
  if (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((claimFamily) => isAtomicNodeClaimFamily(claimFamily))
  ) {
    return;
  }
  throw new ConfigurationError(
    `Atomic mutation program family ${family} requires distinct ${name}.`,
    {
      code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
      family,
      limit: name,
      value,
    },
  );
}

function assertAtomicNodeClaimSupport(
  family: "createNodes" | "mutateNodes",
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null) {
    throw new ConfigurationError(
      `Atomic mutation program family ${family} requires claimSupport metadata.`,
      {
        code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
        family,
        limit: "claimSupport",
        value,
      },
    );
  }
  const support = value as Readonly<Record<PropertyKey, unknown>>;
  const maxEntriesByFamily = support["maxEntriesByFamily"];
  if (
    typeof maxEntriesByFamily !== "object" ||
    maxEntriesByFamily === null ||
    Array.isArray(maxEntriesByFamily)
  ) {
    throw new ConfigurationError(
      `Atomic mutation program family ${family} requires family-scoped claim limits.`,
      {
        code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
        family,
        limit: "claimSupport.maxEntriesByFamily",
        value: maxEntriesByFamily,
      },
    );
  }
  const familyLimits = Object.entries(maxEntriesByFamily);
  for (const [claimFamily, limit] of familyLimits) {
    if (!isAtomicNodeClaimFamily(claimFamily)) {
      throw new ConfigurationError(
        `Atomic mutation program family ${family} received an unknown claim family.`,
        {
          code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
          family,
          limit: "claimSupport.maxEntriesByFamily",
          value: claimFamily,
        },
      );
    }
    assertNonnegativeIntegerLimit(
      family,
      `claimSupport.maxEntriesByFamily.${claimFamily}`,
      limit,
    );
  }
  if (support["maxMixedEntries"] !== undefined) {
    if (familyLimits.length < 2) {
      throw new ConfigurationError(
        `Atomic mutation program family ${family} cannot advertise mixed claims without two claim families.`,
        {
          code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
          family,
          limit: "claimSupport.maxMixedEntries",
          value: support["maxMixedEntries"],
        },
      );
    }
    assertNonnegativeIntegerLimit(
      family,
      "claimSupport.maxMixedEntries",
      support["maxMixedEntries"],
    );
  }
}

/** The one owner of claim-verdict to advertised-family correlation. */
function atomicNodeClaimFamily(claim: NodeInsertClaim): AtomicNodeClaimFamily {
  return claim.verdict.kind;
}

/** Whether one executor explicitly accepts every normalized claimed member. */
export function supportsAtomicNodeClaims(
  support: AtomicNodeClaimSupport | undefined,
  claims: readonly NodeInsertClaim[],
): boolean {
  if (claims.length === 0) return true;
  if (support === undefined) return false;
  const families = new Set(claims.map((claim) => atomicNodeClaimFamily(claim)));
  if (
    [...families].some(
      (family) => support.maxEntriesByFamily[family] === undefined,
    )
  ) {
    return false;
  }
  if (families.size > 1) {
    return (
      support.maxMixedEntries !== undefined &&
      claims.length <= support.maxMixedEntries
    );
  }
  const family = families.values().next().value;
  return (
    family !== undefined &&
    claims.length <= (support.maxEntriesByFamily[family] ?? 0)
  );
}

/** Whether an executor can admit at least one member of a claim family. */
export function supportsAtomicNodeClaimFamily(
  support: AtomicNodeClaimSupport | undefined,
  family: AtomicNodeClaimFamily,
): boolean {
  return (support?.maxEntriesByFamily[family] ?? 0) > 0;
}

/** One normalized node-create member supplied to a semantic executor. */
export type AtomicNodeBatchEntry = Readonly<{
  idSource: AtomicNodeBatchIdSource;
  params: InsertNodeParams;
  /** The one claim this row owes in the currently supported native shape. */
  claim?: NodeInsertClaim;
}>;

/** Complete schema-fenced input to an atomic node-create family. */
export type AtomicNodeBatchInput = Readonly<{
  entries: readonly AtomicNodeBatchEntry[];
  resultMode: AtomicNodeBatchResultMode;
  schemaFence: SchemaWriteFenceParams;
}>;

/** Executes the complete eligible node-create family for one exact root. */
export interface AtomicNodeBatchExecutor {
  /** Claim semantics this executor can prove, omitted for plain rows only. */
  readonly claimSupport?: AtomicNodeClaimSupport;
  (
    input: AtomicNodeBatchInput & Readonly<{ resultMode: "count" }>,
  ): Promise<number>;
  (
    input: AtomicNodeBatchInput & Readonly<{ resultMode: "rows" }>,
  ): Promise<readonly NodeRow[]>;
}

/** Count-returning input to an atomic direct edge-create family. */
export type AtomicEdgeBatchCountInput = Readonly<{
  claims: readonly ClaimEdgeCardinalityParams[];
  params: readonly InsertEdgeParams[];
  resultMode: "count";
  schemaFence: SchemaWriteFenceParams;
}>;

/** Postimage-returning input to an atomic direct edge-create family. */
export type AtomicEdgeBatchRowsInput = Readonly<{
  claims: readonly ClaimEdgeCardinalityParams[];
  params: readonly InsertEdgeParams[];
  resultMode: "rows";
  schemaFence: SchemaWriteFenceParams;
}>;

/** Executes complete eligible direct edge creates for one exact root. */
export interface AtomicEdgeBatchExecutor {
  (input: AtomicEdgeBatchCountInput): Promise<number>;
  (input: AtomicEdgeBatchRowsInput): Promise<readonly EdgeRow[]>;
}

/** One normalized durable edge-convergence member. */
export type AtomicEdgeConvergenceEntry = Readonly<{
  params: InsertEdgeParams;
  match: EdgeConvergenceMatch;
}>;

/** Authoritative row and outcome returned by durable convergence. */
export type AtomicEdgeConvergenceResult = Readonly<{
  row: EdgeRow;
  outcome: "created" | "found";
}>;

/** Complete schema-fenced durable edge-convergence input. */
export type AtomicEdgeConvergenceInput = Readonly<{
  kind: "durable-convergence";
  entries: readonly AtomicEdgeConvergenceEntry[];
  schemaFence: SchemaWriteFenceParams;
}>;

/** Complete schema-fenced direct edge-delete input. */
export type AtomicEdgeDeleteBatchInput = Readonly<{
  graphId: string;
  expectedKind: string;
  ids: readonly string[];
  schemaFence: SchemaWriteFenceParams;
}>;

/** Delete count plus explicit evidence that the schema fence matched. */
export type AtomicDeleteBatchResult = Readonly<{
  affectedCount: number;
  schemaFenceMatched: boolean;
}>;

/** Executes complete eligible direct edge deletes for one exact root. */
export type AtomicEdgeDeleteBatchExecutor = (
  input: AtomicEdgeDeleteBatchInput,
) => Promise<AtomicDeleteBatchResult>;

/** Complete schema-fenced direct node-delete input. */
export type AtomicNodeDeleteBatchInput = Readonly<{
  graphId: string;
  kind: string;
  ids: readonly string[];
  schemaFence: SchemaWriteFenceParams;
}>;

/** Executes complete eligible direct node deletes for one exact root. */
export interface AtomicNodeDeleteBatchExecutor {
  /** Claim families whose owned sidecars this program releases. */
  readonly releasedClaimFamilies?: readonly AtomicNodeClaimFamily[];
  (input: AtomicNodeDeleteBatchInput): Promise<AtomicDeleteBatchResult>;
}

/** One authoritative node preimage and replacement used by a resolved set. */
export type AtomicNodeResolvedUpdateEntry = Readonly<{
  graphId: string;
  kind: string;
  id: string;
  props: Readonly<Record<string, unknown>>;
  expectedVersion: number;
}>;

/** Executes a complete eligible resolved node update set. */
export interface AtomicNodeResolvedUpdateBatchExecutor {
  readonly maxEntries: number;
  (
    input: Readonly<{
      entries: readonly AtomicNodeResolvedUpdateEntry[];
      schemaFence: SchemaWriteFenceParams;
    }>,
  ): Promise<readonly NodeRow[]>;
}

/** One authoritative edge preimage and replacement used by a resolved set. */
export type AtomicEdgeResolvedUpdateEntry = Readonly<{
  existing: EdgeRow;
  props: Readonly<Record<string, unknown>>;
}>;

/** Executes a complete eligible resolved edge update set. */
export interface AtomicEdgeResolvedUpdateBatchExecutor {
  readonly maxEntries: number;
  (
    input: Readonly<{
      entries: readonly AtomicEdgeResolvedUpdateEntry[];
      schemaFence: SchemaWriteFenceParams;
    }>,
  ): Promise<readonly EdgeRow[]>;
}

/** Ordered node postimages returned by a mixed resolved mutation set. */
export type AtomicNodeResolvedMutationSetResult = Readonly<{
  created: readonly NodeRow[];
  updated: readonly NodeRow[];
}>;

/** Executes a complete eligible mixed node create/update set. */
export interface AtomicNodeResolvedMutationSetExecutor {
  /** Maximum total members the terminal postimage assertion can prove. */
  readonly maxEntries: number;
  (
    input: Readonly<{
      creates: readonly AtomicNodeBatchEntry[];
      updates: readonly AtomicNodeResolvedUpdateEntry[];
      schemaFence: SchemaWriteFenceParams;
    }>,
  ): Promise<AtomicNodeResolvedMutationSetResult>;
}

/** Ordered edge postimages returned by a mixed resolved mutation set. */
export type AtomicEdgeResolvedMutationSetResult = Readonly<{
  created: readonly EdgeRow[];
  updated: readonly EdgeRow[];
}>;

/** Complete schema-fenced input to a mixed resolved edge mutation set. */
export type AtomicEdgeResolvedMutationSetInput = Readonly<{
  kind: "resolved-set";
  creates: readonly InsertEdgeParams[];
  updates: readonly AtomicEdgeResolvedUpdateEntry[];
  schemaFence: SchemaWriteFenceParams;
}>;

/** Executes resolved edge sets and durable convergence for one exact root. */
export interface AtomicEdgeMutationProgramExecutor {
  readonly maxEntries: Readonly<{
    resolvedSet: number;
    durableConvergence: number;
  }>;
  (
    input: AtomicEdgeResolvedMutationSetInput,
  ): Promise<AtomicEdgeResolvedMutationSetResult>;
  (
    input: AtomicEdgeConvergenceInput,
  ): Promise<readonly AtomicEdgeConvergenceResult[]>;
}

/** Internal proof that the closed SQL program rejected a missing endpoint. */
export class AtomicEdgeBatchEndpointRefusalError extends Error {
  constructor(cause: unknown) {
    super("Atomic edge batch endpoint validation failed", { cause });
    this.name = "AtomicEdgeBatchEndpointRefusalError";
  }
}

/** Internal proof that the closed SQL program refused a cardinality claim. */
export class AtomicEdgeBatchCardinalityRefusalError extends Error {
  constructor(cause: unknown) {
    super("Atomic edge batch cardinality validation failed", { cause });
    this.name = "AtomicEdgeBatchCardinalityRefusalError";
  }
}

/** Internal proof that native convergence encountered a tombstoned winner. */
export class AtomicEdgeConvergenceTombstoneRefusalError extends Error {
  constructor(cause: unknown) {
    super("Atomic edge convergence requires portable resurrection", { cause });
    this.name = "AtomicEdgeConvergenceTombstoneRefusalError";
  }
}

/** Internal proof that an edge-delete input belongs to another collection. */
export class AtomicEdgeDeleteIdentityRefusalError extends Error {
  constructor(cause: unknown) {
    super("Atomic edge delete batch identity validation failed", { cause });
    this.name = "AtomicEdgeDeleteIdentityRefusalError";
  }
}

/** Internal proof that a restricted node still has a live connected edge. */
export class AtomicNodeDeleteRestrictedRefusalError extends Error {
  constructor(cause: unknown) {
    super("Atomic node delete batch restriction validation failed", { cause });
    this.name = "AtomicNodeDeleteRestrictedRefusalError";
  }
}

/**
 * The semantic mutation families one exact bundled root can lower today.
 * New families extend this profile instead of adding another root registry.
 */
export type AtomicMutationProgramExecutor = Readonly<{
  createNodes?: AtomicNodeBatchExecutor;
  createEdges?: AtomicEdgeBatchExecutor;
  deleteNodes?: AtomicNodeDeleteBatchExecutor;
  deleteEdges?: AtomicEdgeDeleteBatchExecutor;
  updateNodes?: AtomicNodeResolvedUpdateBatchExecutor;
  updateEdges?: AtomicEdgeResolvedUpdateBatchExecutor;
  mutateNodes?: AtomicNodeResolvedMutationSetExecutor;
  mutateEdges?: AtomicEdgeMutationProgramExecutor;
}>;

/** Every independently enabled semantic variant in a mutation profile. */
export const ATOMIC_MUTATION_PROGRAM_VARIANTS = [
  "createNodes",
  "createEdges",
  "deleteNodes",
  "deleteEdges",
  "updateNodes",
  "updateEdges",
  "mutateNodes",
  "mutateEdges.resolvedSet",
  "mutateEdges.durableConvergence",
] as const;

/** One independently enabled semantic variant in a mutation profile. */
export type AtomicMutationProgramVariant =
  (typeof ATOMIC_MUTATION_PROGRAM_VARIANTS)[number];

/** One owner for the overloaded edge-mutation input/variant correlation. */
export const ATOMIC_EDGE_MUTATION_VARIANT_BY_KIND = {
  "durable-convergence": "mutateEdges.durableConvergence",
  "resolved-set": "mutateEdges.resolvedSet",
} as const satisfies Readonly<
  Record<
    | AtomicEdgeConvergenceInput["kind"]
    | AtomicEdgeResolvedMutationSetInput["kind"],
    Extract<AtomicMutationProgramVariant, `mutateEdges.${string}`>
  >
>;

/**
 * Owns which semantic variants a normalized profile can reach independently.
 *
 * A zero limit is an honest opt-out. Singleton updates reach the update-only
 * families directly on every exact root. Mixed resolved sets move their
 * collection-level read/partition/write unit into an interactive transaction;
 * an interactive root therefore cannot reach them, while an exact registered
 * `atomicBatch: "session"` target can. Conformance consumes this owner instead
 * of inferring session reachability from transaction availability.
 */
export function reachableAtomicMutationProgramVariants(
  profile: AtomicMutationProgramExecutor,
  execution: Pick<
    GraphBackend["capabilities"]["execution"],
    "atomicBatch" | "interactiveTransactions"
  >,
): readonly AtomicMutationProgramVariant[] {
  const variants: AtomicMutationProgramVariant[] = [];
  const resolvedMutationSetsReachable =
    !execution.interactiveTransactions || execution.atomicBatch === "session";
  if (profile.createNodes !== undefined) variants.push("createNodes");
  if (profile.createEdges !== undefined) variants.push("createEdges");
  if (profile.deleteNodes !== undefined) variants.push("deleteNodes");
  if (profile.deleteEdges !== undefined) variants.push("deleteEdges");
  if ((profile.updateNodes?.maxEntries ?? 0) > 0) {
    variants.push("updateNodes");
  }
  if ((profile.updateEdges?.maxEntries ?? 0) > 0) {
    variants.push("updateEdges");
  }
  if (
    resolvedMutationSetsReachable &&
    (profile.mutateNodes?.maxEntries ?? 0) > 0
  ) {
    variants.push("mutateNodes");
  }
  if (
    resolvedMutationSetsReachable &&
    (profile.mutateEdges?.maxEntries.resolvedSet ?? 0) > 0
  ) {
    variants.push("mutateEdges.resolvedSet");
  }
  if ((profile.mutateEdges?.maxEntries.durableConvergence ?? 0) > 0) {
    variants.push("mutateEdges.durableConvergence");
  }
  return variants;
}

/**
 * Semantic mutation families implemented by one exact backend root.
 *
 * Registering this profile is an explicit claim about TypeGraph write
 * semantics, not merely transport mechanics. Each optional member authorizes
 * only that family; omitted families retain the complete portable path.
 */
export type AtomicMutationProgramRegistration = Readonly<{
  createNodes?: AtomicNodeBatchExecutor | undefined;
  createEdges?: AtomicEdgeBatchExecutor | undefined;
  deleteNodes?: AtomicNodeDeleteBatchExecutor | undefined;
  deleteEdges?: AtomicEdgeDeleteBatchExecutor | undefined;
  updateNodes?: AtomicNodeResolvedUpdateBatchExecutor | undefined;
  updateEdges?: AtomicEdgeResolvedUpdateBatchExecutor | undefined;
  mutateNodes?: AtomicNodeResolvedMutationSetExecutor | undefined;
  mutateEdges?: AtomicEdgeMutationProgramExecutor | undefined;
}>;

const ATOMIC_MUTATION_PROGRAM_EXECUTORS = new WeakMap<
  object,
  AtomicMutationProgramExecutor
>();

type AtomicMutationProgramDispatchObserver = (
  variant: AtomicMutationProgramVariant,
) => void;

const ATOMIC_MUTATION_PROGRAM_DISPATCH_OBSERVERS = new WeakMap<
  object,
  AtomicMutationProgramDispatchObserver
>();
const INSTRUMENTED_ATOMIC_MUTATION_EXECUTOR_TARGETS = new WeakMap<
  object,
  object
>();

function reportAtomicMutationProgramDispatch(
  target: object,
  variant: AtomicMutationProgramVariant,
): void {
  ATOMIC_MUTATION_PROGRAM_DISPATCH_OBSERVERS.get(target)?.(variant);
}

function instrumentAtomicMutationProgramExecutors(
  target: object,
  profile: AtomicMutationProgramRegistration,
): AtomicMutationProgramExecutor {
  type Descriptor = Readonly<{
    variant: (input: unknown) => AtomicMutationProgramVariant;
  }>;
  const descriptors = {
    createEdges: { variant: () => "createEdges" },
    createNodes: { variant: () => "createNodes" },
    deleteEdges: { variant: () => "deleteEdges" },
    deleteNodes: { variant: () => "deleteNodes" },
    mutateEdges: {
      variant: (input: unknown) =>
        ATOMIC_EDGE_MUTATION_VARIANT_BY_KIND[
          (
            input as
              AtomicEdgeConvergenceInput | AtomicEdgeResolvedMutationSetInput
          ).kind
        ],
    },
    mutateNodes: { variant: () => "mutateNodes" },
    updateEdges: { variant: () => "updateEdges" },
    updateNodes: { variant: () => "updateNodes" },
  } as const satisfies Record<
    keyof AtomicMutationProgramRegistration,
    Descriptor
  >;

  function instrument<TExecutor extends object>(
    source: TExecutor,
    descriptor: Descriptor,
  ): TExecutor {
    if (INSTRUMENTED_ATOMIC_MUTATION_EXECUTOR_TARGETS.get(source) === target) {
      return source;
    }
    const callable = source as unknown as (
      ...arguments_: readonly unknown[]
    ) => unknown;
    const instrumented = new Proxy(callable, {
      apply(sourceExecutor, thisArgument, argumentsList) {
        reportAtomicMutationProgramDispatch(
          target,
          descriptor.variant(argumentsList[0]),
        );
        return Reflect.apply(sourceExecutor, thisArgument, argumentsList);
      },
    });
    INSTRUMENTED_ATOMIC_MUTATION_EXECUTOR_TARGETS.set(instrumented, target);
    return instrumented as unknown as TExecutor;
  }

  const entries = ATOMIC_MUTATION_PROGRAM_FAMILIES.flatMap((family) => {
    const executor = profile[family];
    return executor === undefined ?
        []
      : [[family, instrument(executor, descriptors[family])] as const];
  });
  return Object.freeze(
    Object.fromEntries(entries) as AtomicMutationProgramExecutor,
  );
}

/** @internal Runs work while observing dispatches from this exact resource. */
export async function withAtomicMutationProgramDispatchObserver<TResult>(
  target: object,
  observer: AtomicMutationProgramDispatchObserver,
  run: () => TResult | PromiseLike<TResult>,
): Promise<TResult> {
  if (ATOMIC_MUTATION_PROGRAM_DISPATCH_OBSERVERS.has(target)) {
    throw new ConfigurationError(
      "Atomic mutation program dispatch observation is already active for this exact resource.",
      { code: "ATOMIC_MUTATION_PROGRAM_OBSERVER_ALREADY_ACTIVE" },
    );
  }
  ATOMIC_MUTATION_PROGRAM_DISPATCH_OBSERVERS.set(target, observer);
  try {
    return await run();
  } finally {
    ATOMIC_MUTATION_PROGRAM_DISPATCH_OBSERVERS.delete(target);
  }
}

const ATOMIC_MUTATION_PROGRAM_FAMILIES = [
  "createNodes",
  "createEdges",
  "deleteNodes",
  "deleteEdges",
  "updateNodes",
  "updateEdges",
  "mutateNodes",
  "mutateEdges",
] as const satisfies readonly (keyof AtomicMutationProgramRegistration)[];

function assertNonnegativeIntegerLimit(
  family: keyof AtomicMutationProgramRegistration,
  name: string,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return;
  }
  throw new ConfigurationError(
    `Atomic mutation program family ${family} requires a nonnegative integer ${name}.`,
    {
      code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
      family,
      limit: name,
      value,
    },
  );
}

function assertAtomicMutationProgramLimits(
  family: keyof AtomicMutationProgramRegistration,
  executor: AtomicMutationProgramRegistration[typeof family],
): void {
  if (executor === undefined) return;
  if (family === "createNodes") {
    assertAtomicNodeClaimSupport(
      family,
      (executor as AtomicNodeBatchExecutor).claimSupport,
    );
    return;
  }
  if (family === "deleteNodes") {
    const releasedClaimFamilies: unknown = (
      executor as AtomicNodeDeleteBatchExecutor
    ).releasedClaimFamilies;
    if (releasedClaimFamilies !== undefined) {
      assertAtomicNodeClaimFamilies(
        family,
        "releasedClaimFamilies",
        releasedClaimFamilies,
      );
    }
    return;
  }
  if (
    family === "updateNodes" ||
    family === "updateEdges" ||
    family === "mutateNodes"
  ) {
    assertNonnegativeIntegerLimit(
      family,
      "maxEntries",
      (executor as Readonly<{ maxEntries: unknown }>).maxEntries,
    );
    return;
  }
  if (family === "mutateEdges") {
    const limits: unknown = (executor as AtomicEdgeMutationProgramExecutor)
      .maxEntries;
    if (typeof limits !== "object" || limits === null) {
      throw new ConfigurationError(
        "Atomic mutation program family mutateEdges requires maxEntries limits.",
        {
          code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
          family,
          limit: "maxEntries",
          value: limits,
        },
      );
    }
    const edgeLimits = limits as Readonly<Record<PropertyKey, unknown>>;
    assertNonnegativeIntegerLimit(
      family,
      "maxEntries.resolvedSet",
      edgeLimits["resolvedSet"],
    );
    assertNonnegativeIntegerLimit(
      family,
      "maxEntries.durableConvergence",
      edgeLimits["durableConvergence"],
    );
  }
}

function normalizeAtomicMutationProgramRegistration(
  registration: AtomicMutationProgramRegistration,
): AtomicMutationProgramExecutor {
  const uncheckedRegistration: unknown = registration;
  if (
    typeof uncheckedRegistration !== "object" ||
    uncheckedRegistration === null
  ) {
    throw new ConfigurationError(
      "An atomic mutation program registration must be an object.",
      { code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH" },
    );
  }
  const entries: [
    keyof AtomicMutationProgramRegistration,
    NonNullable<
      AtomicMutationProgramRegistration[keyof AtomicMutationProgramRegistration]
    >,
  ][] = [];
  for (const family of ATOMIC_MUTATION_PROGRAM_FAMILIES) {
    const executor = registration[family];
    if (executor === undefined) continue;
    if (typeof executor !== "function") {
      throw new ConfigurationError(
        `Atomic mutation program family ${family} must be callable.`,
        {
          code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
          family,
        },
      );
    }
    assertAtomicMutationProgramLimits(family, executor);
    entries.push([family, executor]);
  }
  if (entries.length === 0) {
    throw new ConfigurationError(
      "An atomic mutation program registration must implement at least one semantic family.",
      { code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH" },
    );
  }
  return Object.freeze(
    Object.fromEntries(entries) as AtomicMutationProgramExecutor,
  );
}

function throwAtomicMutationProgramRegistrationMismatch(
  target: GraphBackend | TransactionBackend,
): never {
  throw new ConfigurationError(
    "Atomic mutation programs require an exact backend session with a registered atomic SQL transport.",
    {
      code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
      atomicBatch: target.capabilities.execution.atomicBatch,
      transportRegistered: hasAtomicSqlProgramRegistration(target),
    },
    {
      suggestion:
        "Register and validate the exact-session atomic SQL transport before registering only the TypeGraph mutation families this backend implements.",
    },
  );
}

/**
 * Registers TypeGraph semantic mutation programs for one exact backend resource.
 *
 * Transport registration proves atomic statement dispatch only. This second,
 * explicit profile declares which graph mutation families preserve their
 * complete schema-fence, validation, side-effect, refusal, and result-ordering
 * contracts. Object-identity registration prevents derived, projected, and
 * other transaction sessions from inheriting execution evidence.
 */
export function registerAtomicMutationPrograms<
  T extends GraphBackend | TransactionBackend,
>(target: T, registration: AtomicMutationProgramRegistration): T {
  if (
    !supportsAtomicBatch(target) ||
    !hasAtomicSqlProgramRegistration(target)
  ) {
    throwAtomicMutationProgramRegistrationMismatch(target);
  }
  if (ATOMIC_MUTATION_PROGRAM_EXECUTORS.has(target)) {
    throw new ConfigurationError(
      "Atomic mutation programs are already registered for this exact backend resource.",
      { code: "ATOMIC_MUTATION_PROGRAM_ALREADY_REGISTERED" },
    );
  }
  ATOMIC_MUTATION_PROGRAM_EXECUTORS.set(
    target,
    instrumentAtomicMutationProgramExecutors(
      target,
      normalizeAtomicMutationProgramRegistration(registration),
    ),
  );
  return target;
}

/** Returns whether this exact resource owns a semantic program profile. */
export function hasAtomicMutationProgramRegistration(
  target: GraphBackend | TransactionBackend,
): boolean {
  return ATOMIC_MUTATION_PROGRAM_EXECUTORS.has(target);
}

/** Resolves semantic mutation programs only for their exact registered resource. */
export function resolveAtomicMutationPrograms(
  target: GraphBackend | TransactionBackend,
): AtomicMutationProgramExecutor | undefined {
  return ATOMIC_MUTATION_PROGRAM_EXECUTORS.get(target);
}

/**
 * Re-registers exact-session evidence on a transparent transaction wrapper.
 *
 * Session authority is never inherited implicitly: the wrapper seam calls
 * this only after deriving a backend that forwards to the same pinned command
 * session. Root registrations remain non-transferable.
 *
 * @internal
 */
export function carryAtomicMutationSessionRegistration<
  T extends TransactionBackend,
>(base: TransactionBackend, derived: T): T {
  if (
    base.capabilities.execution.atomicBatch !== "session" ||
    derived.capabilities.execution.atomicBatch !== "session"
  ) {
    return derived;
  }
  const executeAtomicBatch = resolveRegisteredAtomicSqlBatchExecutor(base);
  const profile = resolveAtomicMutationPrograms(base);
  if (executeAtomicBatch === undefined || profile === undefined) return derived;
  registerAtomicSqlProgram(derived, executeAtomicBatch);
  registerAtomicMutationPrograms(derived, profile);
  return derived;
}

/**
 * @internal Test-only compatibility seam.
 *
 * Production factories must use registerAtomicMutationPrograms() so transport,
 * declaration, shape, and duplicate-registration validation cannot be skipped.
 */
export function markBundledRootAtomicMutationPrograms<T extends object>(
  target: T,
  executor: Readonly<{
    createNodes?: AtomicNodeBatchExecutor | undefined;
    createEdges?: AtomicEdgeBatchExecutor | undefined;
    deleteNodes?: AtomicNodeDeleteBatchExecutor | undefined;
    deleteEdges?: AtomicEdgeDeleteBatchExecutor | undefined;
    updateNodes?: AtomicNodeResolvedUpdateBatchExecutor | undefined;
    updateEdges?: AtomicEdgeResolvedUpdateBatchExecutor | undefined;
    mutateNodes?: AtomicNodeResolvedMutationSetExecutor | undefined;
    mutateEdges?: AtomicEdgeMutationProgramExecutor | undefined;
  }>,
): T {
  ATOMIC_MUTATION_PROGRAM_EXECUTORS.set(
    target,
    instrumentAtomicMutationProgramExecutors(target, executor),
  );
  return target;
}

/** @internal Compatibility seam for bundled-factory and backend tests. */
export function resolveBundledRootAtomicMutationPrograms(
  target: GraphBackend | TransactionBackend,
): AtomicMutationProgramExecutor | undefined {
  return resolveAtomicMutationPrograms(target);
}

/** @internal Narrow test seam over the single mutation-program registry. */
export function markBundledRootAtomicNodeBatch<T extends object>(
  target: T,
  executor: AtomicNodeBatchExecutor,
): T {
  const existing = ATOMIC_MUTATION_PROGRAM_EXECUTORS.get(target);
  return markBundledRootAtomicMutationPrograms(target, {
    ...existing,
    createNodes: executor,
  });
}

/** @internal Narrow test seam over the single mutation-program registry. */
export function markBundledRootAtomicEdgeBatch<T extends object>(
  target: T,
  executor: AtomicEdgeBatchExecutor,
): T {
  const existing = ATOMIC_MUTATION_PROGRAM_EXECUTORS.get(target);
  return markBundledRootAtomicMutationPrograms(target, {
    ...existing,
    createEdges: executor,
  });
}

/** @internal Narrow test seam over the single mutation-program registry. */
export function resolveBundledRootAtomicNodeBatch(
  target: GraphBackend | TransactionBackend,
): AtomicNodeBatchExecutor | undefined {
  return resolveAtomicMutationPrograms(target)?.createNodes;
}

/** @internal Narrow test seam over the single mutation-program registry. */
export function resolveBundledRootAtomicEdgeBatch(
  target: GraphBackend | TransactionBackend,
): AtomicEdgeBatchExecutor | undefined {
  return resolveAtomicMutationPrograms(target)?.createEdges;
}
