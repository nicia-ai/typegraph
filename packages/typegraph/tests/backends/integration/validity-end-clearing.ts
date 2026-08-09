import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import { createBackendOverlay } from "../../../src/backend/types";
import { requireDefined } from "../../../src/utils/presence";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

const END = "2100-01-01T00:00:00.000Z";

export function registerValidityEndClearingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("clearValidTo", () => {
    it("reopens nodes through update, upsertById, and bulkUpsertById", async () => {
      const store = await context.createStore(
        defineGraph({
          id: "clear_valid_to_nodes",
          nodes: {
            Person: {
              type: defineNode("Person", {
                schema: z.object({ name: z.string() }),
              }),
            },
          },
          edges: {},
        }),
        { coalesceUnchangedUpserts: true },
      );

      const updatedSeed = await store.nodes.Person.create(
        { name: "updated" },
        { id: "updated", validTo: END },
      );
      const updated = await store.nodes.Person.update(
        updatedSeed.id,
        {},
        { clearValidTo: true },
      );
      expect(updated.meta.validTo).toBeUndefined();

      await store.nodes.Person.create(
        { name: "single" },
        { id: "single", validTo: END },
      );
      const single = await store.nodes.Person.upsertById(
        "single",
        { name: "single" },
        { clearValidTo: true },
      );
      expect(single.meta.validTo).toBeUndefined();
      const replay = await store.nodes.Person.upsertById(
        "single",
        { name: "single" },
        { clearValidTo: true },
      );
      expect(replay.meta.version).toBe(single.meta.version);
      expect(replay.meta.updatedAt).toBe(single.meta.updatedAt);

      await store.nodes.Person.create(
        { name: "bulk" },
        { id: "bulk", validTo: END },
      );
      const [bulk] = await store.nodes.Person.bulkUpsertById([
        {
          id: "bulk",
          props: { name: "bulk" },
          clearValidTo: true,
        },
      ]);
      expect(requireDefined(bulk).meta.validTo).toBeUndefined();

      const resurrectSeed = await store.nodes.Person.create(
        { name: "resurrect" },
        { id: "resurrect", validTo: END },
      );
      await store.nodes.Person.delete(resurrectSeed.id);
      const resurrected = await store.nodes.Person.upsertById(
        resurrectSeed.id,
        { name: "resurrect" },
        { clearValidTo: true },
      );
      expect(resurrected.meta.deletedAt).toBeUndefined();
      expect(resurrected.meta.validTo).toBeUndefined();
    });

    it("reopens edges through every update surface", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      const directSeed = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "direct" },
        { validTo: END },
      );
      const direct = await store.edges.worksAt.update(
        directSeed.id,
        {},
        { clearValidTo: true },
      );
      expect(direct.meta.validTo).toBeUndefined();

      const bulkSeed = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "bulk" },
        { validTo: END },
      );
      const [bulk] = await store.edges.worksAt.bulkUpsertById([
        {
          id: bulkSeed.id,
          from: alice,
          to: acme,
          props: { role: "bulk" },
          clearValidTo: true,
        },
      ]);
      expect(requireDefined(bulk).meta.validTo).toBeUndefined();

      const singleEndpointSeed = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "endpoint-single" },
        { validTo: END },
      );
      const singleEndpoint = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "endpoint-single" },
        {
          matchOn: ["role"],
          ifExists: "update",
          clearValidTo: true,
        },
      );
      expect(singleEndpoint.edge.id).toBe(singleEndpointSeed.id);
      expect(singleEndpoint.edge.meta.validTo).toBeUndefined();

      const bulkEndpointSeed = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "endpoint-bulk" },
        { validTo: END },
      );
      const [bulkEndpoint] =
        await store.edges.worksAt.bulkGetOrCreateByEndpoints(
          [
            {
              from: alice,
              to: acme,
              props: { role: "endpoint-bulk" },
              clearValidTo: true,
            },
          ],
          { matchOn: ["role"], ifExists: "update" },
        );
      expect(requireDefined(bulkEndpoint).edge.id).toBe(bulkEndpointSeed.id);
      expect(requireDefined(bulkEndpoint).edge.meta.validTo).toBeUndefined();

      const resurrectSeed = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "resurrect" },
        { validTo: END },
      );
      await store.edges.worksAt.delete(resurrectSeed.id);
      const resurrected = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "resurrect" },
        {
          matchOn: ["role"],
          ifExists: "update",
          clearValidTo: true,
        },
      );
      expect(resurrected.action).toBe("resurrected");
      expect(resurrected.edge.meta.deletedAt).toBeUndefined();
      expect(resurrected.edge.meta.validTo).toBeUndefined();
    });

    it("refuses clearValidTo when endpoint return mode finds a live edge", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Return Alice" });
      const acme = await store.nodes.Company.create({ name: "Return Acme" });
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "ended" },
        { validTo: END },
      );

      await expect(
        store.edges.worksAt.getOrCreateByEndpoints(
          alice,
          acme,
          { role: "ended" },
          { matchOn: ["role"], clearValidTo: true },
        ),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        details: { code: "CLEAR_VALID_TO_REQUIRES_UPDATE" },
      });
      await expect(
        store.edges.worksAt.bulkGetOrCreateByEndpoints(
          [
            {
              from: alice,
              to: acme,
              props: { role: "ended" },
              clearValidTo: true,
            },
          ],
          { matchOn: ["role"] },
        ),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        details: { code: "CLEAR_VALID_TO_REQUIRES_UPDATE" },
      });
    });

    it("re-checks oneActive when an ended edge becomes open", async () => {
      const Person = defineNode("Person", {
        schema: z.object({ name: z.string() }),
      });
      const Company = defineNode("Company", {
        schema: z.object({ name: z.string() }),
      });
      const worksAt = defineEdge("worksAt", {
        schema: z.object({ role: z.string() }),
      });
      const store = await context.createStore(
        defineGraph({
          id: "clear_valid_to_one_active",
          nodes: { Person: { type: Person }, Company: { type: Company } },
          edges: {
            worksAt: {
              type: worksAt,
              from: [Person],
              to: [Company],
              cardinality: "oneActive",
            },
          },
        }),
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const first = await store.nodes.Company.create({ name: "First" });
      const second = await store.nodes.Company.create({ name: "Second" });
      const ended = await store.edges.worksAt.create(
        alice,
        first,
        { role: "old" },
        { validTo: END },
      );
      const deletedOpen = await store.edges.worksAt.create(alice, first, {
        role: "deleted-open",
      });
      await store.edges.worksAt.delete(deletedOpen.id);
      await store.edges.worksAt.create(alice, second, { role: "current" });

      await expect(
        store.edges.worksAt.update(ended.id, {}, { clearValidTo: true }),
      ).rejects.toMatchObject({ name: "CardinalityError" });
      const unchanged = await store.edges.worksAt.getById(ended.id, {
        temporalMode: "includeEnded",
      });
      expect(unchanged?.meta.validTo).toBe(END);

      await expect(
        store.edges.worksAt.bulkUpsertById([
          {
            id: deletedOpen.id,
            from: alice,
            to: first,
            props: { role: "deleted-open" },
            clearValidTo: true,
          },
        ]),
      ).rejects.toMatchObject({ name: "CardinalityError" });
      const stillDeleted = await store.edges.worksAt.getById(deletedOpen.id, {
        temporalMode: "includeTombstones",
      });
      expect(stillDeleted?.meta.deletedAt).toBeDefined();
    });

    it("refuses a custom backend that does not promise to apply clearing", async () => {
      const base = context.getBackend();
      const backend = createBackendOverlay(base, {
        capabilities: { ...base.capabilities, clearValidTo: false },
      });
      const store = createStore(integrationTestGraph, backend, {
        coalesceUnchangedUpserts: true,
      });
      const person = await store.nodes.Person.create(
        { name: "Custom" },
        { validTo: END },
      );

      await expect(
        store.nodes.Person.update(person.id, {}, { clearValidTo: true }),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        details: { code: "CLEAR_VALID_TO_UNSUPPORTED" },
      });
      const unchanged = await store.nodes.Person.getById(person.id, {
        temporalMode: "includeEnded",
      });
      expect(unchanged?.meta.validTo).toBe(END);

      const open = await store.nodes.Person.create({ name: "Open" });
      await expect(
        store.nodes.Person.upsertById(
          open.id,
          { name: "Open" },
          { clearValidTo: true },
        ),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        details: { code: "CLEAR_VALID_TO_UNSUPPORTED" },
      });
    });

    it("reports invalid direct clears through operation hooks", async () => {
      const events: string[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onOperationStart: (ctx) => {
            events.push(`start:${ctx.operationId}`);
          },
          onError: (ctx, error) => {
            events.push(`error:${ctx.operationId}:${error.name}`);
          },
        },
      });
      const person = await store.nodes.Person.create({ name: "Hooked" });
      events.length = 0;

      await expect(
        store.nodes.Person.update(person.id, {}, {
          validTo: END,
          clearValidTo: true,
        } as never),
      ).rejects.toMatchObject({ name: "ValidationError" });
      expect(events).toHaveLength(2);
      expect(events[0]).toMatch(/^start:/);
      expect(events[1]).toBe(
        `error:${events[0]?.slice("start:".length)}:ValidationError`,
      );
    });

    it("records reopen writes in transaction receipts", async () => {
      const store = await context.createHistoryStore(integrationTestGraph);
      const alice = await store.nodes.Person.create(
        { name: "Receipt Alice" },
        { validTo: END },
      );
      const bob = await store.nodes.Person.create({ name: "Receipt Bob" });
      const edge = await store.edges.knows.create(
        alice,
        bob,
        {},
        { validTo: END },
      );

      const outcome = await store.transactionWithReceipt(async (tx) => {
        await tx.nodes.Person.update(alice.id, {}, { clearValidTo: true });
        await tx.edges.knows.update(edge.id, {}, { clearValidTo: true });
      });

      expect(outcome.receipt.writes.nodes).toEqual({ Person: 1 });
      expect(outcome.receipt.writes.edges).toEqual({ knows: 1 });
      expect(outcome.receipt.writes.total).toBe(2);
      expect(outcome.receipt.recorded).toBeDefined();
    });
  });
}
