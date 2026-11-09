import { z } from "zod";

import {
  type EdgeRow,
  type LineageDelta,
  type NodeRow,
} from "../backend/types";
import {
  type EdgeKinds,
  type GraphDef,
  type NodeKinds,
} from "../core/define-graph";
import { assertJsonValue } from "../core/json-value";
import { type JsonValue } from "../core/types";
import { ValidationError } from "../errors";
import {
  groupNodeUniquenessProbes,
  nodeClaimEntries,
} from "../store/claims/node-claims";
import {
  assertEdgeIdentityMatches,
  edgeIdentityFromRow,
} from "../store/operations/edge-identity";
import { type ValidityEndMutation } from "../store/types";
import { isCanonicalIsoDate, isInvertedValidityWindow } from "../utils/date";
import { createDataKeyedBag } from "../utils/object";
import { requireDefined } from "../utils/presence";
import { branch } from "./branch";
import {
  type CandidateWriteSet,
  captureCandidateWriteSetTarget,
} from "./candidate-write-set";
import { parseRowProps } from "./canonical-props";
import {
  CandidateWriteSetError,
  MergeError,
  MergePlanCapabilityError,
} from "./errors";
import {
  assertPlanningFenceUnchanged,
  assertStableMergePostimage,
  captureMergePlanTargetFence,
  planMergeIncrementalWithCandidateKeys,
} from "./merge";
import { finalizeMergePlanArtifact } from "./plan-canonical";
import {
  type MergePlanArtifact,
  type MergePlanEntityRef,
  type MergePlanTargetFence,
  mergePlanTargetFenceSchema,
} from "./plan-schema";
import { type PlanningScope, resolvePlanningScope } from "./planning-scope";
import { err, isErr, type Result } from "./result";
import {
  canUseSparseCandidatePlanning,
  matchIdentityOwnerReader,
  matchIdentityOwnersAreCloneVisible,
  sparseCandidateWorkingCopyStrategy,
} from "./sparse-candidate-branch";
import { type Store, storeBackend } from "./typegraph-internal";
import { asBranchId, type GraphBranch } from "./types";
import { cloneWorkingCopyStrategy, type MakeBackend } from "./working-copy";

export type MutationCreateOptions = Readonly<{
  validFrom?: string | null | undefined;
  validTo?: string | undefined;
}>;
type Step = Readonly<{
  entity: "node" | "edge";
  kind: string;
  id: string;
  deletion: boolean;
  creation?: boolean;
  endpoints?: Readonly<{ from: MergePlanEntityRef; to: MergePlanEntityRef }>;
  operation: MutationOperation;
}>;
type NodeWriter = Readonly<{
  create: (
    props: unknown,
    options: MutationCreateOptions & Readonly<{ id: string }>,
  ) => Promise<unknown>;
  update: (
    id: string,
    props: unknown,
    options?: ValidityEndMutation,
  ) => Promise<unknown>;
  bulkReplaceById: (
    items: readonly Readonly<{ id: string; props: unknown }>[],
  ) => Promise<unknown>;
  delete: (id: string) => Promise<void>;
}>;
type EdgeWriter = Readonly<{
  create: (
    from: MergePlanEntityRef,
    to: MergePlanEntityRef,
    props: unknown,
    options: MutationCreateOptions & Readonly<{ id: string }>,
  ) => Promise<unknown>;
  update: (
    id: string,
    props: unknown,
    options?: ValidityEndMutation,
  ) => Promise<unknown>;
  delete: (id: string) => Promise<void>;
}>;

