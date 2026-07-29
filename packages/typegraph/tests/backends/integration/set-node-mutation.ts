import { describe, expect, it } from "vitest";

import { ConfigurationError } from "../../../src";
import type {
  GraphBackend,
  UpdateNodeSetParams,
} from "../../../src/backend/types";
import { rowPropsToObject } from "../../../src/backend/types";
import type { QueryAst } from "../../../src/query/ast";
import { compileQuery } from "../../../src/query/compiler";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { requireDefined } from "../../../src/utils/presence";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

function compileCandidateIds(
  graphId: string,
  backend: Pick<
    GraphBackend,
    | "capabilities"
    | "dialect"
    | "fulltextStrategy"
    | "tableNames"
    | "vectorStrategy"
  >,
  ast: QueryAst,
) {
  return compileQuery(ast, graphId, {
    dialect: backend.dialect,
    schema: createSqlSchema(backend.tableNames),
    fulltextStrategy: backend.fulltextStrategy,
    vectorStrategy: backend.vectorStrategy,
    windowFunctions: backend.capabilities.windowFunctions,
  });
}

async function updateNodeSet(
  backend: Pick<GraphBackend, "updateNodeSet">,
  params: UpdateNodeSetParams,
) {
  return requireDefined(backend.updateNodeSet)(params);
}

/**
 * Shared SQLite/PostgreSQL coverage for the storage primitive that the public
 * set-based Store mutation composes with validation and sidecar maintenance.
 */
export function registerSetNodeMutationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("set-based node mutation substrate", () => {
    it("updates nodes selected by property and relationship predicates", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const acme = await store.nodes.Company.create({
        name: "Acme",
        industry: "technology",
      });
      const bank = await store.nodes.Company.create({
        name: "Bank",
        industry: "finance",
      });
      const alice = await store.nodes.Person.create({ name: "Alice", age: 35 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 35 });
      const cara = await store.nodes.Person.create({ name: "Cara", age: 25 });
      await store.edges.worksAt.create(alice, acme, { role: "engineer" });
      await store.edges.worksAt.create(bob, bank, { role: "analyst" });
      await store.edges.worksAt.create(cara, acme, { role: "designer" });

      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .whereNode("person", (person) => person.age.gte(30))
          .traverse("worksAt", "employment")
          .to("Company", "company")
          .whereNode("company", (company) => company.industry.eq("technology"))
          .select((ctx) => ctx.person.id)
          .toAst(),
      );

      const result = await updateNodeSet(backend, {
        graphId: store.graphId,
        kind: "Person",
        patch: { isActive: true },
        candidateIds,
        candidateIdColumn: "person_id",
      });

      expect(result.affectedCount).toBe(1);
      expect(result.rows.map((row) => row.id)).toEqual([alice.id]);
      expect(result.rows[0]?.version).toBe(2);
      expect(
        rowPropsToObject(
          requireDefined(
            await backend.getNode(store.graphId, "Person", alice.id),
          ).props,
        ),
      ).toMatchObject({
        name: "Alice",
        age: 35,
        isActive: true,
      });
      expect(
        rowPropsToObject(
          requireDefined(await backend.getNode(store.graphId, "Person", bob.id))
            .props,
        ),
      ).not.toHaveProperty("isActive");
      expect(
        rowPropsToObject(
          requireDefined(
            await backend.getNode(store.graphId, "Person", cara.id),
          ).props,
        ),
      ).not.toHaveProperty("isActive");
    });

    it("replaces top-level values without deleting explicit JSON null", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const document = await store.nodes.Document.create({
        title: "Draft",
        metadata: { author: "Ada", reviewer: "Grace" },
      });
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Document", "document")
          .whereNode("document", (item) => item.id.eq(document.id))
          .select((ctx) => ctx.document.id)
          .toAst(),
      );

      const result = await updateNodeSet(backend, {
        graphId: store.graphId,
        kind: "Document",
        patch: {
          metadata: {
            author: "Ada",
            // eslint-disable-next-line unicorn/no-null -- explicit JSON null is the behavior under test
            reviewer: null,
            flags: { archived: true },
          },
        },
        candidateIds,
        candidateIdColumn: "document_id",
      });

      expect(result.affectedCount).toBe(1);
      expect(rowPropsToObject(requireDefined(result.rows[0]).props)).toEqual({
        title: "Draft",
        metadata: {
          author: "Ada",
          // eslint-disable-next-line unicorn/no-null -- explicit JSON null is the behavior under test
          reviewer: null,
          flags: { archived: true },
        },
      });
    });

    it("never resurrects tombstoned candidates", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const deleted = await store.nodes.Person.create({ name: "Deleted" });
      await store.nodes.Person.delete(deleted.id);
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .temporal("includeTombstones")
          .whereNode("person", (person) => person.id.eq(deleted.id))
          .select((ctx) => ctx.person.id)
          .toAst(),
      );

      const result = await updateNodeSet(backend, {
        graphId: store.graphId,
        kind: "Person",
        patch: { isActive: true },
        candidateIds,
        candidateIdColumn: "person_id",
      });

      expect(result).toEqual({ affectedCount: 0, rows: [] });
      const row = requireDefined(
        await backend.getNode(store.graphId, "Person", deleted.id),
      );
      expect(row.deleted_at).toBeDefined();
      expect(row.version).toBe(1);
    });

    it("captures every affected row in recorded-time history", async () => {
      const store = await context.createHistoryStore(integrationTestGraph);
      const backend = store.backend;
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const beforeUpdate = requireDefined(await store.recordedNow());
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .select((ctx) => ctx.person.id)
          .toAst(),
      );

      const result = await updateNodeSet(backend, {
        graphId: store.graphId,
        kind: "Person",
        patch: { isActive: true },
        candidateIds,
        candidateIdColumn: "person_id",
      });
      const afterUpdate = requireDefined(await store.recordedNow());

      expect(result.affectedCount).toBe(2);
      await expect(
        store.asOfRecorded(beforeUpdate).nodes.Person.getById(alice.id),
      ).resolves.not.toHaveProperty("isActive");
      await expect(
        store.asOfRecorded(afterUpdate).nodes.Person.getById(alice.id),
      ).resolves.toHaveProperty("isActive", true);
      await expect(
        store.asOfRecorded(afterUpdate).nodes.Person.getById(bob.id),
      ).resolves.toHaveProperty("isActive", true);
    });

    it("rejects an empty patch before executing SQL", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .select((ctx) => ctx.person.id)
          .toAst(),
      );

      await expect(
        updateNodeSet(backend, {
          graphId: store.graphId,
          kind: "Person",
          patch: {},
          candidateIds,
          candidateIdColumn: "person_id",
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });
  });
}
