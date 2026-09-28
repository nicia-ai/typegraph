import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import {
  captureCandidateWriteSetTarget,
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
} from "../../../src/graph-merge";
import { isErr, unwrap } from "../../../src/graph-merge/result";
import type { IntegrationTestContext } from "./test-context";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "candidate_scoped_review_identity_v2",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

export function registerGraphMergeReviewV2IntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("candidate-scoped identity review V2", () => {
    it("requires renewed review after an identity assertion joins the retained closure", async () => {
      const target = await context.createHistoryStore(graph);
      const seed = await target.nodes.Person.create(
        { name: "seed" },
        { id: "seed", validFrom: "2020-01-01T00:00:00.000Z" },
      );
      const other = await target.nodes.Person.create(
        { name: "other" },
        { id: "other", validFrom: "2020-01-01T00:00:00.000Z" },
      );
      const writeSet = {
        formatVersion: 1 as const,
        sourceId: "review-source",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [
          {
            kind: "Person",
            id: "candidate",
            properties: { name: "candidate" },
            validFrom: "2020-01-01T00:00:00.000Z",
          },
        ],
        edges: [],
        identity: {
          profile: "typegraph-identity-v1" as const,
          mode: "state" as const,
          assertions: [
            {
              id: "candidate-link",
              relation: "same" as const,
              a: { kind: "Person", id: "candidate" },
              b: { kind: "Person", id: seed.id },
              validFrom: "2020-01-01T00:00:00.000Z",
            },
          ],
        },
      };
      const makeBackend = () => context.createIsolatedBackend();
      const args = {
        target,
        makeBackend,
        writeSet,
        policy: { id: "policy", context: {} },
        reviewScope: "candidate" as const,
      };
      const review = unwrap(await planCandidateWriteSetReview(args));
      expect(review.formatVersion).toBe(2);
      expect(review.baseline.identityReferences).toContainEqual({
        kind: "Person",
        id: seed.id,
      });

      await target.identity.assertSame(seed, other);
      const result = unwrap(
        await revalidateCandidateWriteSetReview({
          target,
          makeBackend,
          policy: args.policy,
          review,
        }),
      );
      expect(result.status).toBe("changed");
      const differencePaths =
        result.status === "changed" ?
          result.differences.map((entry) => entry.path)
        : [];
      expect(differencePaths).toContain("baseline.identityDigest");
      expect(isErr(await planCandidateWriteSetReview(args))).toBe(false);
    });
  });
}
