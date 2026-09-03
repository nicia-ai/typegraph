import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import {
  asBranchId,
  captureCandidateWriteSetTarget,
  isErr,
  MergePlanningStaleError,
  MergeReviewError,
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
  unwrap,
} from "../../src/graph-merge";
import { constructMergePlanArtifact } from "../../src/graph-merge/plan-wire";
import {
  reviewDigest,
  reviewOptionEvidence,
} from "../../src/graph-merge/review-evidence";
import type { MergeReviewArtifact } from "../../src/graph-merge/review-schema";
import { storeBackend } from "../../src/store/runtime-port";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const Artifact = defineNode("Artifact", {
  schema: z.object({ content: z.string() }),
});
const graph = defineGraph({
  id: "candidate-review-unit",
  nodes: { Item: { type: Item }, Artifact: { type: Artifact } },
  edges: {},
});
const policy = { id: "review-policy-v1", context: {} } as const;

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0)) await dispose();
});

async function setup() {
  const { backend } = createLocalSqliteBackend();
  disposers.push(() => backend.close());
  const [target] = await createStoreWithSchema(graph, backend, {
    history: true,
  });
  const makeBackend = async () => createLocalSqliteBackend().backend;
  const writeSet = {
    formatVersion: 1 as const,
    sourceId: "source",
    target: await captureCandidateWriteSetTarget(target),
    nodes: [
      {
        kind: "Item",
        id: "candidate",
        properties: { name: "New" },
        validFrom: "2026-01-01T00:00:00.000Z",
      },
    ],
    edges: [],
  };
  const args = { target, makeBackend, writeSet, policy };
  return { args, backend: storeBackend(target) };
}

async function rehash(
  review: MergeReviewArtifact,
): Promise<MergeReviewArtifact> {
  const { digest: _digest, ...content } = review;
  return {
    ...content,
    digest: { algorithm: "sha256", value: await reviewDigest(content) },
  };
}

describe("candidate review wire and coherent capture", () => {
  it("produces deterministic JSON evidence and validates it after persistence", async () => {
    const { args } = await setup();
    const first = unwrap(await planCandidateWriteSetReview(args));
    const second = unwrap(await planCandidateWriteSetReview(args));
    expect(second).toEqual(first);
    const serialized = JSON.stringify(first);
    await args.target.nodes.Artifact.create({ content: serialized });
    const revalidated = unwrap(
      await revalidateCandidateWriteSetReview({
        ...args,
        review: JSON.parse(serialized),
      }),
    );
    expect(revalidated.status).toBe("compatible");
    expect(revalidated.reviewDigest).toEqual(first.digest);
    if (revalidated.status === "compatible")
      expect(revalidated.plan.digest).not.toEqual(first.plan.digest);
    expect(JSON.stringify(first)).toBe(serialized);
  });

  it.each([
    "format",
    "kind",
    "digest",
    "policy",
    "missing-baseline",
    "duplicate-baseline",
    "input",
    "anchors",
    "plan-digest",
    "unknown-input-field",
  ])(
    "refuses invalid or insufficient %s evidence before planning",
    async (mutation) => {
      const { args } = await setup();
      const review = unwrap(await planCandidateWriteSetReview(args));
      const changed: unknown = await mutateReview(review, mutation);
      const makeBackend = vi.fn(args.makeBackend);
      const result = await revalidateCandidateWriteSetReview({
        ...args,
        makeBackend,
        review: changed,
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error).toBeInstanceOf(MergeReviewError);
      expect(makeBackend).not.toHaveBeenCalled();
      expect(await args.target.nodes.Item.count()).toBe(0);
    },
  );

  it("refuses a mixed-revision baseline even when the inner planner sees a stable newer target", async () => {
    const { args, backend } = await setup();
    const findNodes = backend.findNodesByKind;
    vi.spyOn(backend, "findNodesByKind").mockImplementationOnce(
      async (query) => {
        const rows = await findNodes(query);
        await args.target.nodes.Artifact.create({
          content: "write during baseline enumeration",
        });
        return rows;
      },
    );
    const result = await planCandidateWriteSetReview(args);
    expect(isErr(result)).toBe(true);
    if (isErr(result))
      expect(result.error).toBeInstanceOf(MergePlanningStaleError);
    expect(await args.target.nodes.Item.count()).toBe(0);
  });

  it("refuses a write during revalidation baseline enumeration", async () => {
    const { args, backend } = await setup();
    const review = unwrap(await planCandidateWriteSetReview(args));
    const findNodes = backend.findNodesByKind;
    vi.spyOn(backend, "findNodesByKind").mockImplementationOnce(
      async (query) => {
        const rows = await findNodes(query);
        await args.target.nodes.Artifact.create({
          content: "write during revalidation",
        });
        return rows;
      },
    );
    const result = await revalidateCandidateWriteSetReview({ ...args, review });
    expect(isErr(result)).toBe(true);
    if (isErr(result))
      expect(result.error).toBeInstanceOf(MergePlanningStaleError);
  });

  it("rejects non-JSON policy context instead of silently dropping it", async () => {
    const { args } = await setup();
    const result = await planCandidateWriteSetReview({
      ...args,
      policy: { id: "opaque", context: undefined } as unknown as typeof policy,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBeInstanceOf(MergeReviewError);
  });

  it("records callback presence and canonical Map options without serializing closures", () => {
    const canonical = () => {
      throw new Error("evidence must not call policy");
    };
    expect(reviewOptionEvidence({ canonical })).not.toEqual(
      reviewOptionEvidence(undefined),
    );
    expect(() => reviewOptionEvidence({ canonical })).not.toThrow();
    expect(
      reviewOptionEvidence({
        provenanceWeights: new Map([
          [asBranchId("a"), 1],
          [asBranchId("b"), 2],
        ]),
      }),
    ).toEqual(
      reviewOptionEvidence({
        provenanceWeights: new Map([
          [asBranchId("b"), 2],
          [asBranchId("a"), 1],
        ]),
      }),
    );
  });
});

async function mutateReview(
  review: MergeReviewArtifact,
  mutation: string,
): Promise<unknown> {
  switch (mutation) {
    case "unknown-input-field": {
      return {
        ...review,
        writeSet: { ...review.writeSet, unreviewedCondition: true },
      };
    }
    case "format": {
      return { ...review, formatVersion: 99 };
    }
    case "kind": {
      return { ...review, kind: "snapshot" };
    }
    case "digest": {
      return { ...review, policy: { ...policy, id: "changed" } };
    }
    case "policy": {
      return { ...review, policy: { id: "missing-context" } };
    }
    case "missing-baseline": {
      return rehash({ ...review, baseline: { ...review.baseline, rows: [] } });
    }
    case "duplicate-baseline": {
      return rehash({
        ...review,
        baseline: {
          ...review.baseline,
          rows: [...review.baseline.rows, ...review.baseline.rows],
        },
      });
    }
    case "input": {
      return rehash({
        ...review,
        writeSet: { ...review.writeSet, sourceId: "other-source" },
      });
    }
    case "anchors": {
      const { digest: _digest, ...plan } = review.plan;
      return rehash({
        ...review,
        plan: await constructMergePlanArtifact({
          ...plan,
          anchors: {
            ...plan.anchors,
            branches: [{ branchId: "source", baseVersion: "other" }],
          },
        }),
      });
    }
    case "plan-digest": {
      return rehash({
        ...review,
        plan: {
          ...review.plan,
          digest: { algorithm: "sha256", value: "0".repeat(64) },
        },
      });
    }
    default: {
      throw new Error(`Unknown mutation: ${mutation}`);
    }
  }
}
