import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  StoreAnalysisCursorStaleError,
} from "../../../src";
import { defineGraphExtension } from "../../../src/graph-extension";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const Audited = defineNode("Audited", {
  schema: z.strictObject({
    name: z.string().min(2),
    profile: z
      .strictObject({
        email: z.email(),
      })
      .optional(),
  }),
});

const analysisGraph = defineGraph({
  id: "store_analysis_integration",
  nodes: { Audited: { type: Audited } },
  edges: {},
});

export function registerStoreAnalysisIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Store analysis", () => {
    it("describes per-kind counts and declared-property coverage in one snapshot", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({
        name: "Alice",
        age: 30,
      });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const company = await store.nodes.Company.create({ name: "Acme" });
      await store.edges.worksAt.create(alice, company, { role: "Engineer" });

      const description = await store.describe();
      const people = description.statistics.nodes.find(
        (entry) => entry.kind === "Person",
      );
      const worksAt = description.statistics.edges.find(
        (entry) => entry.kind === "worksAt",
      );

      expect(people?.count).toBe(2);
      expect(people?.properties).toContainEqual({
        path: "/name",
        nonNullCount: 2,
        coverage: 1,
      });
      expect(people?.properties).toContainEqual({
        path: "/age",
        nonNullCount: 1,
        coverage: 0.5,
      });
      expect(worksAt?.count).toBe(1);
      expect(description.statistics.snapshot.schemaFence).toHaveLength(32);
      expect(description.statistics.snapshot.dataFence).toHaveLength(32);
      expect(description.schema.graphId).toBe(store.graphId);

      // Keep the second row observably live so an optimizer cannot replace the
      // test setup with one row while preserving the first assertions.
      expect(bob.name).toBe("Bob");
    });

    it("reports only declared-rule violations and pages them deterministically", async () => {
      const store = await context.createStore(analysisGraph);
      await store.backend.insertNode({
        graphId: analysisGraph.id,
        kind: "Audited",
        id: "bad-1",
        props: {
          name: "x",
          profile: { email: "invalid", undeclaredNested: true },
          undeclaredTopLevel: true,
        },
      });
      await store.backend.insertNode({
        graphId: analysisGraph.id,
        kind: "Audited",
        id: "bad-2",
        props: { name: 42 },
      });

      const first = await store.validateStore({
        entity: "node",
        kind: "Audited",
        pageSize: 2,
      });
      expect(first.violations).toEqual([
        expect.objectContaining({
          id: "bad-1",
          path: "/name",
          property: "name",
        }),
        expect.objectContaining({
          id: "bad-1",
          path: "/profile/email",
          property: "profile",
        }),
      ]);
      expect(
        first.violations.some((failure) =>
          failure.reason.includes("Unrecognized key"),
        ),
      ).toBe(false);

      const second = await store.validateStore({
        entity: "node",
        kind: "Audited",
        pageSize: 2,
        cursor: requireDefined(first.nextCursor),
      });
      expect(second.violations).toEqual([
        expect.objectContaining({ id: "bad-2", path: "/name" }),
      ]);
      expect(second.nextCursor).toBeUndefined();
      expect(second.snapshot).toEqual(first.snapshot);
    });

    it("rejects a cursor after scoped data changes", async () => {
      const store = await context.createStore(analysisGraph);
      for (const id of ["bad-1", "bad-2"]) {
        await store.backend.insertNode({
          graphId: analysisGraph.id,
          kind: "Audited",
          id,
          props: { name: 1 },
        });
      }
      const first = await store.validateStore({
        entity: "node",
        kind: "Audited",
        pageSize: 1,
      });
      await store.backend.deleteNode({
        graphId: analysisGraph.id,
        kind: "Audited",
        id: "bad-2",
      });

      await expect(
        store.validateStore({
          entity: "node",
          kind: "Audited",
          pageSize: 1,
          cursor: requireDefined(first.nextCursor),
        }),
      ).rejects.toBeInstanceOf(StoreAnalysisCursorStaleError);
    });

    it("rejects a cursor after the active schema changes", async () => {
      const store = await context.createStore(analysisGraph);
      for (const id of ["bad-1", "bad-2"]) {
        await store.backend.insertNode({
          graphId: analysisGraph.id,
          kind: "Audited",
          id,
          props: { name: 1 },
        });
      }
      const first = await store.validateStore({
        entity: "node",
        kind: "Audited",
        pageSize: 1,
      });
      const evolved = await store.evolve(
        defineGraphExtension({
          nodes: { Added: { properties: { label: { type: "string" } } } },
        }),
      );

      await expect(
        evolved.validateStore({
          entity: "node",
          kind: "Audited",
          pageSize: 1,
          cursor: requireDefined(first.nextCursor),
        }),
      ).rejects.toMatchObject({
        code: "STORE_ANALYSIS_CURSOR_STALE",
      });
    });

    it("refuses analysis through a Store whose reconciled schema is stale", async () => {
      const stale = await context.createStore(analysisGraph);
      const evolved = await stale.evolve(
        defineGraphExtension({
          nodes: { Added: { properties: { label: { type: "string" } } } },
        }),
      );

      await expect(stale.describe()).rejects.toMatchObject({
        code: "STALE_SCHEMA_VERSION",
        details: { expected: 1, actual: 2 },
      });
      await expect(
        stale.validateStore({ entity: "node", kind: "Audited" }),
      ).rejects.toMatchObject({ code: "STALE_SCHEMA_VERSION" });
      await expect(evolved.describe()).resolves.toMatchObject({
        statistics: { snapshot: { schemaVersion: 2 } },
      });
    });
  });
}
