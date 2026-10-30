import { z } from "zod";

import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  InterchangeIdentitySchema,
} from "../interchange";
import type { EvolutionPlan } from "../schema/evolution-plan";
import { isCanonicalIsoDate } from "../utils/date";
import { readOwnProperty } from "../utils/object";
import { computeSchemaComponent } from "./base-version";
import {
  CandidatePlanningScopeError,
  CandidateWriteSetError,
  InvalidMergeOptionsError,
  MergeError,
} from "./errors";
import { evolutionPlanningTarget } from "./evolution-target";
import {
  ingestionBranch,
  ingestionBranchWithStrategy,
} from "./ingestion-branch";
import {
  assertPlanningFenceUnchanged,
  captureMergePlanTargetFence,
  planMergeIncremental,
  planMergeIncrementalForEvolution,
  planMergeIncrementalWithCandidateKeys,
  publicPlanCapabilityRefusal,
  sameMergePlanTargetFence,
} from "./merge";
import type { MergePlanArtifact } from "./plan-schema";
import type { Result } from "./result";
import { err, isErr, ok } from "./result";
import {
  boundedCandidateKeys,
  type CandidatePlanningScope,
  candidatePlanningScope,
  type CandidatePlanningScopeResolution,
  resolveCandidatePlanningScope,
  sparseCandidateWorkingCopyStrategy,
  wholeTargetPlanningScope,
} from "./sparse-candidate-branch";
import type { GraphDef, Store } from "./typegraph-internal";
import { storeBackend } from "./typegraph-internal";
import type { MergeOptions } from "./types";
import { asBranchId } from "./types";
import type { MakeBackend } from "./working-copy";

/** Current JSON wire version emitted and accepted for candidate write sets. */
export const CANDIDATE_WRITE_SET_FORMAT_VERSION = 1 as const;

const nonEmptyStringSchema = z.string().min(1);
const validityTimestampSchema = z.iso
  .datetime()
  .refine((value) => isCanonicalIsoDate(value), {
    message: "Expected canonical UTC ISO 8601 with fixed milliseconds.",
  });
const entityReferenceSchema = z.object({
  kind: nonEmptyStringSchema,
  id: nonEmptyStringSchema,
});
const jsonObjectSchema = z.record(z.string(), z.json());

const candidateNodeSchema = z.object({
  kind: nonEmptyStringSchema,
  id: nonEmptyStringSchema,
  properties: jsonObjectSchema,
  validFrom: validityTimestampSchema.nullable(),
  validTo: validityTimestampSchema.optional(),
});

const candidateEdgeSchema = z.object({
  kind: nonEmptyStringSchema,
  id: nonEmptyStringSchema,
  from: entityReferenceSchema,
  to: entityReferenceSchema,
  properties: jsonObjectSchema.default({}),
  validFrom: validityTimestampSchema.nullable(),
  validTo: validityTimestampSchema.optional(),
});

/** Target schema identity carried by a candidate document. */
export const CandidateWriteSetTargetSchema = z.object({
  graphId: nonEmptyStringSchema,
  schemaVersion: z.number().int().positive(),
  schemaHash: nonEmptyStringSchema,
});
export type CandidateWriteSetTarget = z.infer<
  typeof CandidateWriteSetTargetSchema
>;

/**
 * JSON-safe, source-attributed candidate writes accepted by
 * {@link planCandidateWriteSet}.
 *
 * `sourceId` becomes the existing merge pipeline's branch attribution. Entity
 * ids remain the per-candidate source ids in provenance records. Every temporal
 * lower bound is explicit so replaying identical JSON cannot acquire a new
 * import-time timestamp and change the resulting plan digest.
 */
export const CandidateWriteSetSchema = z.object({
  formatVersion: z.literal(CANDIDATE_WRITE_SET_FORMAT_VERSION),
  sourceId: nonEmptyStringSchema,
  target: CandidateWriteSetTargetSchema,
  nodes: z.array(candidateNodeSchema),
  edges: z.array(candidateEdgeSchema),
  identity: InterchangeIdentitySchema.optional(),
});
export type CandidateWriteSet = z.infer<typeof CandidateWriteSetSchema>;

/** Object-form arguments for branch-free candidate planning. */
export type PlanCandidateWriteSetArgs<G extends GraphDef> = Readonly<{
  target: Store<G>;
  makeBackend: MakeBackend;
  writeSet: unknown;
  options?: Omit<MergeOptions<G>, "target">;
  /**
   * Require planning from the candidate's own rows. Without it, a target or
   * candidate outside that scope is planned against the whole target; with
   * it, that case is refused with `CandidatePlanningScopeError` before any
   * staging store is created.
   */
  planningScope?: "candidate";
}>;

