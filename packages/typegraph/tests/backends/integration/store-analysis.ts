import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
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
      await store.nodes.Person.create({ name: "Bob" });
      const explicitJsonNull = JSON.parse("null") as unknown;
      await store.backend.insertNode({
        graphId: store.graphId,
        kind: "Person",
        id: "explicit-null",
        props: { name: "Null age", age: explicitJsonNull },
      });
      const company = await store.nodes.Company.create({ name: "Acme" });
      await store.edges.worksAt.create(alice, company, { role: "Engineer" });

      const description = await store.describe();
      const people = description.statistics.nodes.find(
        (entry) => entry.kind === "Person",
      );
      const worksAt = description.statistics.edges.find(
        (entry) => entry.kind === "worksAt",
      );

      expect(people?.count).toBe(3);
      expect(people?.properties).toContainEqual({
        path: "/name",
        presentCount: 3,
        nullCount: 0,
        nonNullCount: 3,
        coverage: 1,
      });
      expect(people?.properties).toContainEqual({
        path: "/age",
        presentCount: 2,
        nullCount: 1,
        nonNullCount: 1,
        coverage: 1 / 3,
      });
      expect(worksAt?.count).toBe(1);
      expect(description.statistics.snapshot.schemaFence).toHaveLength(32);
      expect(description.schema.graphId).toBe(store.graphId);
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
        pageSize: 1,
      });
      expect(first.scannedCount).toBe(1);
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
        pageSize: 1,
        cursor: requireDefined(first.nextCursor),
      });
      expect(second.scannedCount).toBe(1);
      expect(second.violations).toEqual([
        expect.objectContaining({ id: "bad-2", path: "/name" }),
      ]);
      expect(second.nextCursor).toBeUndefined();
      expect(second.snapshot).toEqual(first.snapshot);
    });

    it("uses live keyset continuation when scoped data changes", async () => {
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

      const second = await store.validateStore({
        entity: "node",
        kind: "Audited",
        pageSize: 1,
        cursor: requireDefined(first.nextCursor),
      });
      expect(second).toMatchObject({ scannedCount: 0, violations: [] });
      expect(second.nextCursor).toBeUndefined();
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
