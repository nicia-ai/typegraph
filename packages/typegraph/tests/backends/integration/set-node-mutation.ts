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
    it("exposes cross-backend property and relationship updates through the Store", async () => {
      const store = context.getStore();
      const acme = await store.nodes.Company.create({
        name: "Acme",
        industry: "technology",
      });
      const bank = await store.nodes.Company.create({
        name: "Bank",
        industry: "finance",
      });
      const alice = await store.nodes.Person.create({
        name: "Alice",
        age: 35,
        email: "alice@example.com",
      });
      const bob = await store.nodes.Person.create({
        name: "Bob",
        age: 35,
        email: "bob@example.com",
      });
      await store.edges.worksAt.create(alice, acme, { role: "engineer" });
      await store.edges.worksAt.create(bob, bank, { role: "engineer" });

      const result = await store.nodes.Person.updateWhere({
        patch: { age: 36, email: undefined },
        where: (person) => person.age.gte(30),
        exists: [
          {
            edgeKind: "worksAt",
            direction: "out",
            relatedKind: "Company",
            whereRelated: (company) =>
              company.field("industry").string().eq("technology"),
          },
        ],
      });

      expect(result).toEqual({ affectedCount: 1 });
      const updatedAlice = requireDefined(
        await store.nodes.Person.getById(alice.id),
      );
      expect(updatedAlice.age).toBe(36);
      expect(updatedAlice).not.toHaveProperty("email");
      expect(await store.nodes.Person.getById(bob.id)).toMatchObject({
        age: 35,
        email: "bob@example.com",
      });
    });

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

    it("fences colliding candidate ids to the requested graph and kind", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const sharedId = "shared-set-update-id";
      await store.nodes.Person.create({ name: "Target" }, { id: sharedId });
      await store.nodes.Company.create(
        { name: "Same graph" },
        { id: sharedId },
      );
      await backend.insertNode({
        graphId: "other_graph",
        kind: "Person",
        id: sharedId,
        props: { name: "Other graph" },
      });
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .whereNode("person", (person) => person.id.eq(sharedId))
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
      expect(
        rowPropsToObject(
          requireDefined(
            await backend.getNode(store.graphId, "Person", sharedId),
          ).props,
        ),
      ).toHaveProperty("isActive", true);
      expect(
        rowPropsToObject(
          requireDefined(
            await backend.getNode(store.graphId, "Company", sharedId),
          ).props,
        ),
      ).not.toHaveProperty("isActive");
      expect(
        rowPropsToObject(
          requireDefined(
            await backend.getNode("other_graph", "Person", sharedId),
          ).props,
        ),
      ).not.toHaveProperty("isActive");
    });

    it("keeps hard-delete uniqueness cleanup scoped to concrete node kind", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const sharedId = "shared-unique-owner-id";
      const personKey = "person@example.test";
      const companyKey = "company@example.test";
      const person = await store.nodes.Person.create(
        { name: "Person" },
        { id: sharedId },
      );
      await store.nodes.Company.create({ name: "Company" }, { id: sharedId });
      await backend.insertUnique({
        graphId: store.graphId,
        nodeKind: "Person",
        constraintName: "identity",
        key: personKey,
        nodeId: sharedId,
        concreteKind: "Person",
      });
      await backend.insertUnique({
        graphId: store.graphId,
        nodeKind: "Company",
        constraintName: "identity",
        key: companyKey,
        nodeId: sharedId,
        concreteKind: "Company",
      });

      await store.nodes.Person.hardDelete(person.id);

      await expect(
        backend.checkUnique({
          graphId: store.graphId,
          nodeKind: "Person",
          constraintName: "identity",
          key: personKey,
          includeDeleted: true,
        }),
      ).resolves.toBeUndefined();
      await expect(
        backend.checkUnique({
          graphId: store.graphId,
          nodeKind: "Company",
          constraintName: "identity",
          key: companyKey,
          includeDeleted: true,
        }),
      ).resolves.toMatchObject({
        concrete_kind: "Company",
        node_id: sharedId,
      });
    });

    it("hard-deletes uniqueness sidecars for a set of concrete nodes", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const nodeIds = ["unique-owner-a", "unique-owner-b"];
      for (const nodeId of nodeIds) {
        await backend.insertUnique({
          graphId: store.graphId,
          nodeKind: "Person",
          constraintName: "identity",
          key: `${nodeId}@example.test`,
          nodeId,
          concreteKind: "Person",
        });
      }

      await requireDefined(backend.hardDeleteUniquesByNodeIds)({
        graphId: store.graphId,
        concreteKind: "Person",
        nodeIds: [...nodeIds, "unique-owner-a"],
      });

      for (const nodeId of nodeIds) {
        await expect(
          backend.checkUnique({
            graphId: store.graphId,
            nodeKind: "Person",
            constraintName: "identity",
            key: `${nodeId}@example.test`,
            includeDeleted: true,
          }),
        ).resolves.toBeUndefined();
      }
      await expect(
        requireDefined(backend.hardDeleteUniquesByNodeIds)({
          graphId: store.graphId,
          concreteKind: "Person",
          nodeIds: [],
        }),
      ).resolves.toBeUndefined();
    });

    it("hard-deletes uniqueness sidecars for every node of a concrete kind", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      // Owned by the reaped kind at its own axis, and owned by it at an axis
      // that is not a kind at all: the member reaps by OWNER, so both go.
      await backend.insertUnique({
        graphId: store.graphId,
        nodeKind: "Person",
        constraintName: "identity",
        key: "kind-owner-a@example.test",
        nodeId: "kind-owner-a",
        concreteKind: "Person",
      });
      await backend.insertUnique({
        graphId: store.graphId,
        nodeKind: "disjoint(Company|Person)",
        constraintName: "identity",
        key: "kind-owner-b@example.test",
        nodeId: "kind-owner-b",
        concreteKind: "Person",
      });
      // Owned by another kind AT the reaped kind's axis: it stays.
      await backend.insertUnique({
        graphId: store.graphId,
        nodeKind: "Person",
        constraintName: "identity",
        key: "kind-bystander@example.test",
        nodeId: "kind-bystander",
        concreteKind: "Company",
      });

      await requireDefined(backend.hardDeleteUniquesByConcreteKind)({
        graphId: store.graphId,
        concreteKind: "Person",
      });

      await expect(
        backend.checkUnique({
          graphId: store.graphId,
          nodeKind: "Person",
          constraintName: "identity",
          key: "kind-owner-a@example.test",
          includeDeleted: true,
        }),
      ).resolves.toBeUndefined();
      await expect(
        backend.checkUnique({
          graphId: store.graphId,
          nodeKind: "disjoint(Company|Person)",
          constraintName: "identity",
          key: "kind-owner-b@example.test",
          includeDeleted: true,
        }),
      ).resolves.toBeUndefined();
      await expect(
        backend.checkUnique({
          graphId: store.graphId,
          nodeKind: "Person",
          constraintName: "identity",
          key: "kind-bystander@example.test",
          includeDeleted: true,
        }),
      ).resolves.toMatchObject({
        concrete_kind: "Company",
        node_id: "kind-bystander",
      });
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

    it("treats numeric property names as object keys on every backend", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const document = await store.nodes.Document.create({ title: "Draft" });
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
        patch: { "0": "zero", "01": "zero-one" },
        candidateIds,
        candidateIdColumn: "document_id",
      });

      expect(rowPropsToObject(requireDefined(result.rows[0]).props)).toEqual({
        title: "Draft",
        "0": "zero",
        "01": "zero-one",
      });
    });

    it("applies patches wider than SQLite's legacy function-argument limit", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const document = await store.nodes.Document.create({ title: "Draft" });
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
      const patch = Object.fromEntries(
        Array.from({ length: 70 }, (_, index) => [`field${index}`, index]),
      );

      const result = await updateNodeSet(backend, {
        graphId: store.graphId,
        kind: "Document",
        patch,
        candidateIds,
        candidateIdColumn: "document_id",
      });

      expect(rowPropsToObject(requireDefined(result.rows[0]).props)).toEqual({
        title: "Draft",
        ...patch,
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
