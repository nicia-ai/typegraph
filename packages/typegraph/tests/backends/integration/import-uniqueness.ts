/**
 * Cross-backend importGraph uniqueness parity.
 *
 * Batch import primes a shared uniqueness pre-check cache ONCE per slice and
 * then routes each record (create vs onConflict:"update") against it. An
 * in-slice update mutates the real backend's uniqueness rows directly, so the
 * batched path must reconcile the cache with that mutation or it diverges from
 * the one-record-per-slice (sequential-equivalent) path:
 *
 *  - an update that FREES a unique value must let a later create claim it, and
 *  - an update that CLAIMS a free value must turn a later create of that value
 *    into a per-row error — never a flush-time constraint violation that
 *    throws and rolls back the whole import.
 *
 * These live in the shared suite so both SQLite and PostgreSQL certify the
 * same observable outcome (the batching path was previously SQLite-only).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type NodeId,
} from "../../../src";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  type ImportOptions,
} from "../../../src/interchange";
import { type IntegrationTestContext } from "./test-context";

const ImportPerson = defineNode("ImportPerson", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

// Each run gets its own graph id so the sequential (batchSize 1) and batched
// runs within one test are fully isolated on the shared backend — node rows
// are namespaced by graph_id, so distinct ids never see each other's writes.
function buildImportUniquenessGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: {
      ImportPerson: {
        type: ImportPerson,
        unique: [
          {
            name: "import_person_email",
            fields: ["email"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
    },
    edges: {},
  });
}

let graphIdCounter = 0;

function personId(id: string): NodeId<typeof ImportPerson> {
  return id as NodeId<typeof ImportPerson>;
}

function payload(nodes: GraphData["nodes"]): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "import uniqueness parity" },
    nodes,
    edges: [],
  };
}

function personNode(
  id: string,
  name: string,
  email: string,
): GraphData["nodes"][number] {
  return { kind: "ImportPerson", id, properties: { name, email } };
}

function options(batchSize: number): ImportOptions {
  return {
    onConflict: "update",
    onUnknownProperty: "error",
    validateReferences: true,
    batchSize,
    refreshStatistics: false,
  };
}

export function registerImportUniquenessIntegrationTests(
  context: IntegrationTestContext,
): void {
  // Hoisted to this scope (not inside `describe`) because it closes over
  // `context`; each call gets its own graph id so a test's sequential
  // (batchSize 1) and batched runs stay isolated on the shared backend.
  async function createGraphStore() {
    graphIdCounter += 1;
    const [store] = await createStoreWithSchema(
      buildImportUniquenessGraph(`import_uniqueness_parity_${graphIdCounter}`),
      context.getStore().backend,
    );
    return store;
  }

  describe("importGraph uniqueness parity", () => {
    it("in-slice update that frees a unique key lets a later create claim it", async () => {
      const outcomes = new Map<number, unknown>();
      for (const batchSize of [1, 100]) {
        const store = await createGraphStore();
        await importGraph(
          store,
          payload([personNode("free-a", "a", "shared@example.com")]),
          options(1),
        );
        const result = await importGraph(
          store,
          payload([
            personNode("free-a", "a2", "moved@example.com"),
            personNode("free-b", "b", "shared@example.com"),
          ]),
          options(batchSize),
        );
        const personA = await store.nodes.ImportPerson.getById(
          personId("free-a"),
        );
        const personB = await store.nodes.ImportPerson.getById(
          personId("free-b"),
        );
        outcomes.set(batchSize, {
          created: result.nodes.created,
          updated: result.nodes.updated,
          errorIds: result.errors.map((entry) => entry.id),
          emailA: personA?.email,
          emailB: personB?.email,
        });
      }

      const sequential = outcomes.get(1);
      const batched = outcomes.get(100);

      expect(sequential).toEqual({
        created: 1,
        updated: 1,
        errorIds: [],
        emailA: "moved@example.com",
        emailB: "shared@example.com",
      });
      expect(batched).toEqual(sequential);
    });

    it("in-slice update that claims a free unique key makes a later create a per-row error, not an import abort", async () => {
      const outcomes = new Map<number, unknown>();
      for (const batchSize of [1, 100]) {
        const store = await createGraphStore();
        await importGraph(
          store,
          payload([personNode("claim-a", "a", "a-orig@example.com")]),
          options(1),
        );
        const result = await importGraph(
          store,
          payload([
            personNode("claim-a", "a2", "target@example.com"),
            personNode("claim-c", "c", "target@example.com"),
          ]),
          options(batchSize),
        );
        const personA = await store.nodes.ImportPerson.getById(
          personId("claim-a"),
        );
        const personC = await store.nodes.ImportPerson.getById(
          personId("claim-c"),
        );
        outcomes.set(batchSize, {
          created: result.nodes.created,
          updated: result.nodes.updated,
          errors: result.errors.map((entry) => ({
            id: entry.id,
            matchesConstraint: entry.error.includes("import_person_email"),
          })),
          emailA: personA?.email,
          personCExists: personC !== undefined,
        });
      }

      const sequential = outcomes.get(1);
      const batched = outcomes.get(100);

      expect(sequential).toEqual({
        created: 0,
        updated: 1,
        errors: [{ id: "claim-c", matchesConstraint: true }],
        emailA: "target@example.com",
        personCExists: false,
      });
      expect(batched).toEqual(sequential);
    });
  });
}
