/**
 * Example 27: Durable Merge Review
 *
 * Persist review and approval records in the target, revalidate the retained
 * candidate, and apply a fresh execution plan under the normal revision fence.
 * Authentication and approval policy remain application responsibilities.
 *
 * Run from packages/typegraph after building the package:
 *   node --import tsx examples/27-durable-merge-review.ts
 */
import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import {
  createLocalSqliteBackend,
} from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import {
  applyMergePlan,
  applyMergePlanInTransaction,
  captureCandidateWriteSetTarget,
  isErr,
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
  StaleMergePlanError,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

const Item = defineNode("Item", {
  schema: z.object({
    label: z.string(),
    status: z.enum(["proposed", "accepted"]),
  }),
});
const Artifact = defineNode("Artifact", {
  schema: z.object({ content: z.string() }),
});
const Decision = defineNode("Decision", {
  schema: z.object({
    approved: z.boolean(),
    reviewDigest: z.string(),
    reviewer: z.string(),
  }),
});
const evidence = defineEdge("evidence", {
  schema: z.object({ note: z.string() }),
});
const graph = defineGraph({
  id: "durable_merge_review_example",
  nodes: {
    Item: { type: Item },
    Artifact: { type: Artifact },
    Decision: { type: Decision },
  },
  edges: {
    evidence: { type: evidence, from: [Item, Decision], to: [Artifact] },
  },
});

const VALID_FROM = "2026-01-01T00:00:00.000Z";
const POLICY = {
  id: "manual-acceptance-v1",
  context: { requiredApprovals: 1, authorizedReviewers: ["reviewer:maya"] },
};

function makeBackend(): Promise<ReturnType<typeof createExampleBackend>> {
  return Promise.resolve(createExampleBackend());
}

export async function main(): Promise<void> {
  const { backend, db } = createLocalSqliteBackend();
  try {
    const [store] = await createAdapterStoreWithSchema(graph, backend, {
      history: true,
    });
    const proposal = await store.nodes.Item.create(
      { label: "Reviewed catalog entry", status: "proposed" },
      { id: "proposal:entry", validFrom: VALID_FROM },
    );
    const review = unwrap(
      await planCandidateWriteSetReview({
        target: store,
        makeBackend,
        policy: POLICY,
        writeSet: {
          formatVersion: 1,
          sourceId: "catalog-review",
          target: await captureCandidateWriteSetTarget(store),
          nodes: [
            {
              kind: "Item",
              id: proposal.id,
              properties: { label: proposal.label, status: "accepted" },
              validFrom: VALID_FROM,
            },
          ],
          edges: [],
        },
      }),
    );

    // Append new records and links. Mutating an original row (including an
    // older audit record) would require a new review under the V1 baseline.
    // Content addressing is an identifier; storage must enforce immutability.
    const artifact = await store.nodes.Artifact.create(
      { content: JSON.stringify(review) },
      { id: review.digest.value },
    );
    await store.edges.evidence.create(proposal, artifact, { note: "review" });

    // Simulate an already authenticated reviewer approving this exact review.
    // Production applications authenticate reviewer requests and stored records.
    const decision = await store.nodes.Decision.create({
      approved: true,
      reviewDigest: review.digest.value,
      reviewer: "reviewer:maya",
    });
    await store.edges.evidence.create(decision, artifact, { note: "approval" });

    const stale = await applyMergePlan(store, review.plan);
    if (!isErr(stale) || !(stale.error instanceof StaleMergePlanError)) {
      throw new Error("Expected original plan to be stale after audit writes");
    }
    console.log("Original execution plan is stale; durable review is retained.");

    const persisted = await store.nodes.Artifact.getById(artifact.id);
    const approval = await store.nodes.Decision.getById(decision.id);
    if (
      persisted === undefined ||
      approval === undefined ||
      !approval.approved ||
      approval.reviewDigest !== artifact.id ||
      !POLICY.context.authorizedReviewers.includes(approval.reviewer)
    ) {
      throw new Error("No valid approval for this review");
    }
    const checked = unwrap(
      await revalidateCandidateWriteSetReview({
        target: store,
        makeBackend,
        review: JSON.parse(persisted.content),
        policy: POLICY,
      }),
    );
    if (checked.status !== "compatible") {
      console.log(checked.status, checked.differences);
      throw new Error("A new review and approval are required");
    }
    if (checked.reviewDigest.value !== approval.reviewDigest) {
      throw new Error("Approval does not identify the validated review");
    }

    // Do not persist this ephemeral plan or write the target graph before apply.
    // The adopted applier throws on failure so the caller-owned transaction
    // cannot accidentally commit a partial merge. The plan must have
    // persistProvenance: false; report-only provenance remains available.
    db.run(
      sql`
        CREATE TABLE application_merge_receipts (
                review_digest TEXT NOT NULL,
                recorded_at TEXT NOT NULL
              )
      `,
    );
    db.run(sql`BEGIN`);
    try {
      const { result: report, receipt } = await store.withRecordedTransaction(
        db,
        async (tx) => {
          // Apply first: the plan fence must be checked before any other write
          // to this target graph in the caller-owned transaction.
          const applied = await applyMergePlanInTransaction(
            store,
            tx,
            checked.plan,
          );

          // Additional graph writes may follow the apply. They share its one
          // history capture and the caller's outer transaction.
          await tx.nodes.Artifact.create({
            content: JSON.stringify({
              reviewDigest: checked.reviewDigest,
              approvalId: approval.id,
              executionPlanDigest: checked.plan.digest,
              executionTarget: checked.plan.target,
              report: applied,
            }),
          });
          return applied;
        },
      );
      if (receipt.recorded === undefined) {
        throw new Error("Expected the merge transaction to allocate history");
      }

      // The receipt is allocated after the capture callback. Application SQL
      // can persist it on the same native transaction before the outer COMMIT.
      db.run(
        sql`
          INSERT INTO application_merge_receipts
                    (review_digest, recorded_at)
                    VALUES (${checked.reviewDigest.value}, ${receipt.recorded})
        `,
      );
      db.run(sql`COMMIT`);
      console.log(
        `Applied ${report.merged.nodes} node change and recorded its receipt atomically.`,
      );
    } catch (error) {
      db.run(sql`ROLLBACK`);
      throw error;
    }
    const accepted = await store.nodes.Item.getById(proposal.id);
    if (accepted?.status !== "accepted") {
      throw new Error("Expected the reviewed change to be committed");
    }
    console.log("Applied the approved change after same-graph audit writes.");
  } finally {
    await backend.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
