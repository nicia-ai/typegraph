import { describe, expect, it } from "vitest";
import { z } from "zod";

import { asNodeId, defineGraph, defineNode, type Store } from "../../../src";
import { branch } from "../../../src/graph-merge/branch";
import { applyMergePlan, planMerge } from "../../../src/graph-merge/merge";
import { constructMergePlanArtifact } from "../../../src/graph-merge/plan-wire";
import { isErr, isOk, unwrap } from "../../../src/graph-merge/result";
import { asBranchId, type GraphBranch } from "../../../src/graph-merge/types";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

const graph = defineGraph({
  id: "graph_merge_plan_integration",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

type TestStore = Store<typeof graph>;

async function makeBranch(
  context: IntegrationTestContext,
  base: TestStore,
  id: string,
): Promise<GraphBranch<typeof graph>> {
  return unwrap(
    await branch(base, () => context.createIsolatedBackend(), {
      id: asBranchId(id),
    }),
  );
}

export function registerGraphMergePlanIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("graph merge plan lifecycle", () => {
    it("preserves multi-source evidence through JSON and applies exactly once", async () => {
      const base = await context.createStore(graph, { revisionTracking: true });
      const left = await makeBranch(context, base, "left");
      const right = await makeBranch(context, base, "right");
      await left.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada-left" },
      );
      await right.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada-right" },
      );

      const artifact = unwrap(
        await planMerge(base, [left, right], {
          resolve: {
            Person: {
              block: (node) => node.email,
              similarity: { kind: "fulltext", fields: ["name"] },
              threshold: 1,
            },
          },
        }),
      );
      const evidence = requireDefined(
        requireDefined(artifact.review.resolutions[0]).decisiveEdges[0],
      );
      expect(evidence.sources.map((source) => source.kind)).toEqual([
        "block",
        "unique",
      ]);

      // The lifecycle contract specifically requires a JSON serialization boundary.
      // eslint-disable-next-line unicorn/prefer-structured-clone
      const parsed = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
      const results = await Promise.all([
        applyMergePlan(base, parsed),
        applyMergePlan(base, parsed),
      ]);
      expect(results.filter((result) => isOk(result))).toHaveLength(1);
      expect(results.filter((result) => isErr(result))).toHaveLength(1);
      expect(
        await base.nodes.Person.getById(asNodeId("ada-left")),
      ).toBeDefined();
    });

    it("preflights every rehashed write before mutating the target", async () => {
      const base = await context.createStore(graph, { revisionTracking: true });
      const source = await makeBranch(context, base, "source");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(base, [source]));
      const { digest: _digest, ...input } = artifact;
      const malformed = await constructMergePlanArtifact({
        ...input,
        writes: {
          ...input.writes,
          edgeDeletes: [{ kind: "MissingEdgeKind", id: "missing" }],
        },
        proposed: {
          ...input.proposed,
          edges: { ...input.proposed.edges, deletions: 1 },
        },
      });

      expect(isErr(await applyMergePlan(base, malformed))).toBe(true);
      expect(await base.nodes.Person.getById(asNodeId("ada"))).toBeUndefined();
    });
  });
}