/** Ordered ordinary collection operations, compiled to a native merge artifact. */
export type MutationPlanBuilder<G extends GraphDef> = Readonly<{
  target: MergePlanTargetFence;
  operationCount: number;
  /** JSON-safe authoring input, including its original target fence. */
  document: MutationDocument;
  createNode: <K extends NodeKinds<G>>(
    kind: K,
    id: string,
    props: z.input<G["nodes"][K]["type"]["schema"]>,
    options?: MutationCreateOptions,
  ) => MutationPlanBuilder<G>;
  updateNode: <K extends NodeKinds<G>>(
    kind: K,
    id: string,
    props: Partial<z.input<G["nodes"][K]["type"]["schema"]>>,
    options?: ValidityEndMutation,
  ) => MutationPlanBuilder<G>;
  replaceNode: <K extends NodeKinds<G>>(
    kind: K,
    id: string,
    props: z.input<G["nodes"][K]["type"]["schema"]>,
  ) => MutationPlanBuilder<G>;
  deleteNode: <K extends NodeKinds<G>>(
    kind: K,
    id: string,
  ) => MutationPlanBuilder<G>;
  createEdge: <K extends EdgeKinds<G>>(
    kind: K,
    id: string,
    from: Parameters<Store<G>["edges"][K]["create"]>[0],
    to: Parameters<Store<G>["edges"][K]["create"]>[1],
    props: z.input<G["edges"][K]["type"]["schema"]>,
    options?: MutationCreateOptions,
  ) => MutationPlanBuilder<G>;
  updateEdge: <K extends EdgeKinds<G>>(
    kind: K,
    id: string,
    props: Partial<z.input<G["edges"][K]["type"]["schema"]>>,
    options?: ValidityEndMutation,
  ) => MutationPlanBuilder<G>;
  deleteEdge: <K extends EdgeKinds<G>>(
    kind: K,
    id: string,
  ) => MutationPlanBuilder<G>;
  plan: (
    options: MutationPlanningOptions,
  ) => Promise<Result<MergePlanArtifact, MergeError>>;
}>;

/** Reuse an externally reviewed base fence instead of silently choosing a newer base. */
export type MutationAuthoringOptions = Readonly<{
  expectedTarget?: MergePlanTargetFence;
}>;

/** Full cloning is opt-in; candidate mode refuses instead of hiding a scan. */
export type MutationPlanningOptions = Readonly<{
  makeBackend: MakeBackend;
  planningScope?: PlanningScope;
}>;

type Observation = Readonly<{
  nodes: readonly NodeRow[];
  edges: readonly EdgeRow[];
  keys: LineageDelta;
}>;

function nodeWriter<G extends GraphDef>(
  store: Store<G>,
  kind: string,
): NodeWriter {
  return requireDefined(
    (store.nodes as unknown as Readonly<Record<string, NodeWriter>>)[kind],
  );
}
function edgeWriter<G extends GraphDef>(
  store: Store<G>,
  kind: string,
): EdgeWriter {
  return requireDefined(
    (store.edges as unknown as Readonly<Record<string, EdgeWriter>>)[kind],
  );
}

/** Capture the base when authoring begins, so planning cannot silently rebase. */
export async function createMutationPlanBuilder<G extends GraphDef>(
  target: Store<G>,
  sourceId: string,
  options: MutationAuthoringOptions = {},
): Promise<MutationPlanBuilder<G>> {
  if (typeof sourceId !== "string" || sourceId.length === 0)
    throw new ValidationError("Mutation source id must not be empty.", {
      issues: [{ path: "sourceId", message: "Expected a nonempty source id." }],
    });
  const parsed = z
    .object({ expectedTarget: mergePlanTargetFenceSchema.optional() })
    .strict()
    .safeParse(options);
  if (!parsed.success)
    throw new ValidationError("Invalid mutation authoring options.", {
      issues: [{ path: "options", message: parsed.error.message }],
    });
  const fence =
    parsed.data.expectedTarget ?? (await captureMergePlanTargetFence(target));
  await assertPlanningFenceUnchanged(target, fence);
  return mutationBuilder(target, sourceId, fence, []);
}

/** Serializable operations use explicit property removal rather than JSON's missing undefined. */
export type MutationOperation = Readonly<{
  kind: string;
  id: string;
}> &
  (
    | Readonly<{
        op: "node.create";
        props: Readonly<Record<string, JsonValue>>;
        options?: MutationCreateOptions | undefined;
        unsetProps?: never;
        from?: never;
        to?: never;
      }>
    | Readonly<{
        op: "edge.create";
        props: Readonly<Record<string, JsonValue>>;
        options?: MutationCreateOptions | undefined;
        from: MergePlanEntityRef;
        to: MergePlanEntityRef;
        unsetProps?: never;
      }>
    | Readonly<{
        op: "node.update" | "edge.update";
        props: Readonly<Record<string, JsonValue>>;
        unsetProps?: readonly string[] | undefined;
        options?: ValidityEndMutation | undefined;
        from?: never;
        to?: never;
      }>
    | Readonly<{
        op: "node.replace";
        props: Readonly<Record<string, JsonValue>>;
        options?: never;
        unsetProps?: never;
        from?: never;
        to?: never;
      }>
    | Readonly<{
        op: "node.delete" | "edge.delete";
        props?: never;
        options?: never;
        unsetProps?: never;
        from?: never;
        to?: never;
      }>
  );
