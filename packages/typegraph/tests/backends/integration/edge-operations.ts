import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import {
  EDGE_IDENTITY_MISMATCH_CODE,
  ValidationError,
} from "../../../src/errors";
import { requireDefined } from "../../../src/utils/presence";
import { expectImmutableLowerBoundRefusal } from "../../test-utils";
import { type IntegrationTestContext } from "./test-context";

/**
 * Local fixture for the `toString`-matchOn regression (issue #424): a schema
 * legitimately declares an edge prop named after an `Object.prototype`
 * member. Kept out of the shared `integrationTestGraph` (fixtures.ts) —
 * every other suite runs against that graph, and this shape is unusual by
 * design.
 */
const ProtoFieldPerson = defineNode("ProtoFieldPerson", {
  schema: z.object({ name: z.string() }),
});

const knowsWithProtoField = defineEdge("knowsWithProtoField", {
  schema: z.object({
    toString: z.string().optional(),
  }),
});

const protoFieldMatchOnGraph = defineGraph({
  id: "proto_field_matchon_test",
  nodes: { ProtoFieldPerson: { type: ProtoFieldPerson } },
  edges: {
    knowsWithProtoField: {
      type: knowsWithProtoField,
      from: [ProtoFieldPerson],
      to: [ProtoFieldPerson],
      cardinality: "many",
    },
  },
});

async function expectEdgeIdentityMismatch(
  operation: Promise<unknown>,
  expectedOperation: "update" | "delete" | "hardDelete",
): Promise<void> {
  try {
    await operation;
    throw new Error("Expected edge identity mismatch");
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) throw error;
    expect(error.details.operation).toBe(expectedOperation);
    expect(error.details.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: EDGE_IDENTITY_MISMATCH_CODE }),
      ]),
    );
  }
}

