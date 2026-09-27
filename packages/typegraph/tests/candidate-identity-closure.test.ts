import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../src";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
import { readCandidateIdentityClosure } from "../src/graph-merge/candidate-identity-closure";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledStatementSql } from "../src/query/sql-intent";
import { storeRuntime } from "../src/store/runtime-port";
import { compareCodePoints } from "../src/utils/compare";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ label: z.string() }),
});
const Author = defineNode("Author", {
  schema: z.object({ label: z.string() }),
});
const Place = defineNode("Place", {
  schema: z.object({ label: z.string() }),
});

const graph = defineGraph({
  id: "candidate_identity_closure",
  nodes: {
    Person: { type: Person },
    Author: { type: Author },
    Place: { type: Place },
  },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

type ClosureTestBackend = Readonly<{
  backend: GraphBackend;
  close: () => Promise<void>;
}>;

function openSqliteBackend(): Promise<ClosureTestBackend> {
  const opened = createLocalSqliteBackend();
  return Promise.resolve({
    backend: opened.backend,
    close: () => opened.backend.close(),
  });
}

async function openPgliteBackend(): Promise<ClosureTestBackend> {
  const opened = await createLocalPgliteBackend({ vector: false });
  return {
    backend: opened.backend,
    close: () => opened.backend.close(),
  };
}

describe.each([
  { name: "SQLite", open: openSqliteBackend },
  { name: "PGlite", open: openPgliteBackend },
])("candidate-relevant identity closure on $name", ({ open }) => {
  it("matches the full archival projection through ended assertions and folded peers", async () => {
    const backend = await open();
    try {
      const [store] = await createStoreWithSchema(graph, backend.backend);
      const person = await store.nodes.Person.create(
        { label: "seed" },
        { id: "a" },
      );
      await store.nodes.Author.create({ label: "same-id peer" }, { id: "a" });
      const author = await store.nodes.Author.create(
        { label: "linked" },
        { id: "b" },
      );
      const place = await store.nodes.Place.create(
        { label: "ended link" },
        { id: "c" },
      );
      await store.identity.assertSame(person, author);
      const ended = await store.identity.assertSame(author, place);
      await store.identity.retractAssertion(ended.assertion.id);

      const target = backend.backend;
      const closure = await readCandidateIdentityClosure(store, target, {
        references: [{ kind: "Person", id: "a" }],
      });
      const referenceKeys = new Set(
        closure.references.map((reference) =>
          JSON.stringify([reference.kind, reference.id]),
        ),
      );
      const fullLedger = await storeRuntime(store).identityAssertionsAtTarget(
        target,
        "archival",
      );
      const expectedAssertions = fullLedger
        .filter(
          (assertion) =>
            referenceKeys.has(
              JSON.stringify([assertion.a.kind, assertion.a.id]),
            ) ||
            referenceKeys.has(
              JSON.stringify([assertion.b.kind, assertion.b.id]),
            ),
        )
        .toSorted((left, right) => compareCodePoints(left.id, right.id));

      expect(closure.references).toEqual([
        { kind: "Author", id: "a" },
        { kind: "Author", id: "b" },
        { kind: "Person", id: "a" },
        { kind: "Place", id: "c" },
      ]);
      expect(closure.assertions).toEqual(expectedAssertions);
      expect(closure.assertions.map((assertion) => assertion.id)).toContain(
        ended.assertion.id,
      );
      expect(
        closure.assertions.find(
          (assertion) => assertion.id === ended.assertion.id,
        )?.validTo,
      ).toBeDefined();
    } finally {
      await backend.close();
    }
  });

  it("includes supplied assertion-ID collisions and ignores unrelated ledger growth", async () => {
    const backend = await open();
    try {
      const [store] = await createStoreWithSchema(graph, backend.backend);
      const seed = await store.nodes.Person.create(
        { label: "seed" },
        { id: "seed" },
      );
      const unrelatedLeft = await store.nodes.Author.create(
        { label: "collision left" },
        { id: "collision-left" },
      );
      const unrelatedRight = await store.nodes.Place.create(
        { label: "collision right" },
        { id: "collision-right" },
      );
      const collision = await store.identity.assertSame(
        unrelatedLeft,
        unrelatedRight,
      );
      await store.identity.retractAssertion(collision.assertion.id);

      const withCollision = await readCandidateIdentityClosure(
        store,
        backend.backend,
        {
          references: [{ kind: "Person", id: seed.id }],
          assertionIds: [collision.assertion.id],
        },
      );
      expect(
        withCollision.assertions.map((assertion) => assertion.id),
      ).toContain(collision.assertion.id);
      expect(withCollision.references).toContainEqual({
        kind: "Author",
        id: "collision-left",
      });
      expect(
        withCollision.assertions.find(
          (assertion) => assertion.id === collision.assertion.id,
        )?.validTo,
      ).toBeDefined();

      const deletedCollision = await store.identity.assertSame(
        seed,
        unrelatedLeft,
      );
      const schema = createSqlSchema(backend.backend.tableNames);
      await requireDefined(backend.backend.executeStatement)(
        asCompiledStatementSql(sql`
          UPDATE ${schema.identityAssertionsTable}
          SET deleted_at = ${new Date().toISOString()}
          WHERE graph_id = ${store.graphId}
            AND id = ${deletedCollision.assertion.id}
        `),
      );
      const deletedCollisionClosure = await readCandidateIdentityClosure(
        store,
        backend.backend,
        {
          references: [{ kind: "Person", id: seed.id }],
          assertionIds: [deletedCollision.assertion.id],
        },
      );
      expect(
        deletedCollisionClosure.assertions.map((assertion) => assertion.id),
      ).not.toContain(deletedCollision.assertion.id);
      expect(
        await storeRuntime(store).identityAssertionRowsByIds(
          [deletedCollision.assertion.id],
          backend.backend,
        ),
      ).toHaveProperty("size", 1);

      const deletedEndpoint = await store.nodes.Place.create(
        { label: "deleted endpoint" },
        { id: "deleted-endpoint" },
      );
      const deletedEndpointAssertion = await store.identity.assertSame(
        seed,
        deletedEndpoint,
      );
      await requireDefined(backend.backend.executeStatement)(
        asCompiledStatementSql(sql`
          UPDATE ${schema.nodesTable}
          SET deleted_at = ${new Date().toISOString()}
          WHERE graph_id = ${store.graphId}
            AND kind = ${"Place"}
            AND id = ${deletedEndpoint.id}
        `),
      );
      const withoutDeletedEndpoint = await readCandidateIdentityClosure(
        store,
        backend.backend,
        { references: [{ kind: "Person", id: seed.id }] },
      );
      expect(
        withoutDeletedEndpoint.assertions.map((assertion) => assertion.id),
      ).not.toContain(deletedEndpointAssertion.assertion.id);
      expect(withoutDeletedEndpoint.references).not.toContainEqual({
        kind: "Place",
        id: deletedEndpoint.id,
      });

      const beforeGrowth = await readCandidateIdentityClosure(
        store,
        backend.backend,
        {
          references: [{ kind: "Person", id: seed.id }],
        },
      );
      const growthLeft = await store.nodes.Person.create(
        { label: "unrelated growth left" },
        { id: "growth-left" },
      );
      const growthRight = await store.nodes.Author.create(
        { label: "unrelated growth right" },
        { id: "growth-right" },
      );
      await store.identity.assertSame(growthLeft, growthRight);
      const afterGrowth = await readCandidateIdentityClosure(
        store,
        backend.backend,
        {
          references: [{ kind: "Person", id: seed.id }],
        },
      );

      expect(afterGrowth).toEqual(beforeGrowth);
    } finally {
      await backend.close();
    }
  });
});