/** Current JSON mutation document version. */
export const MUTATION_DOCUMENT_FORMAT_VERSION = 1 as const;

export type MutationDocument = Readonly<{
  formatVersion: typeof MUTATION_DOCUMENT_FORMAT_VERSION;
  sourceId: string;
  target: MergePlanTargetFence;
  operations: readonly MutationOperation[];
}>;

const mutationReferenceSchema = z
  .object({ kind: z.string().min(1), id: z.string().min(1) })
  .strict();
const mutationPropsSchema = z.record(z.string(), z.json());
const mutationInstantSchema = z
  .string()
  .refine((value) => isCanonicalIsoDate(value), {
    message: "Expected canonical UTC ISO 8601 with fixed milliseconds.",
  });
const mutationCreateSchema = z
  .object({
    validFrom: mutationInstantSchema.nullable().optional(),
    validTo: mutationInstantSchema.optional(),
  })
  .strict();
const mutationUpdateSchema = z.union([
  z
    .object({ validTo: mutationInstantSchema.optional() })
    .strict()
    .transform(({ validTo }) => (validTo === undefined ? {} : { validTo })),
  z.object({ clearValidTo: z.literal(true) }).strict(),
]);
const mutationBaseSchema = z
  .object({ kind: z.string().min(1), id: z.string().min(1) })
  .strict();
const mutationOperationSchema = z.discriminatedUnion("op", [
  mutationBaseSchema.extend({
    op: z.literal("node.create"),
    props: mutationPropsSchema,
    options: mutationCreateSchema.optional(),
  }),
  mutationBaseSchema.extend({
    op: z.literal("edge.create"),
    props: mutationPropsSchema,
    options: mutationCreateSchema.optional(),
    from: mutationReferenceSchema,
    to: mutationReferenceSchema,
  }),
  mutationBaseSchema.extend({
    op: z.literal("node.update"),
    props: mutationPropsSchema,
    unsetProps: z.array(z.string()).optional(),
    options: mutationUpdateSchema.optional(),
  }),
  mutationBaseSchema.extend({
    op: z.literal("edge.update"),
    props: mutationPropsSchema,
    unsetProps: z.array(z.string()).optional(),
    options: mutationUpdateSchema.optional(),
  }),
  mutationBaseSchema.extend({
    op: z.literal("node.replace"),
    props: mutationPropsSchema,
  }),
  mutationBaseSchema.extend({ op: z.literal("node.delete") }),
  mutationBaseSchema.extend({ op: z.literal("edge.delete") }),
]);
export const MutationDocumentSchema = z
  .object({
    formatVersion: z.literal(MUTATION_DOCUMENT_FORMAT_VERSION),
    sourceId: z.string().min(1),
    target: mergePlanTargetFenceSchema,
    operations: z.array(mutationOperationSchema),
  })
  .strict()
  .superRefine((document, context) => {
    for (const [index, operation] of document.operations.entries()) {
      if (
        (operation.op === "node.create" || operation.op === "edge.create") &&
        operation.options !== undefined &&
        typeof operation.options.validFrom === "string" &&
        operation.options.validTo !== undefined &&
        isCanonicalIsoDate(operation.options.validFrom) &&
        isCanonicalIsoDate(operation.options.validTo) &&
        isInvertedValidityWindow(
          operation.options.validFrom,
          operation.options.validTo,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["operations", index, "options", "validTo"],
          message: "validTo must be at or after validFrom.",
        });
      const unset =
        "unsetProps" in operation ? (operation.unsetProps ?? []) : [];
      if (
        new Set(unset).size !== unset.length ||
        unset.some((key) =>
          Object.hasOwn("props" in operation ? operation.props : {}, key),
        )
      )
        context.addIssue({
          code: "custom",
          path: ["operations", index, "unsetProps"],
          message:
            "Mutation property sets and removals must be disjoint and duplicate-free.",
        });
    }
  });

