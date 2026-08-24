import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  ConfigurationError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  EdgeMatchIdentityConflictError,
} from "../src";
import {
  deriveBackend,
  projectBackendWithout,
  projectGraphBackend,
} from "../src/backend/derive-backend";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
import { type GraphData, importGraph } from "../src/interchange";
import { createStoreWithSchema } from "../src/store";
import { disableTransactions } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", {
  schema: z.object({ label: z.string() }),
});

function documentOf(graphId: string, edges: GraphData["edges"]): GraphData {
  return {
    formatVersion: "2.0",
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "typegraph-export", graphId, schemaVersion: 1 },
    nodes: [
      { kind: "Person", id: "owner", properties: { name: "Owner" } },
      { kind: "Person", id: "target", properties: { name: "Target" } },
    ],
    edges,
  };
}

function hideDurableIdentityOwners(
  backend: GraphBackend,
  transactionStatements: string[],
): GraphBackend {
  const projected = projectBackendWithout(projectGraphBackend(backend), [
    "insertEdgesDurableBatchReturning",
  ]);
  return deriveBackend(projected, {
    findEdgesByHeterogeneousEndpointSet: () => Promise.resolve([]),
    transaction: (run, options) =>
      backend.transaction((target) => {
        const executeStatement = target.executeStatement;
        if (executeStatement === undefined) {
          throw new Error("Expected statement execution on the test target");
        }
        const projectedTarget = projectBackendWithout(target, [
          "insertEdgesDurableBatchReturning",
        ]);
        return run(
          deriveBackend(projectedTarget, {
            executeStatement: async (statement) => {
              transactionStatements.push(
                statement.chunks
                  .filter((chunk) => chunk.kind === "text")
                  .map((chunk) => chunk.value)
                  .join(""),
              );
              await executeStatement(statement);
            },
            findEdgesByHeterogeneousEndpointSet: () => Promise.resolve([]),
          }),
        );
      }, options),
  });
}

async function runCase(
  backend: GraphBackend,
  includeDeferredDuplicate: boolean,
  history = false,
): Promise<void> {
  const graph = defineGraph({
    id: `import_edge_identity_atomicity_${Math.random().toString(36).slice(2)}`,
    nodes: { Person: { type: Person } },
    edges: {
      knows: {
        type: knows,
        from: [Person],
        to: [Person],
        matchIdentity: { name: "knows-label", fields: ["label"] },
      },
    },
  });
  try {
    const [ownerStore] = await createStoreWithSchema(graph, backend);
    const owner = await ownerStore.nodes.Person.create(
      { name: "Owner" },
      { id: "owner" },
    );
    const target = await ownerStore.nodes.Person.create(
      { name: "Target" },
      { id: "target" },
    );
    await ownerStore.edges.knows.create(owner, target, { label: "taken" });

    const transactionStatements: string[] = [];
    const hiddenStore = await createStoreWithSchema(
      graph,
      hideDurableIdentityOwners(backend, transactionStatements),
      history ? { history: true } : undefined,
    ).then(([store]) => store);
    const result = await importGraph(
      hiddenStore,
      {
        ...documentOf(graph.id, [
          {
            kind: "knows",
            id: "unrelated",
            from: { kind: "Person", id: "owner" },
            to: { kind: "Person", id: "target" },
            properties: { label: "other" },
          },
          ...(includeDeferredDuplicate ?
            [
              {
                kind: "knows" as const,
                id: "conflict",
                from: { kind: "Person", id: "owner" },
                to: { kind: "Person", id: "target" },
                properties: { label: "x".repeat(3000) },
              },
              {
                kind: "knows" as const,
                id: "conflict",
                from: { kind: "Person", id: "owner" },
                to: { kind: "Person", id: "target" },
                properties: { label: "taken" },
              },
            ]
          : [
              {
                kind: "knows" as const,
                id: "conflict",
                from: { kind: "Person", id: "owner" },
                to: { kind: "Person", id: "target" },
                properties: { label: "taken" },
              },
            ]),
        ]),
        nodes: [],
      },
      {
        onConflict: "error",
        batchSize: 100,
        refreshStatistics: false,
      },
    );

    expect(result.edges.created).toBe(1);
    expect(result.errors).toHaveLength(includeDeferredDuplicate ? 2 : 1);
    await expect(
      hiddenStore.edges.knows.getById(asEdgeId("unrelated")),
    ).resolves.toMatchObject({ label: "other" });
    expect(
      transactionStatements.some((statement) =>
        statement.startsWith("SAVEPOINT typegraph_import_edge_row_"),
      ),
    ).toBe(true);
    expect(
      transactionStatements.some((statement) =>
        statement.startsWith(
          "ROLLBACK TO SAVEPOINT typegraph_import_edge_row_",
        ),
      ),
    ).toBe(true);
    expect(
      transactionStatements.some((statement) =>
        statement.startsWith("RELEASE SAVEPOINT typegraph_import_edge_row_"),
      ),
    ).toBe(true);
  } finally {
    await backend.close();
  }
}

