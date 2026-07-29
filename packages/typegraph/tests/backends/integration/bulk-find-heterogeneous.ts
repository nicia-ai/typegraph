import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  KindNotFoundError,
  ValidationError,
} from "../../../src";
import { type IntegrationTestContext } from "./test-context";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const Project = defineNode("Project", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});
const owns = defineEdge("owns", {
  schema: z.object({ share: z.number() }),
});
const dependsOn = defineEdge("dependsOn", {
  schema: z.object({ reason: z.string() }),
});

const graph = defineGraph({
  id: "bulk_find_heterogeneous",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    Project: { type: Project },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
    owns: { type: owns, from: [Person, Company], to: [Project] },
    dependsOn: { type: dependsOn, from: [Project], to: [Project] },
  },
});

export function registerBulkFindHeterogeneousIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("bulkFindEdgesFrom", () => {
    it("reads several source and edge kinds through one backend call", async () => {
      const store = await context.createStore(graph);
      const ada = await store.nodes.Person.create({ name: "Ada" });
      const nicia = await store.nodes.Company.create({ name: "Nicia" });
      const runtime = await store.nodes.Project.create({ name: "Runtime" });
      await store.edges.worksAt.create(ada, nicia, { role: "engineer" });
      await store.edges.owns.create(ada, runtime, { share: 0.25 });
      await store.edges.owns.create(nicia, runtime, { share: 1 });
      await store.edges.dependsOn.create(runtime, runtime, {
        reason: "bootstrap",
      });

      const backend = context.getBackend();
      const spy = vi.spyOn(backend, "findEdgesByHeterogeneousEndpointSet");
      try {
        const result = await store.bulkFindEdgesFrom({
          sources: [
            { kind: "Person", ids: [ada.id] },
            { kind: "Company", ids: [nicia.id] },
            { kind: "Project", ids: [runtime.id] },
          ],
          edgeKinds: ["worksAt", "owns", "dependsOn"],
        });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(result.map((entry) => entry.source.kind)).toEqual([
          "Person",
          "Company",
          "Project",
        ]);
        expect(result[0]?.edges.map((edge) => edge.kind).toSorted()).toEqual([
          "owns",
          "worksAt",
        ]);
        expect(result[1]?.edges.map((edge) => edge.kind)).toEqual(["owns"]);
        expect(result[2]?.edges.map((edge) => edge.kind)).toEqual([
          "dependsOn",
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it("preserves empty and repeated source buckets", async () => {
      const store = await context.createStore(graph);
      const ada = await store.nodes.Person.create({ name: "Ada" });
      const grace = await store.nodes.Person.create({ name: "Grace" });
      const nicia = await store.nodes.Company.create({ name: "Nicia" });
      await store.edges.worksAt.create(ada, nicia, { role: "engineer" });

      const result = await store.bulkFindEdgesFrom({
        sources: [{ kind: "Person", ids: [ada.id, grace.id, ada.id] }],
        edgeKinds: ["worksAt"],
      });

      expect(result.map((entry) => entry.edges.length)).toEqual([1, 0, 1]);
      expect(result[0]?.edges).not.toBe(result[2]?.edges);
    });

    it("applies one per-source cap across selected edge kinds", async () => {
      const store = await context.createStore(graph);
      const ada = await store.nodes.Person.create({ name: "Ada" });
      const nicia = await store.nodes.Company.create({ name: "Nicia" });
      const runtime = await store.nodes.Project.create({ name: "Runtime" });
      await store.edges.worksAt.create(ada, nicia, { role: "engineer" });
      await store.edges.owns.create(ada, runtime, { share: 0.25 });

      const [result] = await store.bulkFindEdgesFrom(
        {
          sources: [{ kind: "Person", ids: [ada.id] }],
          edgeKinds: ["worksAt", "owns"],
        },
        { limitPerInput: 1 },
      );

      expect(result?.edges).toHaveLength(1);
    });

    it("rejects a non-positive per-source cap", async () => {
      const store = await context.createStore(graph);
      const ada = await store.nodes.Person.create({ name: "Ada" });

      await expect(
        store.bulkFindEdgesFrom(
          {
            sources: [{ kind: "Person", ids: [ada.id] }],
            edgeKinds: ["worksAt"],
          },
          { limitPerInput: 0 },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("validates dynamic node and edge kinds before reading", async () => {
      const store = await context.createStore(graph);

      await expect(
        store.bulkFindEdgesFrom({
          sources: [{ kind: "Missing", ids: ["node-1"] }],
          edgeKinds: ["worksAt"],
        } as never),
      ).rejects.toBeInstanceOf(KindNotFoundError);
      await expect(
        store.bulkFindEdgesFrom({
          sources: [],
          edgeKinds: ["missing"],
        } as never),
      ).rejects.toBeInstanceOf(KindNotFoundError);
    });

    it("honors a StoreView temporal coordinate", async () => {
      const store = await context.createStore(graph);
      const ada = await store.nodes.Person.create({ name: "Ada" });
      const nicia = await store.nodes.Company.create({ name: "Nicia" });
      await store.edges.worksAt.create(
        ada,
        nicia,
        { role: "engineer" },
        {
          validFrom: "2019-01-01T00:00:00.000Z",
          validTo: "2020-01-01T00:00:00.000Z",
        },
      );

      const [past] = await store
        .asOf("2019-06-01T00:00:00.000Z")
        .bulkFindEdgesFrom({
          sources: [{ kind: "Person", ids: [ada.id] }],
          edgeKinds: ["worksAt"],
        });
      const [current] = await store.bulkFindEdgesFrom({
        sources: [{ kind: "Person", ids: [ada.id] }],
        edgeKinds: ["worksAt"],
      });

      expect(past?.edges).toHaveLength(1);
      expect(current?.edges).toEqual([]);
    });

    it("returns empty buckets without requiring the backend capability", async () => {
      const store = await context.createStore(graph);
      const ada = await store.nodes.Person.create({ name: "Ada" });
      const backend = context.getBackend();
      const spy = vi.spyOn(backend, "findEdgesByHeterogeneousEndpointSet");
      try {
        await expect(
          store.bulkFindEdgesFrom({ sources: [], edgeKinds: ["worksAt"] }),
        ).resolves.toEqual([]);
        await expect(
          store.bulkFindEdgesFrom({
            sources: [{ kind: "Person", ids: [ada.id] }],
            edgeKinds: [],
          }),
        ).resolves.toEqual([
          { source: { kind: "Person", id: ada.id }, edges: [] },
        ]);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
}