function jsonMutationProps(props: unknown): Record<string, JsonValue> {
  // Match persisted JSON: Dates become ISO strings, optional object properties disappear.
  // Reject other non-JSON values rather than allowing stringify to silently discard them.
  const seen = new WeakSet<object>();
  function convert(value: unknown): JsonValue {
    if (value instanceof Date) return value.toISOString();
    if (value !== null && typeof value === "object") {
      if (seen.has(value))
        throw new ValidationError(
          "Mutation properties must not contain cycles.",
          { issues: [] },
        );
      seen.add(value);
      try {
        if (Array.isArray(value)) return value.map((item) => convert(item));
        if (
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null
        )
          throw new ValidationError("Mutation properties must be JSON data.", {
            issues: [],
          });
        return Object.fromEntries(
          Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .map(([key, entry]) => [key, convert(entry)]),
        );
      } finally {
        seen.delete(value);
      }
    }
    assertJsonValue(value, "props", "Mutation document");
    return value as JsonValue;
  }
  const converted = convert(props);
  if (
    converted === null ||
    typeof converted !== "object" ||
    Array.isArray(converted)
  )
    throw new ValidationError("Mutation properties must be an object.", {
      issues: [],
    });
  return mutationPropsSchema.parse(converted);
}

function operationStep(operation: MutationOperation): Step {
  return {
    entity: operation.op.startsWith("node.") ? "node" : "edge",
    kind: operation.kind,
    id: operation.id,
    deletion: operation.op.endsWith(".delete"),
    creation: operation.op.endsWith(".create"),
    ...(operation.from === undefined ?
      {}
    : { endpoints: { from: operation.from, to: operation.to } }),
    operation,
  };
}

async function executeMutation<G extends GraphDef>(
  store: Store<G>,
  operation: MutationOperation,
): Promise<void> {
  const props = createDataKeyedBag<unknown>();
  for (const [key, value] of Object.entries(operation.props ?? {}))
    props[key] = value;
  for (const key of operation.unsetProps ?? []) props[key] = undefined;
  const writer =
    operation.op.startsWith("node.") ?
      nodeWriter(store, operation.kind)
    : edgeWriter(store, operation.kind);
  switch (operation.op) {
    case "node.create": {
      await nodeWriter(store, operation.kind).create(props, {
        ...operation.options,
        id: operation.id,
      });
      break;
    }
    case "edge.create": {
      await edgeWriter(store, operation.kind).create(
        requireDefined(operation.from),
        requireDefined(operation.to),
        props,
        { ...operation.options, id: operation.id },
      );
      break;
    }
    case "node.update":
    case "edge.update": {
      const window = mutationUpdateSchema.parse(operation.options ?? {});
      await writer.update(
        operation.id,
        props,
        "clearValidTo" in window ? { clearValidTo: true }
        : window.validTo === undefined ? {}
        : { validTo: window.validTo },
      );
      break;
    }
    case "node.replace": {
      await nodeWriter(store, operation.kind).bulkReplaceById([
        { id: operation.id, props },
      ]);
      break;
    }
    case "node.delete":
    case "edge.delete": {
      await writer.delete(operation.id);
      break;
    }
  }
}

