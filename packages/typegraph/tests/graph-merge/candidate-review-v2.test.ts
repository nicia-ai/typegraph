import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import {
  MERGE_REVIEW_FORMAT_VERSION,
  MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED,
} from "../../src/graph-merge";
import {
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
} from "../../src/graph-merge/candidate-review";
import { captureCandidateWriteSetTarget } from "../../src/graph-merge/candidate-write-set";
import { BaseVersionMismatchError } from "../../src/graph-merge/errors";
import { isErr, unwrap } from "../../src/graph-merge/result";
import {
  captureReferencedReviewBaseline,
  compareReviewBaseline,
} from "../../src/graph-merge/review-baseline";
import { reviewDigest } from "../../src/graph-merge/review-evidence";
import { sql } from "../../src/query/sql-fragment";
import { asCompiledStatementSql } from "../../src/query/sql-intent";
import { storeRuntime } from "../../src/store/runtime-port";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const Related = defineEdge("related", { schema: z.object({}) });
const OtherEdge = defineEdge("other", { schema: z.object({}) });
const graph = defineGraph({
  id: "candidate-review-v2",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    related: { type: Related, from: [Person], to: [Person] },
    other: { type: OtherEdge, from: [Person], to: [Person] },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const { backend } = createLocalSqliteBackend();
  cleanups.push(() => backend.close());
  const [store] = await createStoreWithSchema(graph, backend, {
    history: true,
  });
  return store;
}

describe("candidate-scoped review baseline", () => {
  it("includes future-start open assertions with the interchange state predicate", async () => {
    const { backend } = createLocalSqliteBackend();
    cleanups.push(() => backend.close());
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const seed = await store.nodes.Person.create(
      { name: "seed" },
      { id: "seed", validFrom: "2020-01-01T00:00:00.000Z" },
    );
    const other = await store.nodes.Person.create(
      { name: "other" },
      { id: "other", validFrom: "2020-01-01T00:00:00.000Z" },
    );
    const { assertion } = await store.identity.assertSame(seed, other);
    const references = [{ kind: "Person", id: seed.id }] as const;
    const rows = [{ role: "node", kind: "Person", id: seed.id }] as const;
    const before = await captureReferencedReviewBaseline(
      store,
      rows,
      references,
    );
    const executeStatement = backend.executeStatement;
    if (executeStatement === undefined)
      throw new Error("Bundled backend must execute test statements.");
    await executeStatement(
      asCompiledStatementSql(
        sql`UPDATE typegraph_identity_assertions SET valid_from = ${"2099-01-01T00:00:00.000Z"} WHERE graph_id = ${store.graphId} AND id = ${assertion.id}`,
      ),
    );
    const state =
      await storeRuntime(store).readCurrentIdentityAssertions("state");
    expect(state.map((row) => row.id)).toEqual([assertion.id]);
    const after = await captureReferencedReviewBaseline(
      store,
      rows,
      references,
    );
    expect(after.identityDigest).toBe(await reviewDigest(state));
    expect(after.identityDigest).not.toBe(before.identityDigest);
  });

  it("captures the candidate-scoped format and requires renewed review after connected identity changes", async () => {
    const store = await setup();
    const seed = await store.nodes.Person.create(
      { name: "seed" },
      { id: "seed", validFrom: "2020-01-01T00:00:00.000Z" },
    );
    const other = await store.nodes.Person.create(
      { name: "other" },
      { id: "other", validFrom: "2020-01-01T00:00:00.000Z" },
    );
    const writeSet = {
      formatVersion: 1 as const,
      sourceId: "review-source",
      target: await captureCandidateWriteSetTarget(store),
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
    const makeBackend = async () => createLocalSqliteBackend().backend;
    const args = {
      target: store,
      makeBackend,
      writeSet,
      policy: { id: "policy", context: {} },
      reviewScope: "candidate" as const,
    };
    const review = unwrap(await planCandidateWriteSetReview(args));
    expect(review.formatVersion).toBe(
      MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED,
    );
    const defaultReview = unwrap(
      await planCandidateWriteSetReview({
        target: store,
        makeBackend,
        writeSet,
        policy: args.policy,
      }),
    );
    expect(defaultReview.formatVersion).toBe(MERGE_REVIEW_FORMAT_VERSION);
    expect(review.baseline.scope).toBe("referenced");
    expect(review.baseline.identityReferences).toContainEqual({
      kind: "Person",
      id: seed.id,
    });
    await store.identity.assertSame(seed, other);
    const result = unwrap(
      await revalidateCandidateWriteSetReview({
        target: store,
        makeBackend,
        policy: args.policy,
        review,
      }),
    );
    expect(result.status).toBe("changed");
    if (result.status === "changed")
      expect(result.differences).toContainEqual({
        category: "baseline",
        path: "baseline.identityDigest",
      });
  });

  it("keeps candidate-scoped review available for identity-disabled graphs", async () => {
    const { backend } = createLocalSqliteBackend();
    cleanups.push(() => backend.close());
    const plainGraph = defineGraph({
      id: "candidate-review-v2-no-identity",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const [target] = await createStoreWithSchema(plainGraph, backend, {
      history: true,
      revisionTracking: true,
    });
    await target.nodes.Person.create(
      { name: "existing" },
      { id: "existing", validFrom: "2020-01-01T00:00:00.000Z" },
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
    };
    const review = unwrap(
      await planCandidateWriteSetReview({
        target,
        makeBackend: async () => createLocalSqliteBackend().backend,
        writeSet,
        policy: { id: "policy", context: {} },
        reviewScope: "candidate",
      }),
    );
    expect(review.formatVersion).toBe(
      MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED,
    );
    expect(review.baseline.scope).toBe("referenced");
    const { digest: _digest, ...content } = review;
    const legacyContent = {
      ...content,
      baseline: {
        rows: review.baseline.rows,
        identityDigest: review.baseline.identityDigest,
        scope: "referenced" as const,
      },
    };
    const legacyReview = {
      ...legacyContent,
      digest: {
        algorithm: "sha256" as const,
        value: await reviewDigest(legacyContent),
      },
    };
    const revalidated = unwrap(
      await revalidateCandidateWriteSetReview({
        target,
        makeBackend: async () => createLocalSqliteBackend().backend,
        policy: { id: "policy", context: {} },
        review: legacyReview,
      }),
    );
    expect(revalidated.status).toBe("compatible");
  });

  it("refuses a candidate-scoped review when identity changes after its starting fence", async () => {
    const store = await setup();
    const seed = await store.nodes.Person.create(
      { name: "seed" },
      { id: "seed", validFrom: "2020-01-01T00:00:00.000Z" },
    );
    const other = await store.nodes.Person.create(
      { name: "other" },
      { id: "other", validFrom: "2020-01-01T00:00:00.000Z" },
    );
    const writeSet = {
      formatVersion: 1 as const,
      sourceId: "review-source",
      target: await captureCandidateWriteSetTarget(store),
      nodes: [
        {
          kind: "Person",
          id: "candidate",
          properties: { name: "candidate" },
          validFrom: "2020-01-01T00:00:00.000Z",
        },
      ],
      edges: [],
    };
    let shouldMutate = true;
    const makeBackend = async () => {
      if (shouldMutate) {
        shouldMutate = false;
        await store.identity.assertSame(seed, other);
      }
      return createLocalSqliteBackend().backend;
    };
    const result = await planCandidateWriteSetReview({
      target: store,
      makeBackend,
      writeSet,
      policy: { id: "policy", context: {} },
      reviewScope: "candidate",
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result))
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
  });

  it("retains connected archival rows, deleted endpoints, and candidate ID collisions", async () => {
    const store = await setup();
    const seed = await store.nodes.Person.create(
      { name: "seed" },
      { id: "seed" },
    );
    const deleted = await store.nodes.Person.create(
      { name: "deleted endpoint" },
      { id: "deleted-endpoint" },
    );
    const related = await store.identity.assertSame(seed, deleted);
    await store.nodes.Person.delete(deleted.id);

    const collisionLeft = await store.nodes.Person.create(
      { name: "collision left" },
      { id: "collision-left" },
    );
    const collisionRight = await store.nodes.Person.create(
      { name: "collision right" },
      { id: "collision-right" },
    );
    const collision = await store.identity.assertDifferent(
      collisionLeft,
      collisionRight,
    );
    await store.identity.retractAssertion(collision.assertion.id);
    await store.edges.related.create(seed, collisionLeft, {}, { id: "link" });

    const endpointScoped = await captureReferencedReviewBaseline(
      store,
      [
        { role: "node", kind: "Person", id: "seed" },
        { role: "edge", kind: "related", id: "link" },
        { role: "edge", kind: "other", id: "link" },
      ],
      [{ kind: "Person", id: "seed" }],
      [collision.assertion.id],
    );
    const withoutIdCollision = await captureReferencedReviewBaseline(
      store,
      [{ role: "node", kind: "Person", id: "seed" }],
      [{ kind: "Person", id: "seed" }],
      [],
    );
    expect(endpointScoped.identityReferences).toContainEqual({
      kind: "Person",
      id: deleted.id,
    });
    expect(endpointScoped.identityDigest).not.toBe(
      withoutIdCollision.identityDigest,
    );
    expect(related.assertion.id).not.toBe(collision.assertion.id);
    expect(endpointScoped.rows).toContainEqual(
      expect.objectContaining({
        role: "node",
        kind: "Person",
        id: deleted.id,
      }),
    );
    expect(
      endpointScoped.rows.find(
        (row) => row.role === "edge" && row.kind === "related",
      )?.digest,
    ).toBeDefined();
    expect(
      endpointScoped.rows.find(
        (row) => row.role === "edge" && row.kind === "other",
      )?.digest,
    ).toBeUndefined();
  });

  it("revalidation scope detects newly attached assertions and same-id peers", async () => {
    const store = await setup();
    const seed = await store.nodes.Person.create(
      { name: "seed" },
      { id: "seed" },
    );
    const peer = await store.nodes.Person.create(
      { name: "peer" },
      { id: "peer" },
    );
    await store.identity.assertSame(seed, peer);
    const first = await captureReferencedReviewBaseline(
      store,
      [{ role: "node", kind: "Person", id: "seed" }],
      [{ kind: "Person", id: "seed" }],
      [],
    );

    const bridge = await store.nodes.Person.create(
      { name: "new bridge" },
      { id: "bridge" },
    );
    await store.identity.assertSame(peer, bridge);
    const afterAssertion = await captureReferencedReviewBaseline(
      store,
      first.rows,
      first.identityReferences ?? [],
      first.identityAssertionIds ?? [],
    );
    expect(compareReviewBaseline(first, afterAssertion)).toContainEqual({
      category: "baseline",
      path: "baseline.identityDigest",
    });
    expect(compareReviewBaseline(first, afterAssertion)).toContainEqual({
      category: "baseline",
      path: "baseline.identityReferences",
    });

    const sameId = await store.nodes.Company.create(
      { name: "new implicit peer" },
      { id: "seed" },
    );
    const afterPeer = await captureReferencedReviewBaseline(
      store,
      first.rows,
      first.identityReferences ?? [],
      first.identityAssertionIds ?? [],
    );
    expect(
      compareReviewBaseline(first, afterPeer).some(
        (difference) =>
          difference.path === "baseline.rows" &&
          difference.entity?.kind === "Company" &&
          difference.entity.id === sameId.id,
      ),
    ).toBe(true);
  });
});