describe("deferred durable edge identity refusal atomicity", () => {
  it("keeps accepted rows committed on SQLite", async () => {
    const { backend } = createLocalSqliteBackend();
    await runCase(backend, true);
  });

  it("keeps accepted rows committed on PostgreSQL/PGlite", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    await runCase(backend, true);
  });

  it("retries a non-duplicate-id accepted batch after a database refusal", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    await runCase(backend, false);
  });

  it("recovers deferred row refusals inside SQLite history capture", async () => {
    const { backend } = createLocalSqliteBackend();
    await runCase(backend, true, true);
  });

  it("recovers deferred row refusals inside PGlite history capture", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    await runCase(backend, true, true);
  });

  it("refuses non-atomic row attribution after a partially applied batch", async () => {
    const { backend } = createLocalSqliteBackend();
    const graph = defineGraph({
      id: "import_edge_identity_non_atomic_retry",
      nodes: { Person: { type: Person } },
      edges: {
        knows: {
          type: knows,
          from: [Person],
          to: [Person],
          matchIdentity: { name: "knows-label", fields: ["label"] },
        },
      },
    });
    try {
      const [setup] = await createStoreWithSchema(graph, backend);
      const owner = await setup.nodes.Person.create(
        { name: "Owner" },
        { id: "owner" },
      );
      const target = await setup.nodes.Person.create(
        { name: "Target" },
        { id: "target" },
      );
      await setup.edges.knows.create(owner, target, { label: "taken" });

      let individualRetries = 0;
      const transactionless = disableTransactions(backend);
      const projected = projectBackendWithout(transactionless, [
        "insertEdgeNoReturn",
        "insertEdgesDurableBatchReturning",
      ]);
      const partialBatch = deriveBackend(projected, {
        findEdgesByHeterogeneousEndpointSet: () => Promise.resolve([]),
        async insertEdge(params) {
          individualRetries += 1;
          return backend.insertEdge(params);
        },
        async insertEdgesBatch(params) {
          const first = params[0];
          if (first === undefined)
            throw new Error("Expected a non-empty batch");
          await backend.insertEdge(first);
          throw new EdgeMatchIdentityConflictError({ attempted: [] });
        },
      });

      await expect(
        importGraph(
          createStore(graph, partialBatch),
          {
            ...documentOf(graph.id, [
              {
                kind: "knows",
                id: "partial-first",
                from: { kind: "Person", id: "owner" },
                to: { kind: "Person", id: "target" },
                properties: { label: "other" },
              },
              {
                kind: "knows",
                id: "partial-second",
                from: { kind: "Person", id: "owner" },
                to: { kind: "Person", id: "target" },
                properties: { label: "taken" },
              },
            ]),
            nodes: [],
          },
          {
            onConflict: "error",
            refreshStatistics: false,
          },
        ),
      ).rejects.toMatchObject({
        details: { code: "IMPORT_EDGE_BATCH_RETRY_REQUIRES_SAVEPOINT" },
      });
      expect(individualRetries).toBe(0);
    } finally {
      await backend.close();
    }
  });

  it("does not infer savepoint protection from a transaction target the root verdict did not promise", async () => {
    const { backend } = createLocalSqliteBackend();
    const graph = defineGraph({
      id: "import_edge_identity_unpromised_savepoint",
      nodes: { Person: { type: Person } },
      edges: {
        knows: {
          type: knows,
          from: [Person],
          to: [Person],
          matchIdentity: { name: "knows-label", fields: ["label"] },
        },
      },
    });
    try {
      const [setup] = await createStoreWithSchema(graph, backend);
      const owner = await setup.nodes.Person.create(
        { name: "Owner" },
        { id: "owner" },
      );
      const target = await setup.nodes.Person.create(
        { name: "Target" },
        { id: "target" },
      );
      await setup.edges.knows.create(owner, target, { label: "taken" });

      let individualRetries = 0;
      const savepointStatements: string[] = [];
      const rootWithoutStatements = projectBackendWithout(
        projectGraphBackend(backend),
        [
          "executeStatement",
          "insertEdgeNoReturn",
          "insertEdgesDurableBatchReturning",
        ],
      );
      const partialBatch = deriveBackend(rootWithoutStatements, {
        findEdgesByHeterogeneousEndpointSet: () => Promise.resolve([]),
        transaction: (run, options) =>
          backend.transaction((transactionTarget) => {
            const executeStatement = transactionTarget.executeStatement;
            if (executeStatement === undefined) {
              throw new Error("Expected statement execution on test target");
            }
            const projectedTarget = projectBackendWithout(transactionTarget, [
              "insertEdgeNoReturn",
              "insertEdgesDurableBatchReturning",
            ]);
            return run(
              deriveBackend(projectedTarget, {
                findEdgesByHeterogeneousEndpointSet: () => Promise.resolve([]),
                async executeStatement(statement): Promise<void> {
                  const sql = statement.chunks
                    .filter((chunk) => chunk.kind === "text")
                    .map((chunk) => chunk.value)
                    .join("");
                  if (sql.startsWith("SAVEPOINT")) {
                    savepointStatements.push(sql);
                  }
                  await executeStatement(statement);
                },
                async insertEdge(params) {
                  individualRetries += 1;
                  return transactionTarget.insertEdge(params);
                },
                async insertEdgesBatch(params) {
                  const first = params[0];
                  if (first === undefined) {
                    throw new Error("Expected a non-empty batch");
                  }
                  await transactionTarget.insertEdge(first);
                  throw new ConfigurationError(
                    "Injected deferred identity refusal",
                    { code: "EDGE_MATCH_IDENTITY_VALUE_NOT_SCALAR" },
                  );
                },
              }),
            );
          }, options),
      });

      await expect(
        importGraph(
          createStore(graph, partialBatch),
          {
            ...documentOf(graph.id, [
              {
                kind: "knows",
                id: "partial-first",
                from: { kind: "Person", id: "owner" },
                to: { kind: "Person", id: "target" },
                properties: { label: "other" },
              },
              {
                kind: "knows",
                id: "partial-second",
                from: { kind: "Person", id: "owner" },
                to: { kind: "Person", id: "target" },
                properties: { label: "taken" },
              },
            ]),
            nodes: [],
          },
          { onConflict: "error", refreshStatistics: false },
        ),
      ).rejects.toMatchObject({
        details: { code: "IMPORT_EDGE_BATCH_RETRY_REQUIRES_SAVEPOINT" },
      });
      expect(individualRetries).toBe(0);
      expect(savepointStatements).toEqual([]);

      const transactionPortWithoutStatements = deriveBackend(
        projectGraphBackend(backend),
        {
          findEdgesByHeterogeneousEndpointSet: () => Promise.resolve([]),
          transaction: (run, options) =>
            backend.transaction(
              (transactionTarget) =>
                run(
                  projectBackendWithout(transactionTarget, [
                    "executeStatement",
                    "insertEdgeNoReturn",
                    "insertEdgesDurableBatchReturning",
                  ]),
                ),
              options,
            ),
        },
      );
      await expect(
        importGraph(
          createStore(graph, transactionPortWithoutStatements),
          {
            ...documentOf(graph.id, [
              {
                kind: "knows",
                id: "port-mismatch",
                from: { kind: "Person", id: "owner" },
                to: { kind: "Person", id: "target" },
                properties: { label: "port-mismatch" },
              },
            ]),
            nodes: [],
          },
          { onConflict: "error", refreshStatistics: false },
        ),
      ).rejects.toMatchObject({
        details: { code: "BUNDLE_PORT_SURFACE_MISMATCH" },
      });
    } finally {
      await backend.close();
    }
  });
});