function mutationBuilder<G extends GraphDef>(
  target: Store<G>,
  sourceId: string,
  fence: MergePlanTargetFence,
  steps: readonly Step[],
): MutationPlanBuilder<G> {
  function append(operation: MutationOperation): MutationPlanBuilder<G> {
    const kinds =
      operation.op.startsWith("node.") ?
        target.graph.nodes
      : target.graph.edges;
    if (!Object.hasOwn(kinds, operation.kind) || operation.id.length === 0)
      throw new ValidationError(
        "Mutation requires a registered kind and nonempty id.",
        { issues: [] },
      );
    return mutationBuilder(target, sourceId, fence, [
      ...steps,
      operationStep(structuredClone(operation)),
    ]);
  }
  function document(): MutationDocument {
    return structuredClone({
      formatVersion: MUTATION_DOCUMENT_FORMAT_VERSION,
      sourceId,
      target: fence,
      operations: steps.map((step) => step.operation),
    });
  }
  function patch(
    op: "node.update" | "edge.update",
    kind: string,
    id: string,
    props: unknown,
    options?: ValidityEndMutation,
  ) {
    return append({
      op,
      kind,
      id,
      props: jsonMutationProps(props),
      unsetProps: Object.entries(props as Record<string, unknown>)
        .filter(([, value]) => value === undefined)
        .map(([key]) => key),
      ...(options === undefined ? {} : { options }),
    });
  }
  return Object.freeze({
    get target() {
      return structuredClone(fence);
    },
    get document() {
      return document();
    },
    operationCount: steps.length,
    createNode: (kind, id, props, options) =>
      append({
        op: "node.create",
        kind,
        id,
        props: jsonMutationProps(props),
        ...(options === undefined ? {} : { options }),
      }),
    updateNode: (kind, id, props, options) =>
      patch("node.update", kind, id, props, options),
    replaceNode: (kind, id, props) =>
      append({ op: "node.replace", kind, id, props: jsonMutationProps(props) }),
    deleteNode: (kind, id) => append({ op: "node.delete", kind, id }),
    createEdge: (kind, id, from, to, props, options) =>
      append({
        op: "edge.create",
        kind,
        id,
        from: { kind: from.kind, id: from.id },
        to: { kind: to.kind, id: to.id },
        props: jsonMutationProps(props),
        ...(options === undefined ? {} : { options }),
      }),
    updateEdge: (kind, id, props, options) =>
      patch("edge.update", kind, id, props, options),
    deleteEdge: (kind, id) => append({ op: "edge.delete", kind, id }),
    plan: (options) =>
      planMutations({
        makeBackend: options.makeBackend,
        ...(options.planningScope === undefined ?
          {}
        : { planningScope: options.planningScope }),
        target,
        mutations: document(),
      }),
  } satisfies MutationPlanBuilder<G>);
}

/** Validate persisted mutation input and reuse the native planner and applier. */
export async function planMutations<G extends GraphDef>(
  args: MutationPlanningOptions &
    Readonly<{ target: Store<G>; mutations: unknown }>,
): Promise<Result<MergePlanArtifact, MergeError>> {
  try {
    const document = MutationDocumentSchema.parse(
      structuredClone(args.mutations),
    );
    for (const [index, operation] of document.operations.entries()) {
      const kinds =
        operation.op.startsWith("node.") ?
          args.target.graph.nodes
        : args.target.graph.edges;
      if (!Object.hasOwn(kinds, operation.kind))
        throw new CandidateWriteSetError("Unknown mutation kind.", {
          details: { operationIndex: index, operation },
        });
    }
    return await planMutationSteps(
      args.target,
      document.sourceId,
      document.target,
      document.operations.map((operation) => operationStep(operation)),
      args,
    );
  } catch (error) {
    return err(
      error instanceof MergeError ? error : (
        new CandidateWriteSetError("Invalid mutation document.", {
          cause: error,
        })
      ),
    );
  }
}

function mutationOperationFailure(
  index: number,
  operation: MutationOperation,
  cause: unknown,
): CandidateWriteSetError {
  return new CandidateWriteSetError(
    `Mutation operation ${index} (${operation.op}) failed.`,
    {
      cause,
      details: {
        operationIndex: index,
        operation,
        collectionErrorName: cause instanceof Error ? cause.name : undefined,
      },
    },
  );
}

async function observe<G extends GraphDef>(
  candidate: GraphBranch<G>,
  steps: readonly Step[],
): Promise<Observation> {
  const backend = storeBackend(candidate.store);
  const baseline = requireDefined(
    await candidate.store.lineageRevisionNow(),
    "Mutation staging requires changed-key lineage.",
  );
  const nodes: NodeRow[] = [];
  const edges: EdgeRow[] = [];
  let previous = baseline;
  for (const [index, step] of steps.entries()) {
    try {
      await executeMutation(candidate.store, step.operation);
    } catch (error) {
      throw mutationOperationFailure(index, step.operation, error);
    }
    const delta = await candidate.store.changesSince(previous);
    if (delta.kind !== "keys")
      throw new MergePlanCapabilityError(
        "Mutation staging did not produce complete changed keys.",
        { details: { capability: "completeChangedKeys" } },
      );
    for (const ref of delta.nodes) {
      const row = await backend.getNode(
        candidate.store.graphId,
        ref.kind,
        ref.id,
      );
      if (row !== undefined && row.deleted_at === undefined) nodes.push(row);
    }
    for (const ref of delta.edges) {
      const row = await backend.getEdge(candidate.store.graphId, ref.id);
      if (row !== undefined && row.deleted_at === undefined) edges.push(row);
    }
    previous = requireDefined(await candidate.store.lineageRevisionNow());
  }
  return { nodes, edges, keys: await candidate.store.changesSince(baseline) };
}