export function registerEdgeOperationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Edge Operations", () => {
    const FIRST_VALID_FROM = "2019-03-01T00:00:00.000Z";
    const FIRST_VALID_TO = "2021-08-31T23:59:59.999Z";
    const SECOND_VALID_FROM = "2022-01-01T00:00:00.000Z";
    const SECOND_VALID_TO = "2024-12-31T23:59:59.999Z";

    it("retrieves edge by ID", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
        salary: 100_000,
      });

      const retrieved = await store.edges.worksAt.getById(edge.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.role).toBe("Engineer");
      expect(retrieved?.salary).toBe(100_000);
    });

    it("returns undefined for non-existent edge ID", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      // Create an edge to get a valid branded type for casting
      await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });

      // Use type assertion to pass a non-existent ID
      const retrieved = await store.edges.worksAt.getById(
        "non-existent" as Awaited<
          ReturnType<typeof store.edges.worksAt.create>
        >["id"],
      );

      expect(retrieved).toBeUndefined();
    });

    it("refuses to mutate an edge through a collection of another kind", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const edge = await store.edges.knows.create(
        alice,
        bob,
        { since: "2020" },
        { id: "cross-kind-edge" },
      );

      await expectEdgeIdentityMismatch(
        store.edges.worksAt.update(edge.id as never, { role: "Engineer" }),
        "update",
      );
      await expectEdgeIdentityMismatch(
        store.edges.worksAt.delete(edge.id as never),
        "delete",
      );
      await expectEdgeIdentityMismatch(
        store.edges.worksAt.hardDelete(edge.id as never),
        "hardDelete",
      );
      await expectEdgeIdentityMismatch(
        store.edges.worksAt.bulkUpsertById([
          {
            id: edge.id as never,
            from: alice,
            to: bob as never,
            props: { role: "Engineer" },
          },
        ]),
        "update",
      );

      const untouched = await store.edges.knows.getById(edge.id);
      expect(untouched?.since).toBe("2020");
      expect(untouched?.meta.deletedAt).toBeUndefined();

      await store.edges.knows.delete(edge.id);
      await expectEdgeIdentityMismatch(
        store.edges.worksAt.delete(edge.id as never),
        "delete",
      );
    });

    it("refuses to bulk-delete an edge through a collection of another kind", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const edge = await store.edges.knows.create(
        alice,
        bob,
        { since: "2020" },
        { id: "cross-kind-bulk-delete" },
      );

      await expectEdgeIdentityMismatch(
        store.edges.worksAt.bulkDelete([edge.id as never]),
        "delete",
      );

      await expect(store.edges.knows.getById(edge.id)).resolves.toMatchObject({
        id: edge.id,
        since: "2020",
        meta: { deletedAt: undefined },
      });
    });

    it("rolls back every earlier delete in the batch when a later id triggers EDGE_IDENTITY_MISMATCH", async () => {
      // `executeEdgeDeleteBatch` loops over the ids inside ONE write
      // transaction, checking `assertEdgeIdentityMatches` per id — it
      // deliberately does not pre-check every id before deleting any. So when
      // a LATER id belongs to another edge kind, the guarantee that the
      // EARLIER deletes disappear has to come from the transaction rolling
      // back, not from check-ordering. That is backend behavior, hence the
      // cross-backend suite.
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const carol = await store.nodes.Person.create({ name: "Carol" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const firstKnows = await store.edges.knows.create(
        alice,
        bob,
        { since: "2020" },
        { id: "rollback-knows-1" },
      );
      const secondKnows = await store.edges.knows.create(
        alice,
        carol,
        { since: "2021" },
        { id: "rollback-knows-2" },
      );
      // A different edge kind, named LAST so the two knows deletes are already
      // applied inside the transaction when the mismatch throws.
      const employment = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { id: "rollback-works-at" },
      );

      await expectEdgeIdentityMismatch(
        store.edges.knows.bulkDelete([
          firstKnows.id,
          secondKnows.id,
          employment.id as never,
        ]),
        "delete",
      );

      for (const id of [firstKnows.id, secondKnows.id]) {
        const after = await store.edges.knows.getById(id, {
          temporalMode: "includeTombstones",
        });
        expect(after?.meta.deletedAt).toBeUndefined();
      }
      const employmentAfter = await store.edges.worksAt.getById(employment.id, {
        temporalMode: "includeTombstones",
      });
      expect(employmentAfter?.meta.deletedAt).toBeUndefined();
    });

    it("refuses bulk-upsert endpoint changes for stored and batch-local edges", async () => {
      const store = context.getStore();
      const [alice, bob, charlie] = await store.nodes.Person.bulkCreate([
        { id: "endpoint-alice", props: { name: "Alice" } },
        { id: "endpoint-bob", props: { name: "Bob" } },
        { id: "endpoint-charlie", props: { name: "Charlie" } },
      ]);
      const from = requireDefined(alice);
      const originalTo = requireDefined(bob);
      const differentTo = requireDefined(charlie);
      const existing = await store.edges.knows.create(
        from,
        originalTo,
        { since: "2020" },
        { id: "endpoint-existing" },
      );

      await expect(
        store.edges.knows.bulkUpsertById([
          {
            id: existing.id,
            from,
            to: differentTo,
            props: { since: "2021" },
          },
        ]),
      ).rejects.toThrow(ValidationError);

      await expect(
        store.edges.knows.bulkUpsertById([
          {
            id: "endpoint-new" as never,
            from,
            to: originalTo,
            props: { since: "2020" },
          },
          {
            id: "endpoint-new" as never,
            from,
            to: differentTo,
            props: { since: "2021" },
          },
        ]),
      ).rejects.toThrow(ValidationError);

      const untouched = await store.edges.knows.getById(existing.id);
      expect(untouched?.toId).toBe(originalTo.id);
      expect(untouched?.since).toBe("2020");
      expect(
        await store.edges.knows.getById("endpoint-new" as never),
      ).toBeUndefined();
    });

    it("rejects inherited prototype names in matchOn", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      // Pins the specific failure, not just "any ValidationError": a
      // ValidationError unrelated to matchOn field validation would also
      // satisfy `rejects.toThrow(ValidationError)`, so the message and
      // issues must name the rejected field.
      const attempt = store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { since: "2020" },
        { matchOn: ["toString" as never] },
      );
      await expect(attempt).rejects.toBeInstanceOf(ValidationError);
      await expect(attempt).rejects.toThrow("toString");
      await expect(attempt).rejects.toMatchObject({
        details: { issues: [{ path: "toString" }] },
      });
    });

    it("matches consistently on a matchOn field named after a prototype member when the value is absent", async () => {
      // Regression for issue #424: an edge schema may legitimately declare a
      // field named after an `Object.prototype` member (`toString`). When
      // that field is absent, `matchOn` comparisons must read it as
      // `undefined` — not the inherited prototype function that a plain
      // `props[field]` read would surface. Passing the field explicitly as
      // `undefined` (rather than omitting the key) is required here: Zod
      // itself reads a plain object literal's `toString` key through the
      // prototype chain when the key is truly absent, so the create-time
      // `schema.parse({})` throws before this code path is ever reached —
      // that is a pre-existing Zod quirk with plain-object shape probing,
      // orthogonal to the matchOn/composite-key defect this test targets.
      const store = await context.createStore(protoFieldMatchOnGraph);
      const alice = await store.nodes.ProtoFieldPerson.create({
        name: "Alice",
      });
      const bob = await store.nodes.ProtoFieldPerson.create({ name: "Bob" });

      const first =
        await store.edges.knowsWithProtoField.getOrCreateByEndpoints(
          alice,
          bob,
          { toString: undefined },
          { matchOn: ["toString"] },
        );
      const second =
        await store.edges.knowsWithProtoField.getOrCreateByEndpoints(
          alice,
          bob,
          { toString: undefined },
          { matchOn: ["toString"] },
        );

      expect(first.action).toBe("created");
      expect(second.action).toBe("found");
      expect(second.edge.id).toBe(first.edge.id);
    });

    // The `endpointKey` delimiter-collision bucketing regression is guarded
    // in tests/edge-endpoint-bucketing.test.ts: its fixture needs NUL-bearing
    // kind/id values, which PostgreSQL (22P05) and libsql cannot store, so it
    // cannot run in this cross-backend suite.

    it("deletes edge and excludes from queries", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      const edge1 = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });
      await store.edges.worksAt.create(alice, techCorp, {
        role: "Consultant",
      });

      // Delete first edge
      await store.edges.worksAt.delete(edge1.id);

      // Query should only return second edge
      const edges = await store.edges.worksAt.findFrom(alice);

      expect(edges).toHaveLength(1);
      expect(edges[0]?.role).toBe("Consultant");
    });

    it("sets valid time when creating by endpoints and preserves it when found", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const created = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: FIRST_VALID_FROM, validTo: FIRST_VALID_TO },
      );
      const found = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Manager" },
        { validFrom: SECOND_VALID_FROM, validTo: SECOND_VALID_TO },
      );

      expect(created.action).toBe("created");
      expect(created.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(created.edge.meta.validTo).toBe(FIRST_VALID_TO);
      expect(found.action).toBe("found");
      expect(found.edge.id).toBe(created.edge.id);
      expect(found.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(found.edge.meta.validTo).toBe(FIRST_VALID_TO);
    });

    it("updates validTo but preserves validFrom when updating by endpoints", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const created = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: FIRST_VALID_FROM },
      );
      // The update states no lower bound: a live edge's is history, so moving
      // only the end is the whole of what this leg can do. Naming a DIFFERENT
      // one is refused by the case below rather than silently preserving this
      // one, which is what this case used to assert.
      const updated = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Manager" },
        { ifExists: "update", validTo: SECOND_VALID_TO },
      );

      expect(updated.action).toBe("updated");
      expect(updated.edge.id).toBe(created.edge.id);
      expect(updated.edge.role).toBe("Manager");
      expect(updated.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(updated.edge.meta.validTo).toBe(SECOND_VALID_TO);
    });

    it("refuses an endpoint update that states a validFrom the live edge does not hold", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const created = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: FIRST_VALID_FROM },
      );

      await expectImmutableLowerBoundRefusal(
        store.edges.worksAt.getOrCreateByEndpoints(
          alice,
          acme,
          { role: "Manager" },
          {
            ifExists: "update",
            validFrom: SECOND_VALID_FROM,
            validTo: SECOND_VALID_TO,
          },
        ),
      );

      // Refused whole: neither the props nor the end moved.
      const stored = await store.edges.worksAt.getById(created.edge.id);
      expect(stored?.role).toBe("Engineer");
      expect(stored?.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(stored?.meta.validTo).toBeUndefined();
    });

    it("preserves a live edge lower bound when an endpoint update opts in", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const created = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: FIRST_VALID_FROM },
      );
      const updated = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Manager" },
        {
          ifExists: "update",
          validFrom: SECOND_VALID_FROM,
          // The source pair is inverted, but the effective stored window is
          // ordered. Preserve mode must judge the window the write will keep.
          validTo: FIRST_VALID_TO,
          onImmutableLowerBound: "preserve",
        },
      );

      expect(updated.action).toBe("updated");
      expect(updated.edge.id).toBe(created.edge.id);
      expect(updated.edge.role).toBe("Manager");
      expect(updated.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(updated.edge.meta.validTo).toBe(FIRST_VALID_TO);
    });

    it("still validates a preserved endpoint lower bound", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });
      await store.edges.worksAt.create(alice, acme, { role: "Engineer" });

      await expect(
        store.edges.worksAt.getOrCreateByEndpoints(
          alice,
          acme,
          { role: "Manager" },
          {
            ifExists: "update",
            validFrom: "not-a-date",
            onImmutableLowerBound: "preserve",
          },
        ),
      ).rejects.toThrow(/Invalid canonical ISO 8601 datetime for "validFrom"/);
    });

    it("still refuses an effectively inverted preserved endpoint window", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: FIRST_VALID_FROM },
      );

      await expect(
        store.edges.worksAt.getOrCreateByEndpoints(
          alice,
          acme,
          { role: "Manager" },
          {
            ifExists: "update",
            validFrom: "2017-01-01T00:00:00.000Z",
            validTo: "2018-01-01T00:00:00.000Z",
            onImmutableLowerBound: "preserve",
          },
        ),
      ).rejects.toThrow(/Inverted validity window/);
    });

    it("applies a preserved lower bound on create and resurrection", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const created = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Engineer" },
        {
          validFrom: FIRST_VALID_FROM,
          onImmutableLowerBound: "preserve",
        },
      );
      expect(created.edge.meta.validFrom).toBe(FIRST_VALID_FROM);

      await store.edges.worksAt.delete(created.edge.id);
      const resurrected = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Manager" },
        {
          validFrom: SECOND_VALID_FROM,
          validTo: SECOND_VALID_TO,
          onImmutableLowerBound: "preserve",
        },
      );

      expect(resurrected.action).toBe("resurrected");
      expect(resurrected.edge.meta.validFrom).toBe(SECOND_VALID_FROM);
      expect(resurrected.edge.meta.validTo).toBe(SECOND_VALID_TO);
    });

    it("restating the bound a live edge already holds is accepted", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: FIRST_VALID_FROM },
      );
      const updated = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Manager" },
        {
          ifExists: "update",
          validFrom: FIRST_VALID_FROM,
          validTo: SECOND_VALID_TO,
        },
      );

      expect(updated.action).toBe("updated");
      expect(updated.edge.role).toBe("Manager");
      expect(updated.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(updated.edge.meta.validTo).toBe(SECOND_VALID_TO);
    });

    it("sets distinct valid-time windows for bulk endpoint writes", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
        {
          from: alice,
          to: acme,
          props: { role: "Engineer" },
          validFrom: FIRST_VALID_FROM,
          validTo: FIRST_VALID_TO,
        },
        {
          from: bob,
          to: acme,
          props: { role: "Manager" },
          validFrom: SECOND_VALID_FROM,
          validTo: SECOND_VALID_TO,
        },
      ]);

      expect(results[0]?.action).toBe("created");
      expect(results[0]?.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(results[0]?.edge.meta.validTo).toBe(FIRST_VALID_TO);
      expect(results[1]?.action).toBe("created");
      expect(results[1]?.edge.meta.validFrom).toBe(SECOND_VALID_FROM);
      expect(results[1]?.edge.meta.validTo).toBe(SECOND_VALID_TO);

      // As on the single path: the update states no lower bound, because a live
      // edge's is history.
      const [updated] = await store.edges.worksAt.bulkGetOrCreateByEndpoints(
        [
          {
            from: alice,
            to: acme,
            props: { role: "Principal Engineer" },
            validTo: SECOND_VALID_TO,
          },
        ],
        { ifExists: "update" },
      );

      expect(updated?.action).toBe("updated");
      expect(updated?.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(updated?.edge.meta.validTo).toBe(SECOND_VALID_TO);
    });

    it("keeps delimiter-bearing endpoint tuples distinct in one batch", async () => {
      const store = context.getStore();
      const separator = "\u001ECompany\u001E";
      const firstFrom = await store.nodes.Person.create(
        { name: "First" },
        { id: "a" },
      );
      const secondFrom = await store.nodes.Person.create(
        { name: "Second" },
        { id: `a${separator}b` },
      );
      const firstTo = await store.nodes.Company.create(
        { name: "First company" },
        { id: `b${separator}c` },
      );
      const secondTo = await store.nodes.Company.create(
        { name: "Second company" },
        { id: "c" },
      );

      const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
        {
          from: firstFrom,
          to: firstTo,
          props: { role: "Engineer" },
        },
        {
          from: secondFrom,
          to: secondTo,
          props: { role: "Manager" },
        },
      ]);

      expect(results).toHaveLength(2);
      expect(results.map((result) => result.action)).toEqual([
        "created",
        "created",
      ]);
      expect(results[0]?.edge.id).not.toBe(results[1]?.edge.id);
    });

    it("refuses a bulk endpoint update that states a validFrom the live edge does not hold", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      // Left OPEN so the refused row is readable in current mode afterwards.
      const [created] = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
        {
          from: alice,
          to: acme,
          props: { role: "Engineer" },
          validFrom: FIRST_VALID_FROM,
        },
      ]);

      await expectImmutableLowerBoundRefusal(
        store.edges.worksAt.bulkGetOrCreateByEndpoints(
          [
            {
              from: alice,
              to: acme,
              props: { role: "Principal Engineer" },
              validFrom: SECOND_VALID_FROM,
              validTo: SECOND_VALID_TO,
            },
          ],
          { ifExists: "update" },
        ),
      );

      const stored = await store.edges.worksAt.getById(
        requireDefined(created).edge.id,
      );
      expect(stored?.role).toBe("Engineer");
      expect(stored?.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(stored?.meta.validTo).toBeUndefined();
    });

    it("applies per-item lower-bound policy across bulk update, resurrection, and create", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const charlie = await store.nodes.Person.create({ name: "Charlie" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const live = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: FIRST_VALID_FROM },
      );
      const deleted = await store.edges.worksAt.create(
        bob,
        acme,
        { role: "Engineer" },
        { validFrom: FIRST_VALID_FROM },
      );
      await store.edges.worksAt.delete(deleted.id);

      const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints(
        [
          {
            from: alice,
            to: acme,
            props: { role: "Manager" },
            validFrom: SECOND_VALID_FROM,
            validTo: FIRST_VALID_TO,
            onImmutableLowerBound: "preserve",
          },
          {
            from: bob,
            to: acme,
            props: { role: "Director" },
            validFrom: SECOND_VALID_FROM,
            validTo: SECOND_VALID_TO,
            onImmutableLowerBound: "preserve",
          },
          {
            from: charlie,
            to: acme,
            props: { role: "Analyst" },
            validFrom: SECOND_VALID_FROM,
            validTo: SECOND_VALID_TO,
            onImmutableLowerBound: "preserve",
          },
        ],
        { ifExists: "update" },
      );

      expect(results.map((result) => result.action)).toEqual([
        "updated",
        "resurrected",
        "created",
      ]);
      expect(results[0]?.edge.id).toBe(live.id);
      expect(results[0]?.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(results[0]?.edge.meta.validTo).toBe(FIRST_VALID_TO);
      expect(results[1]?.edge.id).toBe(deleted.id);
      expect(results[1]?.edge.meta.validFrom).toBe(SECOND_VALID_FROM);
      expect(results[1]?.edge.meta.validTo).toBe(SECOND_VALID_TO);
      expect(results[2]?.edge.meta.validFrom).toBe(SECOND_VALID_FROM);
      expect(results[2]?.edge.meta.validTo).toBe(SECOND_VALID_TO);
    });

    it("keeps strict and preserve policies isolated in an atomic bulk update", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });
      const [aliceEdge, bobEdge] = await store.edges.worksAt.bulkCreate([
        {
          from: alice,
          to: acme,
          props: { role: "Engineer" },
          validFrom: FIRST_VALID_FROM,
        },
        {
          from: bob,
          to: acme,
          props: { role: "Engineer" },
          validFrom: FIRST_VALID_FROM,
        },
      ]);

      await expectImmutableLowerBoundRefusal(
        store.edges.worksAt.bulkGetOrCreateByEndpoints(
          [
            {
              from: alice,
              to: acme,
              props: { role: "Manager" },
              validFrom: SECOND_VALID_FROM,
              onImmutableLowerBound: "preserve",
            },
            {
              from: bob,
              to: acme,
              props: { role: "Director" },
              validFrom: SECOND_VALID_FROM,
              onImmutableLowerBound: "refuse",
            },
          ],
          { ifExists: "update" },
        ),
      );

      const storedAliceEdge = await store.edges.worksAt.getById(
        requireDefined(aliceEdge).id,
      );
      const storedBobEdge = await store.edges.worksAt.getById(
        requireDefined(bobEdge).id,
      );
      expect(storedAliceEdge?.role).toBe("Engineer");
      expect(storedBobEdge?.role).toBe("Engineer");
    });

    it("rejects malformed per-item preserve input before applying a bulk update", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });
      const [aliceEdge] = await store.edges.worksAt.bulkCreate([
        {
          from: alice,
          to: acme,
          props: { role: "Engineer" },
          validFrom: FIRST_VALID_FROM,
        },
        {
          from: bob,
          to: acme,
          props: { role: "Engineer" },
          validFrom: FIRST_VALID_FROM,
        },
      ]);

      await expect(
        store.edges.worksAt.bulkGetOrCreateByEndpoints(
          [
            {
              from: alice,
              to: acme,
              props: { role: "Manager" },
              validFrom: SECOND_VALID_FROM,
              onImmutableLowerBound: "preserve",
            },
            {
              from: bob,
              to: acme,
              props: { role: "Director" },
              validFrom: "not-a-date",
              onImmutableLowerBound: "preserve",
            },
          ],
          { ifExists: "update" },
        ),
      ).rejects.toThrow(/Invalid canonical ISO 8601 datetime for "validFrom"/);

      const storedAliceEdge = await store.edges.worksAt.getById(
        requireDefined(aliceEdge).id,
      );
      expect(storedAliceEdge?.role).toBe("Engineer");
    });
  });
}