/**
 * A candidate plan and the scope it was staged in. The scope is a
 * planning-cost fact, not plan content: both scopes produce the same correct
 * plan, so it stays outside the digested artifact.
 */
export type CandidateWriteSetPlan = Readonly<{
  plan: MergePlanArtifact;
  planningScope: CandidatePlanningScope;
}>;

/**
 * Object-form arguments for candidate planning against a planned evolution.
 * It always stages the whole resulting graph, so it takes no `planningScope`.
 */
export type PlanCandidateWriteSetForEvolutionArgs<G extends GraphDef> = Omit<
  PlanCandidateWriteSetArgs<G>,
  "target" | "planningScope"
> &
  Readonly<{
    target: Store<G>;
    evolutionPlan: EvolutionPlan;
  }>;

/** Captures the schema identity a candidate write set must name. */
export async function captureCandidateWriteSetTarget<G extends GraphDef>(
  target: Store<G>,
): Promise<CandidateWriteSetTarget> {
  const activeSchema = await storeBackend(target).getActiveSchema(
    target.graphId,
  );
  return {
    graphId: target.graphId,
    schemaVersion:
      activeSchema?.version ?? target.introspect().schemaVersion ?? 1,
    schemaHash: await computeSchemaComponent(target),
  };
}

/**
 * Captures the schema identity a candidate write set must name after a planned
 * evolution commits. The plan remains nonserializable; this JSON-safe target
 * identity lets a caller author and review candidate data before that commit.
 */
export function captureCandidateWriteSetTargetForEvolution<G extends GraphDef>(
  target: Store<G>,
  evolutionPlan: EvolutionPlan,
): CandidateWriteSetTarget {
  const resultingTarget = evolutionPlanningTarget(target, evolutionPlan);
  return candidateWriteSetTargetForEvolution(resultingTarget, evolutionPlan);
}

function candidateWriteSetTargetForEvolution<G extends GraphDef>(
  resultingTarget: Store<G>,
  evolutionPlan: EvolutionPlan,
): CandidateWriteSetTarget {
  return {
    graphId: resultingTarget.graphId,
    schemaVersion: evolutionPlan.result.version,
    schemaHash: evolutionPlan.result.hash,
  };
}

function sameCandidateTarget(
  left: CandidateWriteSetTarget,
  right: CandidateWriteSetTarget,
): boolean {
  return (
    left.graphId === right.graphId &&
    left.schemaVersion === right.schemaVersion &&
    left.schemaHash === right.schemaHash
  );
}

function requestedPlanningScope(
  args: Readonly<Record<string, unknown>>,
): Result<"candidate" | undefined, InvalidMergeOptionsError> {
  const requested = readOwnProperty(args, "planningScope");
  if (requested === undefined || requested === "candidate")
    return ok(requested);
  return err(
    new InvalidMergeOptionsError("Unsupported candidate planning scope.", {
      details: { planningScope: requested },
    }),
  );
}

function interchangeDocument(writeSet: CandidateWriteSet): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    // Import does not use transport time. A constant keeps this adapter a pure
    // function of the candidate JSON and target snapshot.
    exportedAt: "1970-01-01T00:00:00.000Z",
    source: { type: "external", description: writeSet.sourceId },
    nodes: writeSet.nodes,
    edges: writeSet.edges,
    ...(writeSet.identity === undefined ? {} : { identity: writeSet.identity }),
  };
}

/**
 * Plans one serializable candidate write set against the current accepted graph.
 *
 * The adapter creates no durable branch and never mutates `target`. It stages in
 * a disposable ingestion working copy, delegates to `planMergeIncremental`, and
 * closes that working copy on success, refusal, or throw. The returned `plan`
 * is the ordinary versioned/digested {@link MergePlanArtifact}; no parallel
 * conflict format or scoring implementation exists. `planningScope` reports
 * whether the copy was seeded from the candidate's own rows or the whole
 * target, and why.
 */
