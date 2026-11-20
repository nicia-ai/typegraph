/**
 * Cross-backend coverage for weighted-shortest-path extraction (T7): the
 * recursive-CTE extractor (`extractPathFromWorkingTable`), the predecessor-
 * walk fallback (`extractPathByPredecessorWalk`), and the inline (no
 * temporary tables) path all reproduce the same behavior on the same
 * fixtures, because `selectCheapestTargetRowSql` is the one owner both SQL
 * extractors call for the tie-break decision (§5.1.3 of the design).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import type { GraphBackend } from "../../../src/backend/types";
import {
  countWeightedExtractionStatements,
  createStatementCountingBackend,
} from "../../statement-counting-backend";
import { refuseRecursiveTraversal } from "./capability-refusals";
import { type IntegrationTestContext } from "./test-context";

const ExtractionPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const ExtractionTask = defineNode("Task", {
  schema: z.object({ title: z.string() }),
});
const extractionRoad = defineEdge("road", {
  schema: z.object({ cost: z.number() }),
});

/**
 * `Person`/`Task` with a `road` edge that can carry both target kinds, so
 * the tie-break fixture below can seed a distance tie between two nodes of
 * different kinds that share the target id.
 */
const weightedExtractionGraph = defineGraph({
  id: "weighted_extraction",
  nodes: {
    Person: { type: ExtractionPerson },
    Task: { type: ExtractionTask },
  },
  edges: {
    road: {
      type: extractionRoad,
      from: [ExtractionPerson],
      to: [ExtractionPerson, ExtractionTask],
    },
  },
});

const REASON = "test engine has no recursive CTE";

const WEIGHTED_EXTRACTION_OPTIONS = {
  edges: ["road"],
  weightProperty: "cost",
} as const;

type ExtractionStores = Readonly<{
  /** Recursive-CTE extractor: the bundled declaration, unmodified. */
  recursive: Store<typeof weightedExtractionGraph>;
  /** Predecessor-walk fallback: a recursion-absent declaration. */
  walk: Store<typeof weightedExtractionGraph>;
  /** Inline (no temporary tables) path: no interactive transaction support. */
  inline: Store<typeof weightedExtractionGraph>;
}>;

/**
 * Three stores over the same base backend, one per execution path, so a
 * single seed is read through all three extractors (the shape
 * `capability-refusals.ts` already uses for its cross-backend refusal rows).
 */
async function createExtractionStores(
  base: GraphBackend,
): Promise<ExtractionStores> {
  const [recursive] = await createStoreWithSchema(
    weightedExtractionGraph,
    base,
    {},
  );
  const walk = createStore(
    weightedExtractionGraph,
    refuseRecursiveTraversal(base, REASON),
  );
  const inline = createStore(
    weightedExtractionGraph,
    deriveBackend(projectGraphBackend(base), {
      capabilities: {
        ...base.capabilities,
        execution: {
          ...base.capabilities.execution,
          interactiveTransactions: false,
        },
      },
    }),
  );
  return { recursive, walk, inline };
}

export function registerWeightedShortestPathExtractionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("weighted-shortest-path extraction", () => {
    it("resolves a distance tie between two kinds identically through all three extractors", async () => {
      const base = context.getStore().backend;
      const { recursive, walk, inline } = await createExtractionStores(base);

      const targetId = "wsp-extraction-tie-target";
      const a = await recursive.nodes.Person.create({ name: "TieA" });
      const b = await recursive.nodes.Person.create({ name: "TieB" });
      const taskTarget = await recursive.nodes.Task.create(
        { title: "TieTargetTask" },
        { id: targetId },
      );
      const personTarget = await recursive.nodes.Person.create(
        { name: "TieTargetPerson" },
        { id: targetId },
      );
      await recursive.edges.road.create(a, taskTarget, { cost: 2 });
      await recursive.edges.road.create(a, b, { cost: 1 });
      await recursive.edges.road.create(b, personTarget, { cost: 1 });

      const recursivePath = await recursive.algorithms.weightedShortestPath(
        a,
        targetId,
        WEIGHTED_EXTRACTION_OPTIONS,
      );
      const walkPath = await walk.algorithms.weightedShortestPath(
        a,
        targetId,
        WEIGHTED_EXTRACTION_OPTIONS,
      );
      const inlinePath = await inline.algorithms.weightedShortestPath(
        a,
        targetId,
        WEIGHTED_EXTRACTION_OPTIONS,
      );

      expect(recursivePath?.totalWeight).toBe(2);
      expect(recursivePath?.depth).toBe(2);
      expect(recursivePath?.nodes.at(-1)).toEqual({
        id: targetId,
        kind: "Person",
      });
      expect(walkPath).toEqual(recursivePath);
      expect(inlinePath).toEqual(recursivePath);
    });

    it("terminates on the source row's NULL predecessor in all three extractors", async () => {
      const base = context.getStore().backend;
      const { recursive, walk, inline } = await createExtractionStores(base);

      const source = await recursive.nodes.Person.create({ name: "ChainS" });
      const middle = await recursive.nodes.Person.create({ name: "ChainM" });
      const target = await recursive.nodes.Person.create({ name: "ChainT" });
      await recursive.edges.road.create(source, middle, { cost: 1 });
      await recursive.edges.road.create(middle, target, { cost: 1 });

      const expectedNodes = [
        { id: source.id, kind: "Person" },
        { id: middle.id, kind: "Person" },
        { id: target.id, kind: "Person" },
      ];

      const recursivePath = await recursive.algorithms.weightedShortestPath(
        source,
        target,
        WEIGHTED_EXTRACTION_OPTIONS,
      );
      const walkPath = await walk.algorithms.weightedShortestPath(
        source,
        target,
        WEIGHTED_EXTRACTION_OPTIONS,
      );
      const inlinePath = await inline.algorithms.weightedShortestPath(
        source,
        target,
        WEIGHTED_EXTRACTION_OPTIONS,
      );

      for (const path of [recursivePath, walkPath, inlinePath]) {
        expect(path?.nodes).toEqual(expectedNodes);
        expect(path?.depth).toBe(2);
      }
    });

    it("issues the recursive extraction on the bundled declaration and the walk on a recursion-absent one", async () => {
      const base = context.getStore().backend;
      const [schemaStore] = await createStoreWithSchema(
        weightedExtractionGraph,
        base,
        {},
      );
      const source = await schemaStore.nodes.Person.create({
        name: "CountS",
      });
      const middle = await schemaStore.nodes.Person.create({
        name: "CountM",
      });
      const target = await schemaStore.nodes.Person.create({
        name: "CountT",
      });
      await schemaStore.edges.road.create(source, middle, { cost: 1 });
      await schemaStore.edges.road.create(middle, target, { cost: 1 });

      const recursiveStatements: string[] = [];
      const recursiveStore = createStore(
        weightedExtractionGraph,
        createStatementCountingBackend(
          projectGraphBackend(base),
          recursiveStatements,
        ),
      );
      const recursivePath =
        await recursiveStore.algorithms.weightedShortestPath(
          source,
          target,
          WEIGHTED_EXTRACTION_OPTIONS,
        );

      const walkStatements: string[] = [];
      const walkStore = createStore(
        weightedExtractionGraph,
        createStatementCountingBackend(
          refuseRecursiveTraversal(base, REASON),
          walkStatements,
        ),
      );
      const walkPath = await walkStore.algorithms.weightedShortestPath(
        source,
        target,
        WEIGHTED_EXTRACTION_OPTIONS,
      );

      expect(countWeightedExtractionStatements(recursiveStatements)).toEqual({
        recursive: 1,
        walk: 0,
      });
      // 3 = depth (2) + 1 = the 3-node path's length: one selection plus
      // one primary-key point read per hop back to the source.
      expect(countWeightedExtractionStatements(walkStatements)).toEqual({
        recursive: 0,
        walk: 3,
      });
      expect(walkPath).toEqual(recursivePath);
    });
  });
}