async function validateFinalPostimages<G extends GraphDef>(
  candidate: GraphBranch<G>,
  keys: LineageDelta,
): Promise<void> {
  if (keys.kind !== "keys")
    throw new MergePlanCapabilityError(
      "Mutation staging requires complete final changed keys.",
      { details: { capability: "completeChangedKeys" } },
    );
  const backend = storeBackend(candidate.store);
  for (const ref of keys.nodes) {
    const row = await backend.getNode(
      candidate.store.graphId,
      ref.kind,
      ref.id,
    );
    if (row !== undefined && row.deleted_at === undefined)
      assertStableMergePostimage(
        candidate.store.graph.nodes[ref.kind]?.type.schema,
        parseRowProps(row.props),
      );
  }
  for (const ref of keys.edges) {
    const row = await backend.getEdge(candidate.store.graphId, ref.id);
    if (row !== undefined && row.deleted_at === undefined)
      assertStableMergePostimage(
        candidate.store.graph.edges[ref.kind]?.type.schema,
        parseRowProps(row.props),
      );
  }
}

function observationsAsCandidates(
  writeSet: CandidateWriteSet,
  observation: Observation,
): CandidateWriteSet {
  return {
    ...writeSet,
    nodes: [
      ...writeSet.nodes,
      ...observation.nodes.map((row) => ({
        kind: row.kind,
        id: row.id,
        properties: {},
        validFrom: null,
      })),
    ],
    edges: [
      ...writeSet.edges,
      ...observation.edges.map((row) => ({
        kind: row.kind,
        id: row.id,
        properties: {},
        validFrom: null,
        from: { kind: row.from_kind, id: row.from_id },
        to: { kind: row.to_kind, id: row.to_id },
      })),
    ],
  };
}

function uniquenessProbes<G extends GraphDef>(
  target: Store<G>,
  nodes: readonly NodeRow[],
) {
  return groupNodeUniquenessProbes(
    target.registry,
    nodes.map((row) => ({
      kind: row.kind,
      entries: nodeClaimEntries(
        target.registry,
        row.kind,
        row.id,
        parseRowProps(row.props),
        target.graph.nodes[row.kind]?.unique ?? [],
        "create",
      ),
    })),
  );
}

