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
  validFrom?: string | null;
  validTo?: string;
}>;
type Step<G extends GraphDef> = Readonly<{
  entity: "node" | "edge";
  kind: string;
  id: string;
  deletion: boolean;
  creation?: boolean;
  endpoints?: Readonly<{ from: MergePlanEntityRef; to: MergePlanEntityRef }>;
  run: (store: Store<G>) => Promise<unknown>;
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
  planningScope?: "candidate" | "full";
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

function mutationBuilder<G extends GraphDef>(
  target: Store<G>,
  sourceId: string,
  fence: MergePlanTargetFence,
  steps: readonly Step<G>[],
): MutationPlanBuilder<G> {
  function append(step: Step<G>): MutationPlanBuilder<G> {
    const kinds =
      step.entity === "node" ? target.graph.nodes : target.graph.edges;
    if (
      !Object.hasOwn(kinds, step.kind) ||
      typeof step.id !== "string" ||
      step.id.length === 0
    )
      throw new ValidationError(
        "Mutation requires a registered kind and nonempty id.",
        {
          issues: [{ path: "mutation", message: "Unknown kind or empty id." }],
        },
      );
    return mutationBuilder(target, sourceId, fence, [...steps, step]);
  }
  return Object.freeze({
    get target() {
      return structuredClone(fence);
    },
    operationCount: steps.length,
    createNode(kind, id, props, options) {
      const copy = structuredClone({ props, options });
      return append({
        entity: "node",
        kind,
        id,
        deletion: false,
        run: (store) =>
          nodeWriter(store, kind).create(copy.props, { ...copy.options, id }),
      });
    },
    updateNode(kind, id, props, options) {
      const copy = structuredClone({ props, options });
      return append({
        entity: "node",
        kind,
        id,
        deletion: false,
        run: (store) =>
          nodeWriter(store, kind).update(id, copy.props, copy.options),
      });
    },
    replaceNode(kind, id, props) {
      const copy = structuredClone(props);
      return append({
        entity: "node",
        kind,
        id,
        deletion: false,
        run: (store) =>
          nodeWriter(store, kind).bulkReplaceById([{ id, props: copy }]),
      });
    },
    deleteNode(kind, id) {
      return append({
        entity: "node",
        kind,
        id,
        deletion: true,
        run: (store) => nodeWriter(store, kind).delete(id),
      });
    },
    createEdge(kind, id, from, to, props, options) {
      const copy = structuredClone({ from, to, props, options });
      return append({
        entity: "edge",
        kind,
        id,
        deletion: false,
        creation: true,
        endpoints: { from: copy.from, to: copy.to },
        run: (store) =>
          edgeWriter(store, kind).create(copy.from, copy.to, copy.props, {
            ...copy.options,
            id,
          }),
      });
    },
    updateEdge(kind, id, props, options) {
      const copy = structuredClone({ props, options });
      return append({
        entity: "edge",
        kind,
        id,
        deletion: false,
        run: (store) =>
          edgeWriter(store, kind).update(id, copy.props, copy.options),
      });
    },
    deleteEdge(kind, id) {
      return append({
        entity: "edge",
        kind,
        id,
        deletion: true,
        run: (store) => edgeWriter(store, kind).delete(id),
      });
    },
    plan: (options) => planMutations(target, sourceId, fence, steps, options),
  } satisfies MutationPlanBuilder<G>);
}

async function observe<G extends GraphDef>(
  candidate: GraphBranch<G>,
  steps: readonly Step<G>[],
): Promise<Observation> {
  const backend = storeBackend(candidate.store);
  const baseline = requireDefined(
    await candidate.store.lineageRevisionNow(),
    "Mutation staging requires changed-key lineage.",
  );
  const nodes: NodeRow[] = [];
  const edges: EdgeRow[] = [];
  let previous = baseline;
  for (const step of steps) {
    await step.run(candidate.store);
    const delta = await candidate.store.changesSince(previous);
    if (delta.kind !== "keys")
      throw new MergePlanCapabilityError(
        "Mutation staging did not produce complete changed keys.",
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

async function planMutations<G extends GraphDef>(
  target: Store<G>,
  sourceId: string,
  fence: MergePlanTargetFence,
  steps: readonly Step<G>[],
  options: MutationPlanningOptions,
): Promise<Result<MergePlanArtifact, MergeError>> {
  try {
    if (![undefined, "candidate", "full"].includes(options.planningScope))
      throw new MergePlanCapabilityError("Unknown mutation planning scope.");
    await assertPlanningFenceUnchanged(target, fence);
    const bounded = options.planningScope !== "full";
    if (bounded && !canUseSparseCandidatePlanning(target))
      throw new MergePlanCapabilityError(
        "This graph cannot be mutation-planned with bounded candidate reads. Explicitly select full planning to permit a complete clone.",
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
    for (const step of steps) {
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
          );
        if (!bounded) {
          const readOwners = matchIdentityOwnerReader(target);
          if (readOwners === undefined)
            throw new MergePlanCapabilityError(
              "Mutation planning requires exact durable edge identity reads.",
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
      const nodeResurrections: MergePlanEntityRef[] = [];
      const replacementUnsets = new Map<string, readonly string[]>();
      for (const step of steps) {
        if (step.deletion || step.entity !== "node") continue;
        const original = await backend.getNode(
          target.graphId,
          step.kind,
          step.id,
        );
        if (original?.deleted_at === undefined) continue;
        nodeResurrections.push({ kind: step.kind, id: step.id });
        replacementUnsets.set(
          JSON.stringify([step.kind, step.id]),
          Object.keys(parseRowProps(original.props)),
        );
      }
      await assertPlanningFenceUnchanged(target, fence);
      const { digest: _digest, ...artifact } = planned.data;
      return {
        success: true,
        data: await finalizeMergePlanArtifact({
          ...artifact,
          writes: {
            ...artifact.writes,
            nodeUpserts: artifact.writes.nodeUpserts.map((upsert) => ({
              ...upsert,
              unsetProps: [
                ...new Set([
                  ...upsert.unsetProps,
                  ...(
                    replacementUnsets.get(
                      JSON.stringify([upsert.kind, upsert.id]),
                    ) ?? []
                  ).filter((key) => !Object.hasOwn(upsert.setProps, key)),
                ]),
              ],
            })),
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
