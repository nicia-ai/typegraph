/**
 * Exact-root execution profile for closed semantic mutation programs.
 *
 * The transport-level atomic SQL executor answers only "can this exact root
 * submit a closed statement sequence atomically?" This profile is the next
 * layer up: it names the TypeGraph mutations the backend can lower onto that
 * transport. Keeping every mutation family in one exact-root registration
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
import { supportsRootAtomicBatch } from "../types";
import { hasAtomicSqlProgramRegistration } from "./atomic-sql-program";

/** How a node batch member obtained the identifier stored by its program. */
export type AtomicNodeBatchIdSource = "generated" | "caller";
/** Whether a node batch returns only its count or its ordered postimages. */
export type AtomicNodeBatchResultMode = "count" | "rows";

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
  /** Maximum constrained members the backend can gate in one statement. */
  readonly maxClaimedEntries?: number;
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
export type AtomicNodeDeleteBatchExecutor = (
  input: AtomicNodeDeleteBatchInput,
) => Promise<AtomicDeleteBatchResult>;

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

const ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS = new WeakMap<
  object,
  AtomicMutationProgramExecutor
>();

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
    const maxClaimedEntries = (executor as AtomicNodeBatchExecutor)
      .maxClaimedEntries;
    if (maxClaimedEntries !== undefined) {
      assertNonnegativeIntegerLimit(
        family,
        "maxClaimedEntries",
        maxClaimedEntries,
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
  target: GraphBackend,
): never {
  throw new ConfigurationError(
    "Atomic mutation programs require an exact root backend with a registered atomic SQL transport.",
    {
      code: "ATOMIC_MUTATION_PROGRAM_REGISTRATION_MISMATCH",
      atomicBatch: target.capabilities.execution.atomicBatch,
      transportRegistered: hasAtomicSqlProgramRegistration(target),
    },
    {
      suggestion:
        "Register and validate the root atomic SQL transport before registering only the TypeGraph mutation families this backend implements.",
    },
  );
}

/**
 * Registers TypeGraph semantic mutation programs for one exact backend root.
 *
 * Transport registration proves atomic statement dispatch only. This second,
 * explicit profile declares which graph mutation families preserve their
 * complete schema-fence, validation, side-effect, refusal, and result-ordering
 * contracts. Object-identity registration prevents derived, projected, and
 * transaction-scoped backends from inheriting root execution evidence.
 */
export function registerAtomicMutationPrograms<T extends GraphBackend>(
  target: T,
  registration: AtomicMutationProgramRegistration,
): T {
  if (
    !supportsRootAtomicBatch(target) ||
    !hasAtomicSqlProgramRegistration(target)
  ) {
    throwAtomicMutationProgramRegistrationMismatch(target);
  }
  if (ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.has(target)) {
    throw new ConfigurationError(
      "Atomic mutation programs are already registered for this exact backend root.",
      { code: "ATOMIC_MUTATION_PROGRAM_ALREADY_REGISTERED" },
    );
  }
  ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.set(
    target,
    normalizeAtomicMutationProgramRegistration(registration),
  );
  return target;
}

/** Returns whether this exact root owns a semantic program profile. */
export function hasAtomicMutationProgramRegistration(
  target: GraphBackend | TransactionBackend,
): boolean {
  return ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.has(target);
}

/** Resolves semantic mutation programs only for their exact registered root. */
export function resolveAtomicMutationPrograms(
  target: GraphBackend | TransactionBackend,
): AtomicMutationProgramExecutor | undefined {
  return ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.get(target);
}

/** @internal Called only by bundled root backend factories. */
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
  ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.set(target, {
    ...(executor.createNodes === undefined ?
      {}
    : {
        createNodes: executor.createNodes,
      }),
    ...(executor.createEdges === undefined ?
      {}
    : {
        createEdges: executor.createEdges,
      }),
    ...(executor.deleteNodes === undefined ?
      {}
    : {
        deleteNodes: executor.deleteNodes,
      }),
    ...(executor.deleteEdges === undefined ?
      {}
    : {
        deleteEdges: executor.deleteEdges,
      }),
    ...(executor.updateNodes === undefined ?
      {}
    : { updateNodes: executor.updateNodes }),
    ...(executor.updateEdges === undefined ?
      {}
    : { updateEdges: executor.updateEdges }),
    ...(executor.mutateNodes === undefined ?
      {}
    : { mutateNodes: executor.mutateNodes }),
    ...(executor.mutateEdges === undefined ?
      {}
    : { mutateEdges: executor.mutateEdges }),
  });
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
  const existing = ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.get(target);
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
  const existing = ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.get(target);
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