async function planMutationSteps<G extends GraphDef>(
  target: Store<G>,
  sourceId: string,
  fence: MergePlanTargetFence,
  steps: readonly Step[],
  options: MutationPlanningOptions,
): Promise<Result<MergePlanArtifact, MergeError>> {
  try {
    const scope = resolvePlanningScope(options.planningScope);
    if (isErr(scope)) throw scope.error;
    await assertPlanningFenceUnchanged(target, fence);
    const bounded = scope.data === "candidate";
    if (bounded && !canUseSparseCandidatePlanning(target))
      throw new MergePlanCapabilityError(
        "This graph cannot be mutation-planned with bounded candidate reads. Explicitly select full planning to permit a complete clone.",
        {
          details: {
            capability: "boundedCandidatePlanning",
            planningScope: "full",
          },
        },
      );
    const backend = storeBackend(target);
    const edgeRows: EdgeRow[] = [];
    const writeSet: CandidateWriteSet = {
      formatVersion: 1,
      sourceId,
      target: await captureCandidateWriteSetTarget(target),
      nodes: [],
      edges: [],
    };
    for (const [index, step] of steps.entries()) {
      try {
        if (step.entity === "node") {
          writeSet.nodes.push({
            kind: step.kind,
            id: step.id,
            properties: {},
            validFrom: null,
          });
          if (step.deletion)
            edgeRows.push(
              ...(await backend.findEdgesConnectedTo({
                graphId: target.graphId,
                nodeKind: step.kind,
                nodeId: step.id,
              })),
            );
        } else {
          const existing = await backend.getEdge(target.graphId, step.id);
          // Tombstones are absent from staging but still own their edge kind.
          if (step.deletion && existing !== undefined)
            assertEdgeIdentityMatches(
              step.id,
              { kind: step.kind },
              edgeIdentityFromRow(existing),
              "delete",
            );
          if (step.creation === true && existing?.deleted_at !== undefined) {
            throw new CandidateWriteSetError(
              "An edge create cannot reuse a soft-deleted edge identifier.",
              { details: { kind: step.kind, id: step.id } },
            );
          }
          const endpoints =
            step.endpoints ??
            (existing === undefined ? undefined : (
              {
                from: { kind: existing.from_kind, id: existing.from_id },
                to: { kind: existing.to_kind, id: existing.to_id },
              }
            ));
          if (endpoints !== undefined)
            writeSet.edges.push({
              kind: step.kind,
              id: step.id,
              properties: {},
              validFrom: null,
              ...endpoints,
            });
        }
      } catch (error) {
        throw mutationOperationFailure(index, step.operation, error);
      }
    }
    async function createStaging(
      document: CandidateWriteSet,
      strict: boolean,
      additionalNodes: readonly MergePlanEntityRef[] = [],
    ) {
      const sparse = sparseCandidateWorkingCopyStrategy<G>(
        document,
        options.makeBackend,
        edgeRows,
        {
          preserveNodeUniqueness: strict,
          captureChanges: true,
          additionalNodes,
        },
      );
      const created = await branch<G>(
        target,
        options.makeBackend,
        { id: asBranchId(sourceId) },
        bounded ?
          sparse.strategy
        : cloneWorkingCopyStrategy<G>(options.makeBackend, {
            refreshStatistics: false,
          }),
      );
      if (isErr(created)) throw created.error;
      return { candidate: created.data, scope: sparse.identityScope };
    }
    async function probeMutations(): Promise<Observation> {
      const probe = await createStaging(writeSet, false);
      try {
        return await observe(probe.candidate, steps);
      } finally {
        await probe.candidate.close();
      }
    }
    const observation: Observation =
      bounded ?
        await probeMutations()
      : { nodes: [], edges: [], keys: { kind: "keys", nodes: [], edges: [] } };
    const probes = uniquenessProbes(target, observation.nodes);
    const additionalNodes: MergePlanEntityRef[] = [];
    for (const group of probes)
      for (const key of group.keys) {
        const owner = await backend.checkUnique({
          graphId: target.graphId,
          nodeKind: group.nodeKind,
          constraintName: group.constraintName,
          key,
        });
        if (owner !== undefined)
          additionalNodes.push({
            kind: owner.concrete_kind,
            id: owner.node_id,
          });
      }
    for (const row of observation.edges) {
      if (
        row.match_identity_name === undefined ||
        row.match_identity_key === undefined
      )
        continue;
      const readOwners = matchIdentityOwnerReader(target);
      if (readOwners === undefined)
        throw new MergePlanCapabilityError(
          "Mutation planning requires exact durable edge identity reads.",
          { details: { capability: "durableEdgeIdentityReads" } },
        );
      const owners = await readOwners([
        {
          kind: row.kind,
          name: row.match_identity_name,
          key: row.match_identity_key,
        },
      ]);
      if (!matchIdentityOwnersAreCloneVisible(owners))
        throw new MergePlanCapabilityError(
          "A tombstoned durable edge owner cannot be mutation-planned through a live-state working copy.",
          { details: { capability: "liveDurableEdgeOwner" } },
        );
      edgeRows.push(...owners);
    }
    const seeded = observationsAsCandidates(writeSet, observation);
    const strict = await createStaging(seeded, true, additionalNodes);
    try {
      const verified = await observe(strict.candidate, steps);
      await validateFinalPostimages(strict.candidate, verified.keys);
      // Staging twice must not discover unseeded claims from nondeterministic parsers.
      const expected = new Set(
        probes.flatMap((group) =>
          group.keys.map((key) =>
            JSON.stringify([group.nodeKind, group.constraintName, key]),
          ),
        ),
      );
      if (bounded) {
        for (const group of uniquenessProbes(target, verified.nodes))
          for (const key of group.keys)
            if (
              !expected.has(
                JSON.stringify([group.nodeKind, group.constraintName, key]),
              )
            )
              throw new MergePlanCapabilityError(
                "Mutation validation produced a different uniqueness key on replay.",
                { details: { capability: "stableMutationPostimage" } },
              );
      }
      const expectedEdgeKeys = new Set(
        observation.edges
          .filter((row) => row.match_identity_name !== undefined)
          .map((row) =>
            JSON.stringify([
              row.kind,
              row.match_identity_name,
              row.match_identity_key,
            ]),
          ),
      );
      for (const row of verified.edges) {
        if (
          row.match_identity_name === undefined ||
          row.match_identity_key === undefined
        )
          continue;
        if (
          bounded &&
          !expectedEdgeKeys.has(
            JSON.stringify([
              row.kind,
              row.match_identity_name,
              row.match_identity_key,
            ]),
          )
        )
          throw new MergePlanCapabilityError(
            "Mutation validation produced a different durable edge key on replay.",
            { details: { capability: "stableMutationPostimage" } },
          );
        if (!bounded) {
          const readOwners = matchIdentityOwnerReader(target);
          if (readOwners === undefined)
            throw new MergePlanCapabilityError(
              "Mutation planning requires exact durable edge identity reads.",
              { details: { capability: "durableEdgeIdentityReads" } },
            );
          const owners = await readOwners([
            {
              kind: row.kind,
              name: row.match_identity_name,
              key: row.match_identity_key,
            },
          ]);
          if (!matchIdentityOwnersAreCloneVisible(owners))
            throw new MergePlanCapabilityError(
              "A tombstoned durable edge owner is excluded from a live-state working copy.",
              { details: { capability: "liveDurableEdgeOwner" } },
            );
        }
      }
      const planned = await planMergeIncrementalWithCandidateKeys<G>(
        { forkPoint: target, target, branches: [strict.candidate] },
        verified.keys,
        strict.scope(),
      );
      await assertPlanningFenceUnchanged(target, fence);
      if (isErr(planned)) return planned;
      // A delete/create sequence is a replacement, even when the original was live
      // and its properties happen to be unchanged. Derive guards from final writes.
      const created = new Map<string, MergePlanEntityRef>();
      const recreated = new Set<string>();
      const deletedDuring = new Set<string>();
      for (const step of steps) {
        if (step.entity !== "node") continue;
        const key = JSON.stringify([step.kind, step.id]);
        if (step.creation || step.operation.op === "node.replace") {
          created.set(key, { kind: step.kind, id: step.id });
          if (step.creation || deletedDuring.has(key)) recreated.add(key);
        }
        if (step.deletion) {
          created.delete(key);
          recreated.delete(key);
          deletedDuring.add(key);
        }
      }
      const nodeUpserts = new Map(
        planned.data.writes.nodeUpserts.map((upsert) => [
          JSON.stringify([upsert.kind, upsert.id]),
          upsert,
        ]),
      );
      const nodeResurrections: MergePlanEntityRef[] = [];
      for (const [key, ref] of created) {
        const original = await backend.getNode(
          target.graphId,
          ref.kind,
          ref.id,
        );
        const final = await storeBackend(strict.candidate.store).getNode(
          strict.candidate.store.graphId,
          ref.kind,
          ref.id,
        );
        if (
          original === undefined ||
          final === undefined ||
          final.deleted_at !== undefined
        )
          continue;
        if (original.deleted_at === undefined && !recreated.has(key)) continue;
        const props = parseRowProps(final.props);
        nodeUpserts.set(key, {
          kind: ref.kind,
          id: ref.id,
          setProps: props as Readonly<Record<string, JsonValue>>,
          unsetProps: Object.keys(parseRowProps(original.props)).filter(
            (name) => !Object.hasOwn(props, name),
          ),
          validFrom: final.valid_from ?? null,
          ...(original.deleted_at === undefined ?
            { recreate: true as const }
          : {}),
          ...(final.valid_to === undefined ?
            { clearValidTo: true as const }
          : { validTo: final.valid_to }),
        });
        if (original.deleted_at !== undefined) nodeResurrections.push(ref);
      }
      await assertPlanningFenceUnchanged(target, fence);
      const { digest: _digest, ...artifact } = planned.data;
      return {
        success: true,
        data: await finalizeMergePlanArtifact({
          ...artifact,
          formatVersion: 2,
          proposed: {
            ...artifact.proposed,
            nodes: { ...artifact.proposed.nodes, upserts: nodeUpserts.size },
          },
          writes: {
            ...artifact.writes,
            nodeUpserts: [...nodeUpserts.values()],
          },
          guards: {
            ...artifact.guards,
            ...(nodeResurrections.length === 0 ? {} : { nodeResurrections }),
          },
        }),
      };
    } finally {
      await strict.candidate.close();
    }
  } catch (error) {
    return err(
      error instanceof MergeError ? error : (
        new CandidateWriteSetError("Mutation planning failed.", {
          cause: error,
        })
      ),
    );
  }
}
