/**
 * End-to-end contract for INTRA-cluster edges: when entity resolution collapses
 * two duplicates that are themselves connected by an edge, the edge survives as
 * a SELF-EDGE on the canonical node — it is never dropped (only edges to
 * finally-deleted endpoints drop), and a reversed pair dedupes to one edge.
 *
 * This pins the committed-graph shape for the importer-dedupe case: a source
 * that records a relationship between two spellings of the same entity (e.g. a
 * "knows"/"duplicateOf" link) keeps that relationship through the collapse
 * rather than silently losing it. The unit-level repoint mechanics live in
 * `edge-repoint.test.ts`; this suite proves the same contract through
 * `merge()` and the committed store on both backends.
 */

import type { GraphBackend, Node, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { rowPropsToObject } from "../../src/backend/types";
import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import {
  enumerateAllEdges,
  enumerateAllNodes,
} from "../../src/graph-merge/state-diff";
import type {
  BranchId,
  GraphBranch,
  MergeOptions,
  SimilarityStrategy,
} from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    birthDate: z.string(),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
  from: [Person],
  to: [Person],
});

const socialGraph = defineGraph({
  id: "self-edge-collapse-graph",
  nodes: { Person: { type: Person } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
  },
});

type SocialGraph = typeof socialGraph;

const DEMO_THRESHOLD = 0.85;
const BRANCH_A = asBranchId("branch-a");

/** In-memory Dice trigram over `Person.name` (no embeddings). */
const personNameSimilarity: SimilarityStrategy<SocialGraph> = {
  kind: "fulltext",
  fields: ["name"],
};

/** Blocks persons by shared birthDate, bounding the O(n²) comparisons. */
function blockByBirthDate(node: Node): string | undefined {
  return (node as unknown as { birthDate?: string }).birthDate;
}

function selfEdgeMergeOptions(): MergeOptions<SocialGraph> {
  return {
    resolve: {
      Person: {
        block: (node) => blockByBirthDate(node),
        similarity: personNameSimilarity,
        threshold: DEMO_THRESHOLD,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: [BRANCH_A],
  };
}

/** Live `{ id, name }` for every Person, sorted by id. */
async function livePersons(
  store: Store<SocialGraph>,
): Promise<readonly Readonly<{ id: string; name: unknown }>[]> {
  const rows = await enumerateAllNodes(store.backend, store.graphId, "Person");
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => {
      const props = rowPropsToObject(row.props);
      return { id: row.id, name: props.name };
    })
    .sort((left, right) =>
      left.id < right.id ? -1
      : left.id > right.id ? 1
      : 0,
    );
}

/** Live `{ id, from, to }` for every `knows` edge, sorted by id. */
async function liveKnows(
  store: Store<SocialGraph>,
): Promise<readonly Readonly<{ id: string; from: string; to: string }>[]> {
  const rows = await enumerateAllEdges(store.backend, store.graphId, "knows");
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => ({ id: row.id, from: row.from_id, to: row.to_id }))
    .sort((left, right) =>
      left.id < right.id ? -1
      : left.id > right.id ? 1
      : 0,
    );
}

describe.each(backendMatrix())(
  "merge — intra-cluster self-edge collapse [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    beforeEach(() => {
      cleanups = [];
    });

    afterEach(async () => {
      for (const cleanup of cleanups) {
        await cleanup();
      }
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeBranch(
      baseStore: Store<SocialGraph>,
      id: BranchId,
    ): Promise<GraphBranch<SocialGraph>> {
      return unwrap(
        await branch<SocialGraph>(baseStore, () => makeBackend(), { id }),
      );
    }

    /**
     * One branch stages two near-duplicate persons ("Anna Rivera" / "Ana
     * Rivera", same birthDate block, Dice 0.857 ≥ 0.85 → MUST cluster) plus the
     * given `knows` edges between them. Canonical is the min id, "p-ana".
     */
    async function seedDuplicatesWithEdges(
      edges: readonly Readonly<{
        id: string;
        from: string;
        to: string;
      }>[],
    ): Promise<
      Readonly<{
        baseStore: Store<SocialGraph>;
        branchA: GraphBranch<SocialGraph>;
      }>
    > {
      const [baseStore] = await createStoreWithSchema(
        socialGraph,
        await makeBackend(),
      );
      const branchA = await makeBranch(baseStore, BRANCH_A);

      await branchA.store.nodes.Person.bulkCreate([
        {
          id: "p-anna",
          props: { name: "Anna Rivera", birthDate: "1974-03-09" },
        },
        {
          id: "p-ana",
          props: { name: "Ana Rivera", birthDate: "1974-03-09" },
        },
      ]);
      await branchA.store.edges.knows.bulkCreate(
        edges.map((edge) => ({
          id: edge.id,
          from: { kind: "Person", id: edge.from },
          to: { kind: "Person", id: edge.to },
          props: { since: "2020" },
        })),
      );

      return { baseStore, branchA };
    }

    it("keeps an edge between two resolved duplicates as a self-edge on the canonical", async () => {
      const { baseStore, branchA } = await seedDuplicatesWithEdges([
        { id: "e-knows", from: "p-anna", to: "p-ana" },
      ]);

      const result = await merge<SocialGraph>(
        baseStore,
        [branchA],
        selfEdgeMergeOptions(),
      );

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }

      // The duplicates collapsed into the min-id canonical...
      expect(result.data.resolutions).toHaveLength(1);
      const resolution = result.data.resolutions[0]!;
      expect(resolution.canonicalId).toBe("p-ana");
      expect([...resolution.memberIds].sort()).toEqual(["p-ana", "p-anna"]);
      expect(await livePersons(baseStore)).toEqual([
        { id: "p-ana", name: "Ana Rivera" },
      ]);

      // ...and the edge BETWEEN them survives as a self-edge, never dropped.
      expect(result.data.dropped).toEqual([]);
      expect(await liveKnows(baseStore)).toEqual([
        { id: "e-knows", from: "p-ana", to: "p-ana" },
      ]);
    });

    it("dedupes a reversed equal-props edge pair between duplicates into ONE self-edge", async () => {
      const { baseStore, branchA } = await seedDuplicatesWithEdges([
        { id: "e-1", from: "p-anna", to: "p-ana" },
        { id: "e-2", from: "p-ana", to: "p-anna" },
      ]);

      const result = await merge<SocialGraph>(
        baseStore,
        [branchA],
        selfEdgeMergeOptions(),
      );

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }

      // Both directions repoint to (p-ana, knows, p-ana) with equal props, so
      // they dedupe to the min-id survivor: direction is unrecoverable once the
      // endpoints collapse, and no edge-level conflict is recorded.
      expect(result.data.dropped).toEqual([]);
      expect(
        result.data.conflicts.filter((conflict) => conflict.kind === "knows"),
      ).toEqual([]);
      expect(await liveKnows(baseStore)).toEqual([
        { id: "e-1", from: "p-ana", to: "p-ana" },
      ]);
    });
  },
);