export async function planCandidateWriteSet<G extends GraphDef>(
  args: PlanCandidateWriteSetArgs<G>,
): Promise<Result<CandidateWriteSetPlan, MergeError>> {
  const requested = requestedPlanningScope(args);
  if (isErr(requested)) return requested;
  const capabilityRefusal = publicPlanCapabilityRefusal(args.target);
  if (capabilityRefusal !== undefined) return err(capabilityRefusal);
  if (requested.data === "candidate") {
    const targetScope = candidatePlanningScope(args.target);
    if (targetScope.scope === "whole-target")
      return err(new CandidatePlanningScopeError(targetScope));
  }
  const parsed = CandidateWriteSetSchema.safeParse(args.writeSet);
  if (!parsed.success) {
    return err(
      new CandidateWriteSetError("The candidate write set is malformed.", {
        details: { issues: parsed.error.issues },
      }),
    );
  }
  const writeSet = parsed.data;
  let currentTarget: CandidateWriteSetTarget;
  try {
    currentTarget = await captureCandidateWriteSetTarget(args.target);
  } catch (error) {
    return err(
      new CandidateWriteSetError(
        "Unable to capture the candidate target schema.",
        { cause: error },
      ),
    );
  }
  if (!sameCandidateTarget(writeSet.target, currentTarget)) {
    return err(
      new CandidateWriteSetError(
        "The candidate write set targets a different graph schema.",
        {
          details: { expected: currentTarget, received: writeSet.target },
          suggestion:
            "Rebuild the candidate write set against the target's current schema, then plan it again.",
        },
      ),
    );
  }

  let created: Awaited<ReturnType<typeof ingestionBranch<G>>>;
  let resolution: CandidatePlanningScopeResolution;
  try {
    resolution = await resolveCandidatePlanningScope(args.target, writeSet);
  } catch (error) {
    return err(
      new CandidateWriteSetError(
        "Unable to read exact durable edge identity owners for candidate planning.",
        { cause: error },
      ),
    );
  }
  const { planningScope } = resolution;
  if (requested.data === "candidate" && planningScope.scope === "whole-target")
    return err(new CandidatePlanningScopeError(planningScope));
  const bounded = "fence" in resolution ? resolution : undefined;
  const sparse =
    bounded === undefined ? undefined : (
      sparseCandidateWorkingCopyStrategy<G>(
        writeSet,
        args.makeBackend,
        bounded.ownerRead.owners,
      )
    );
  try {
    created = await ingestionBranchWithStrategy(
      args.target,
      args.makeBackend,
      {
        id: asBranchId(writeSet.sourceId),
      },
      sparse?.strategy,
    );
  } catch (error) {
    return err(
      new CandidateWriteSetError(
        "Unable to create the transient candidate staging store.",
        { cause: error },
      ),
    );
  }
  if (isErr(created)) {
    return err(
      new CandidateWriteSetError(
        "Unable to create the transient candidate staging store.",
        { cause: created.error },
      ),
    );
  }
  const candidate = created.data;
  try {
    const imported = await importGraph(
      candidate,
      interchangeDocument(writeSet),
      {
        onConflict: "update",
        onUnknownProperty: "error",
        validateReferences: true,
        refreshStatistics: false,
      },
    );
    if (!imported.success) {
      return err(
        new CandidateWriteSetError(
          "The candidate write set could not be staged against the active schema.",
          { details: { errors: imported.errors } },
        ),
      );
    }
    if (bounded?.ownerRead.status === "malformed") {
      // The sparse seed omits these edges' owners; a plan may rely on it only
      // because import refuses every such edge.
      throw new CandidateWriteSetError(
        "Import staged a candidate edge whose durable match-identity owner could not be read.",
        { details: { edges: bounded.ownerRead.malformed } },
      );
    }
    const mergeArgs = {
      forkPoint: args.target,
      target: args.target,
      branches: [candidate],
      ...(args.options === undefined ? {} : { options: args.options }),
    };
    const identityScope = sparse?.identityScope();
    if (
      bounded !== undefined &&
      args.target.graph.identity !== undefined &&
      identityScope === undefined
    ) {
      return err(
        new CandidateWriteSetError(
          "The bounded identity baseline was not captured.",
        ),
      );
    }
    const planned =
      bounded === undefined ?
        await planMergeIncremental(mergeArgs)
      : await planMergeIncrementalWithCandidateKeys(
          mergeArgs,
          boundedCandidateKeys(writeSet),
          identityScope,
        );
    if (isErr(planned)) return planned;
    if (bounded !== undefined) {
      await assertPlanningFenceUnchanged(args.target, bounded.fence);
      if (!sameMergePlanTargetFence(bounded.fence, planned.data.target)) {
        throw new CandidateWriteSetError(
          "The bounded candidate baseline does not match the merge plan target fence.",
        );
      }
    }
    return ok({ plan: planned.data, planningScope });
  } catch (error) {
    return err(
      error instanceof CandidateWriteSetError || error instanceof MergeError ?
        error
      : new CandidateWriteSetError(
          "Candidate write-set staging or planning failed.",
          { cause: error },
        ),
    );
  } finally {
    try {
      await candidate.close();
    } catch {
      // A disposable backend close failure must not replace the planner's
      // success or its original typed refusal.
    }
  }
}

