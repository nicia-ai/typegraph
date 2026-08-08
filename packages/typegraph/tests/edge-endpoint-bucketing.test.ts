/**
 * Regression coverage for `endpointKey` bucketing in the edge collection
 * (src/store/collections/edge-collection.ts): `bulkFindFrom` / `bulkFindTo`
 * group result rows per input endpoint, and the bucket key joining
 * `${kind}` and `${id}` was a NUL-delimited string. A kind/id pair on
 * one input can straddle that separator identically to a DIFFERENT kind/id
 * pair on another input (kind "A<NUL>B" with id "C" vs kind "A" with id
 * "B<NUL>C"), so a delimiter join is not injective; the fix routes the key
 * through `encodeTupleKey`.
 *
 * The defect is in JS-level bucketing and is backend-agnostic, but the
 * colliding fixture requires NUL-bearing kind/id values, which PostgreSQL
 * cannot store in `text` (22P05) and libsql's protocol also rejects. It
 * therefore lives here as a better-sqlite3-backed unit test instead of in the
 * shared cross-backend suite (tests/backends/integration/edge-operations.ts).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { createTestBackend } from "./test-utils";

const NUL = "\u0000";

const EndpointKeyKindAB = defineNode(`A${NUL}B`, {
  schema: z.object({ tag: z.string() }),
});

const EndpointKeyKindA = defineNode("A", {
  schema: z.object({ tag: z.string() }),
});

const EndpointKeyTarget = defineNode("EndpointKeyTarget", {
  schema: z.object({}),
});

const endpointKeyLinksTo = defineEdge("endpointKeyLinksTo", {
  schema: z.object({}),
});

const endpointKeyCollisionGraph = defineGraph({
  id: "endpoint_key_collision_test",
  nodes: {
    [`A${NUL}B`]: { type: EndpointKeyKindAB },
    A: { type: EndpointKeyKindA },
    EndpointKeyTarget: { type: EndpointKeyTarget },
  },
  edges: {
    endpointKeyLinksTo: {
      type: endpointKeyLinksTo,
      from: [EndpointKeyKindAB, EndpointKeyKindA],
      to: [EndpointKeyTarget],
      cardinality: "many",
    },
  },
});

describe("edge collection endpoint bucketing", () => {
  it("buckets bulkFindFrom results per input even when endpoint kind/id pairs would collide under a delimiter-joined key", async () => {
    const [store] = await createStoreWithSchema(
      endpointKeyCollisionGraph,
      createTestBackend(),
    );

    const sourceAB = await store.nodes[`A${NUL}B`].create(
      { tag: "AB" },
      { id: "C" },
    );
    const sourceA = await store.nodes.A.create(
      { tag: "A" },
      { id: `B${NUL}C` },
    );
    const target = await store.nodes.EndpointKeyTarget.create({});

    const edgeFromAB = await store.edges.endpointKeyLinksTo.create(
      sourceAB,
      target,
      {},
    );
    const edgeFromA = await store.edges.endpointKeyLinksTo.create(
      sourceA,
      target,
      {},
    );

    const [bucketAB, bucketA] =
      await store.edges.endpointKeyLinksTo.bulkFindFrom([sourceAB, sourceA]);

    expect(bucketAB?.map((edge) => edge.id)).toEqual([edgeFromAB.id]);
    expect(bucketA?.map((edge) => edge.id)).toEqual([edgeFromA.id]);
  });
});
