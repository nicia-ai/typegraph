import { z } from "zod";

import {
  type GraphData,
  importGraph,
  InterchangeIdentitySchema,
} from "../interchange";
import { isCanonicalIsoDate } from "../utils/date";
import { computeSchemaComponent } from "./base-version";
import { CandidateWriteSetError, type MergeError } from "./errors";
import { ingestionBranch } from "./ingestion-branch";
import { planMergeIncremental } from "./merge";
import type { MergePlanArtifact } from "./plan-schema";
import type { Result } from "./result";
import { err, isErr } from "./result";
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

function interchangeDocument(writeSet: CandidateWriteSet): GraphData {
  return {
    formatVersion: "2.0",
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
 * closes that working copy on success, refusal, or throw. The returned artifact
 * is the ordinary versioned/digested {@link MergePlanArtifact}; no parallel
 * conflict format or scoring implementation exists.
 */
export async function planCandidateWriteSet<G extends GraphDef>(
  args: PlanCandidateWriteSetArgs<G>,
): Promise<Result<MergePlanArtifact, MergeError>> {
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
  try {
    created = await ingestionBranch(args.target, args.makeBackend, {
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
          "The candidate write set could not be staged against the active schema.",
          { details: { errors: imported.errors } },
        ),
      );
    }
    return await planMergeIncremental({
      forkPoint: args.target,
      target: args.target,
      branches: [candidate],
      ...(args.options === undefined ? {} : { options: args.options }),
    });
  } catch (error) {
    return err(
      error instanceof CandidateWriteSetError ? error : (
        new CandidateWriteSetError(
          "Candidate write-set staging or planning failed.",
          { cause: error },
        )
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