/**
 * Plans a serializable candidate write set against the graph a reviewed
 * evolution will produce.
 *
 * Candidate data is staged in an isolated working copy of the resulting graph,
 * then resolved against accepted target sources through the evolution-aware
 * incremental planner. The returned ordinary merge artifact carries the
 * resulting schema fence, so
 * `withEvolvedTransaction()` and `applyMergePlanInTransaction()` can commit
 * schema and accepted candidate writes in one caller transaction and revision.
 * The staging copy is always the whole resulting graph, so the result reports
 * `planned-evolution`, and an untyped `planningScope: "candidate"` is refused
 * with `CandidatePlanningScopeError`.
 */
export async function planCandidateWriteSetForEvolution<G extends GraphDef>(
  args: PlanCandidateWriteSetForEvolutionArgs<G>,
): Promise<Result<CandidateWriteSetPlan, MergeError>> {
  const requested = requestedPlanningScope(args);
  if (isErr(requested)) return requested;
  const planningScope = wholeTargetPlanningScope("planned-evolution");
  if (requested.data === "candidate")
    return err(new CandidatePlanningScopeError(planningScope));
  const parsed = CandidateWriteSetSchema.safeParse(args.writeSet);
  if (!parsed.success) {
    return err(
      new CandidateWriteSetError("The candidate write set is malformed.", {
        details: { issues: parsed.error.issues },
      }),
    );
  }
  const writeSet = parsed.data;
  let resultingTarget: Store<G>;
  let expectedTarget: CandidateWriteSetTarget;
  let planningFence: Awaited<ReturnType<typeof captureMergePlanTargetFence>>;
  try {
    resultingTarget = evolutionPlanningTarget(args.target, args.evolutionPlan);
    expectedTarget = candidateWriteSetTargetForEvolution(
      resultingTarget,
      args.evolutionPlan,
    );
    planningFence = await captureMergePlanTargetFence(args.target);
  } catch (error) {
    return err(
      error instanceof MergeError ? error : (
        new CandidateWriteSetError(
          "Unable to prepare the planned evolution target schema.",
          { cause: error },
        )
      ),
    );
  }
  if (!sameCandidateTarget(writeSet.target, expectedTarget)) {
    return err(
      new CandidateWriteSetError(
        "The candidate write set targets a different planned evolution schema.",
        {
          details: { expected: expectedTarget, received: writeSet.target },
          suggestion:
            "Rebuild the candidate write set against the planned evolution schema, then plan it again.",
        },
      ),
    );
  }

  let created: Awaited<ReturnType<typeof ingestionBranch<G>>>;
  try {
    created = await ingestionBranch(resultingTarget, args.makeBackend, {
      id: asBranchId(writeSet.sourceId),
    });
  } catch (error) {
    return err(
      new CandidateWriteSetError(
        "Unable to create the transient candidate staging store.",
        { cause: error },
      ),
    );
  }
  if (isErr(created)) {
    return err(
      new CandidateWriteSetError(
        "Unable to create the transient candidate staging store.",
        { cause: created.error },
      ),
    );
  }
  const candidate = created.data;
  try {
    const imported = await importGraph(
      candidate,
      interchangeDocument(writeSet),
      {
        onConflict: "update",
        onUnknownProperty: "error",
        validateReferences: true,
        refreshStatistics: false,
      },
    );
    if (!imported.success) {
      return err(
        new CandidateWriteSetError(
          "The candidate write set could not be staged against the planned evolution schema.",
          { details: { errors: imported.errors } },
        ),
      );
    }
    const planned = await planMergeIncrementalForEvolution(
      args.target,
      args.evolutionPlan,
      [candidate],
      args.options,
      planningFence,
    );
    if (isErr(planned)) return planned;
    return ok({ plan: planned.data, planningScope });
  } catch (error) {
    return err(
      error instanceof CandidateWriteSetError || error instanceof MergeError ?
        error
      : new CandidateWriteSetError(
          "Candidate write-set staging or evolution planning failed.",
          { cause: error },
        ),
    );
  } finally {
    try {
      await candidate.close();
    } catch {
      // A disposable backend close failure must not replace the planner's
      // success or its original typed refusal.
    }
  }
}
