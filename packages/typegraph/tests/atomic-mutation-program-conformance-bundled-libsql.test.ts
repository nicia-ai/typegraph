import { isDeepStrictEqual } from "node:util";

import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ATOMIC_MUTATION_PROGRAM_VARIANTS,
  reachableAtomicMutationProgramVariants,
  resolveAtomicMutationPrograms,
} from "../src/backend/capabilities/atomic-mutation-program";
import {
  type AtomicMutationProgramConformanceCase,
  runAtomicMutationProgramConformance,
} from "../src/backend/conformance/atomic-mutation-program";
import { deriveBackend } from "../src/backend/derive-backend";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import type { GraphBackend } from "../src/backend/types";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import {
  DatabaseOperationError,
  EndpointNotFoundError,
  RestrictedDeleteError,
  StaleVersionError,
  ValidationError,
} from "../src/errors";
import { migrateSchema } from "../src/schema";
import { createStoreWithSchema, createVerifiedStore } from "../src/store";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), score: z.number() }),
});
const EvolvedPerson = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    nickname: z.string().optional(),
    score: z.number(),
  }),
});
const relates = defineEdge("relates", {
  schema: z.object({ label: z.string() }),
});
const otherRelates = defineEdge("otherRelates", {
  schema: z.object({ label: z.string() }),
});
const durableRelates = defineEdge("durableRelates", {
  schema: z.object({ label: z.string() }),
});

function defineConformanceGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person, onDelete: "restrict" } },
    edges: {
      relates: { type: relates, from: [Person], to: [Person] },
      otherRelates: { type: otherRelates, from: [Person], to: [Person] },
      durableRelates: {
        type: durableRelates,
        from: [Person],
        to: [Person],
        matchIdentity: { name: "label", fields: ["label"] },
      },
    },
  });
}

function defineEvolvedConformanceGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: EvolvedPerson, onDelete: "restrict" } },
    edges: {
      relates: { type: relates, from: [EvolvedPerson], to: [EvolvedPerson] },
      otherRelates: {
        type: otherRelates,
        from: [EvolvedPerson],
        to: [EvolvedPerson],
      },
      durableRelates: {
        type: durableRelates,
        from: [EvolvedPerson],
        to: [EvolvedPerson],
        matchIdentity: { name: "label", fields: ["label"] },
      },
    },
  });
}

type ConformanceGraph = ReturnType<typeof defineConformanceGraph>;
type ConformanceStore = Awaited<
  ReturnType<typeof createStoreWithSchema<ConformanceGraph>>
>[0];
type UnboundConformanceCase = Omit<
  AtomicMutationProgramConformanceCase,
  "backend"
>;

type NodeSnapshot = readonly [id: string, name: string, score: number];
type EdgeSnapshot = readonly [
  id: string,
  kind: string,
  fromId: string,
  toId: string,
  label: string,
];
type GraphSnapshot = Readonly<{
  edges: readonly EdgeSnapshot[];
  nodes: readonly NodeSnapshot[];
}>;

const PRIVILEGED_SCHEMA_BACKENDS = new WeakMap<GraphBackend, GraphBackend>();

function readString(
  row: Readonly<Record<string, unknown>>,
  column: string,
): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${column} to be a string.`);
  }
  return value;
}

function readNumber(
  row: Readonly<Record<string, unknown>>,
  column: string,
): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new TypeError(`Expected ${column} to be a number.`);
  }
  return value;
}

async function readGraphSnapshot(
  client: ReturnType<typeof createClient>,
  graphId: string,
): Promise<GraphSnapshot> {
  const [nodeResult, edgeResult] = await Promise.all([
    client.execute({
      sql: `
        SELECT id, json_extract(props, '$.name') AS name,
          json_extract(props, '$.score') AS score
        FROM typegraph_nodes
        WHERE graph_id = ? AND deleted_at IS NULL
        ORDER BY id
      `,
      args: [graphId],
    }),
    client.execute({
      sql: `
        SELECT id, kind, from_id, to_id,
          json_extract(props, '$.label') AS label
        FROM typegraph_edges
        WHERE graph_id = ? AND deleted_at IS NULL
        ORDER BY id
      `,
      args: [graphId],
    }),
  ]);
  return {
    nodes: nodeResult.rows.map((row) => [
      readString(row, "id"),
      readString(row, "name"),
      readNumber(row, "score"),
    ]),
    edges: edgeResult.rows.map((row) => [
      readString(row, "id"),
      readString(row, "kind"),
      readString(row, "from_id"),
      readString(row, "to_id"),
      readString(row, "label"),
    ]),
  };
}

function scenario(
  client: ReturnType<typeof createClient>,
  backend: GraphBackend,
  id: string,
) {
  const graph = defineConformanceGraph(`bundled-semantic-${id}`);
  let store: ConformanceStore | undefined;
  return {
    graph,
    async open(): Promise<ConformanceStore> {
      const schemaBackend = requireDefined(
        PRIVILEGED_SCHEMA_BACKENDS.get(backend),
      );
      await createStoreWithSchema(graph, schemaBackend);
      [store] = await createVerifiedStore(graph, backend);
      return store;
    },
    observe: () => readGraphSnapshot(client, graph.id),
    requireStore: () => requireDefined(store),
    async stale(): Promise<void> {
      await migrateSchema(
        requireDefined(PRIVILEGED_SCHEMA_BACKENDS.get(backend)),
        defineEvolvedConformanceGraph(graph.id),
        1,
      );
    },
  };
}

async function seedPeople(store: ConformanceStore, prefix: string) {
  const [from, to] = await store.nodes.Person.bulkCreate([
    { id: `${prefix}-from`, props: { name: "From", score: 1 } },
    { id: `${prefix}-to`, props: { name: "To", score: 2 } },
  ]);
  return { from: requireDefined(from), to: requireDefined(to) };
}

async function seedEdgeScenario(store: ConformanceStore, prefix: string) {
  const { from, to } = await seedPeople(store, prefix);
  await store.edges.relates.bulkCreate([
    { from, to, props: { label: "Existing" }, id: `${prefix}-existing` },
    { from, to, props: { label: "Filler" }, id: `${prefix}-filler` },
  ]);
  return { from, to };
}

async function installUpdateRefusalTrigger(
  client: ReturnType<typeof createClient>,
  table: "typegraph_nodes" | "typegraph_edges",
  graphId: string,
): Promise<void> {
  const triggerName = `refuse_${table}_${graphId}`.replaceAll(
    /[^a-zA-Z0-9_]/g,
    "_",
  );
  const quotedGraphId = graphId.replaceAll("'", "''");
  await client.execute(`
    CREATE TRIGGER ${triggerName}
    BEFORE UPDATE ON ${table}
    WHEN NEW.graph_id = '${quotedGraphId}'
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
}

function equal(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(actual, expected);
}

function buildCases(
  client: ReturnType<typeof createClient>,
  backend: GraphBackend,
): readonly AtomicMutationProgramConformanceCase[] {
  const createNodesSuccess = scenario(client, backend, "create-nodes-success");
  const createNodesStale = scenario(client, backend, "create-nodes-stale");
  const createNodesRefusal = scenario(client, backend, "create-nodes-refusal");

  const replaceNodesSuccess = scenario(
    client,
    backend,
    "replace-nodes-success",
  );
  const replaceNodesStale = scenario(client, backend, "replace-nodes-stale");
  const replaceNodesRefusal = scenario(
    client,
    backend,
    "replace-nodes-refusal",
  );

  const createEdgesSuccess = scenario(client, backend, "create-edges-success");
  const createEdgesStale = scenario(client, backend, "create-edges-stale");
  const createEdgesRefusal = scenario(client, backend, "create-edges-refusal");

  const deleteNodesSuccess = scenario(client, backend, "delete-nodes-success");
  const deleteNodesStale = scenario(client, backend, "delete-nodes-stale");
  const deleteNodesRefusal = scenario(client, backend, "delete-nodes-refusal");

  const deleteEdgesSuccess = scenario(client, backend, "delete-edges-success");
  const deleteEdgesStale = scenario(client, backend, "delete-edges-stale");
  const deleteEdgesRefusal = scenario(client, backend, "delete-edges-refusal");

  const updateNodesSuccess = scenario(client, backend, "update-nodes-success");
  const updateNodesStale = scenario(client, backend, "update-nodes-stale");
  const updateNodesRefusal = scenario(client, backend, "update-nodes-refusal");

  const updateEdgesSuccess = scenario(client, backend, "update-edges-success");
  const updateEdgesStale = scenario(client, backend, "update-edges-stale");
  const updateEdgesRefusal = scenario(client, backend, "update-edges-refusal");

  const mutateNodesSuccess = scenario(client, backend, "mutate-nodes-success");
  const mutateNodesStale = scenario(client, backend, "mutate-nodes-stale");
  const mutateNodesRefusal = scenario(client, backend, "mutate-nodes-refusal");

  const mutateEdgesSuccess = scenario(client, backend, "mutate-edges-success");
  const mutateEdgesStale = scenario(client, backend, "mutate-edges-stale");
  const mutateEdgesRefusal = scenario(client, backend, "mutate-edges-refusal");

  const convergeSuccess = scenario(client, backend, "converge-success");
  const convergeStale = scenario(client, backend, "converge-stale");
  const convergeRefusal = scenario(client, backend, "converge-refusal");

  const cases: readonly UnboundConformanceCase[] = [
    {
      variant: "createNodes",
      orderedSuccess: {
        prepare: async () => {
          await createNodesSuccess.open();
          return {
            expectedResult: [
              ["node-b", "B"],
              ["node-a", "A"],
            ],
            expectedState: {
              edges: [],
              nodes: [
                ["node-a", "A", 1],
                ["node-b", "B", 2],
              ],
            },
          };
        },
        execute: async () => {
          const nodes = await createNodesSuccess
            .requireStore()
            .nodes.Person.bulkCreate([
              { id: "node-b", props: { name: "B", score: 2 } },
              { id: "node-a", props: { name: "A", score: 1 } },
            ]);
          return nodes.map((node) => [node.id, node.name]);
        },
        observeState: createNodesSuccess.observe,
      },
      staleFenceNoWrite: {
        dispatch: "required",
        prepare: async () => {
          await createNodesStale.open();
          await createNodesStale.stale();
          return { expectedState: await createNodesStale.observe() };
        },
        execute: () =>
          createNodesStale
            .requireStore()
            .nodes.Person.bulkInsert([
              { id: "stale-node", props: { name: "Stale", score: 1 } },
            ]),
        observeState: createNodesStale.observe,
        errorMatches: (error) => error instanceof StaleVersionError,
      },
      semanticRefusalRollback: {
        dispatch: "pre-dispatch",
        prepare: async () => {
          await createNodesRefusal.open();
          return { expectedState: await createNodesRefusal.observe() };
        },
        execute: () =>
          createNodesRefusal.requireStore().nodes.Person.bulkInsert([
            { id: "repeated-node", props: { name: "First", score: 2 } },
            {
              id: "repeated-node",
              props: { name: "Second", score: 3 },
            },
          ]),
        observeState: createNodesRefusal.observe,
        errorMatches: (error) => error instanceof ValidationError,
      },
    },
    {
      variant: "replaceNodes",
      orderedSuccess: {
        prepare: async () => {
          const store = await replaceNodesSuccess.open();
          await store.nodes.Person.bulkInsert([
            {
              id: "replace-existing",
              props: { name: "Before", score: 0 },
            },
          ]);
          return {
            expectedResult: [
              ["replace-new", "New"],
              ["replace-existing", "After"],
            ],
            expectedState: {
              edges: [],
              nodes: [
                ["replace-existing", "After", 2],
                ["replace-new", "New", 1],
              ],
            },
          };
        },
        execute: async () => {
          const nodes = await replaceNodesSuccess
            .requireStore()
            .nodes.Person.bulkReplaceById([
              {
                id: "replace-new",
                props: { name: "New", score: 1 },
              },
              {
                id: "replace-existing",
                props: { name: "After", score: 2 },
              },
            ]);
          return nodes.map((node) => [node.id, node.name]);
        },
        observeState: replaceNodesSuccess.observe,
      },
      staleFenceNoWrite: {
        dispatch: "required",
        prepare: async () => {
          await replaceNodesStale.open();
          await replaceNodesStale.stale();
          return { expectedState: await replaceNodesStale.observe() };
        },
        execute: () =>
          replaceNodesStale
            .requireStore()
            .nodes.Person.bulkReplaceById([
              { id: "stale-replace", props: { name: "Stale", score: 1 } },
            ]),
        observeState: replaceNodesStale.observe,
        errorMatches: (error) => error instanceof StaleVersionError,
      },
      semanticRefusalRollback: {
        dispatch: "pre-dispatch",
        prepare: async () => {
          await replaceNodesRefusal.open();
          return { expectedState: await replaceNodesRefusal.observe() };
        },
        execute: () =>
          replaceNodesRefusal.requireStore().nodes.Person.bulkReplaceById([
            { id: "repeated-node", props: { name: "First", score: 2 } },
            { id: "repeated-node", props: { name: "Second", score: 3 } },
          ]),
        observeState: replaceNodesRefusal.observe,
        errorMatches: (error) => error instanceof ValidationError,
      },
    },
    {
      variant: "createEdges",
      orderedSuccess: {
        prepare: async () => {
          const store = await createEdgesSuccess.open();
          await seedPeople(store, "create-edge");
          return {
            expectedResult: [
              ["edge-b", "B"],
              ["edge-a", "A"],
            ],
            expectedState: {
              nodes: [
                ["create-edge-from", "From", 1],
                ["create-edge-to", "To", 2],
              ],
              edges: [
                [
                  "edge-a",
                  "relates",
                  "create-edge-from",
                  "create-edge-to",
                  "A",
                ],
                [
                  "edge-b",
                  "relates",
                  "create-edge-from",
                  "create-edge-to",
                  "B",
                ],
              ],
            },
          };
        },
        execute: async () => {
          const store = createEdgesSuccess.requireStore();
          const from = requireDefined(
            await store.nodes.Person.getById("create-edge-from" as never),
          );
          const to = requireDefined(
            await store.nodes.Person.getById("create-edge-to" as never),
          );
          const edges = await store.edges.relates.bulkCreate([
            { id: "edge-b", from, to, props: { label: "B" } },
            { id: "edge-a", from, to, props: { label: "A" } },
          ]);
          return edges.map((edge) => [edge.id, edge.label]);
        },
        observeState: createEdgesSuccess.observe,
      },
      staleFenceNoWrite: {
        dispatch: "required",
        prepare: async () => {
          const store = await createEdgesStale.open();
          await seedPeople(store, "stale-edge");
          await createEdgesStale.stale();
          return { expectedState: await createEdgesStale.observe() };
        },
        execute: async () => {
          const store = createEdgesStale.requireStore();
          const from = requireDefined(
            await store.nodes.Person.getById("stale-edge-from" as never),
          );
          const to = requireDefined(
            await store.nodes.Person.getById("stale-edge-to" as never),
          );
          return store.edges.relates.bulkInsert([
            { id: "stale-edge", from, to, props: { label: "Stale" } },
          ]);
        },
        observeState: createEdgesStale.observe,
        errorMatches: (error) => error instanceof StaleVersionError,
      },
      semanticRefusalRollback: {
        dispatch: "required",
        prepare: async () => {
          const store = await createEdgesRefusal.open();
          await seedPeople(store, "refuse-edge");
          return { expectedState: await createEdgesRefusal.observe() };
        },
        execute: async () => {
          const store = createEdgesRefusal.requireStore();
          const from = requireDefined(
            await store.nodes.Person.getById("refuse-edge-from" as never),
          );
          const to = requireDefined(
            await store.nodes.Person.getById("refuse-edge-to" as never),
          );
          return store.edges.relates.bulkInsert([
            { id: "valid-edge", from, to, props: { label: "Valid" } },
            {
              id: "invalid-edge",
              from,
              to: { kind: Person.kind, id: "missing-person" },
              props: { label: "Invalid" },
            },
          ]);
        },
        observeState: createEdgesRefusal.observe,
        errorMatches: (error) => error instanceof EndpointNotFoundError,
      },
    },
    {
      variant: "deleteNodes",
      orderedSuccess: {
        prepare: async () => {
          const store = await deleteNodesSuccess.open();
          await store.nodes.Person.bulkCreate([
            { id: "delete-node-b", props: { name: "B", score: 2 } },
            { id: "delete-node-a", props: { name: "A", score: 1 } },
          ]);
          return {
            expectedResult: undefined,
            expectedState: { edges: [], nodes: [] },
          };
        },
        execute: () =>
          deleteNodesSuccess
            .requireStore()
            .nodes.Person.bulkDelete([
              "delete-node-b" as never,
              "delete-node-a" as never,
            ]),
        observeState: deleteNodesSuccess.observe,
      },
      staleFenceNoWrite: {
        dispatch: "required",
        prepare: async () => {
          const store = await deleteNodesStale.open();
          await store.nodes.Person.bulkCreate([
            {
              id: "stale-delete-node-a",
              props: { name: "Stale A", score: 1 },
            },
            {
              id: "stale-delete-node-b",
              props: { name: "Stale B", score: 2 },
            },
          ]);
          await deleteNodesStale.stale();
          return { expectedState: await deleteNodesStale.observe() };
        },
        execute: () =>
          deleteNodesStale
            .requireStore()
            .nodes.Person.bulkDelete([
              "stale-delete-node-a" as never,
              "stale-delete-node-b" as never,
            ]),
        observeState: deleteNodesStale.observe,
        errorMatches: (error) => error instanceof StaleVersionError,
      },
      semanticRefusalRollback: {
        dispatch: "required",
        prepare: async () => {
          const store = await deleteNodesRefusal.open();
          const { from, to } = await seedPeople(store, "restricted");
          await store.nodes.Person.bulkCreate([
            {
              id: "restricted-isolated",
              props: { name: "Isolated", score: 3 },
            },
            {
              id: "restricted-filler",
              props: { name: "Filler", score: 4 },
            },
          ]);
          await store.edges.relates.bulkCreate([
            {
              from,
              to,
              props: { label: "Connected" },
              id: "restricted-edge",
            },
            {
              from,
              to,
              props: { label: "Filler" },
              id: "restricted-filler-edge",
            },
          ]);
          return { expectedState: await deleteNodesRefusal.observe() };
        },
        execute: () =>
          deleteNodesRefusal
            .requireStore()
            .nodes.Person.bulkDelete([
              "restricted-isolated" as never,
              "restricted-to" as never,
            ]),
        observeState: deleteNodesRefusal.observe,
        errorMatches: (error) => error instanceof RestrictedDeleteError,
      },
    },
    {
      variant: "deleteEdges",
      orderedSuccess: {
        prepare: async () => {
          const store = await deleteEdgesSuccess.open();
          const { from, to } = await seedPeople(store, "delete-edge");
          await store.edges.relates.bulkCreate([
            { id: "delete-edge-b", from, to, props: { label: "B" } },
            { id: "delete-edge-a", from, to, props: { label: "A" } },
          ]);
          return {
            expectedResult: undefined,
            expectedState: {
              edges: [],
              nodes: [
                ["delete-edge-from", "From", 1],
                ["delete-edge-to", "To", 2],
              ],
            },
          };
        },
        execute: () =>
          deleteEdgesSuccess
            .requireStore()
            .edges.relates.bulkDelete([
              "delete-edge-b" as never,
              "delete-edge-a" as never,
            ]),
        observeState: deleteEdgesSuccess.observe,
      },
      staleFenceNoWrite: {
        dispatch: "required",
        prepare: async () => {
          const store = await deleteEdgesStale.open();
          const { from, to } = await seedPeople(store, "stale-delete-edge");
          await store.edges.relates.bulkCreate([
            {
              from,
              to,
              props: { label: "Stale A" },
              id: "stale-delete-edge-a",
            },
            {
              from,
              to,
              props: { label: "Stale B" },
              id: "stale-delete-edge-b",
            },
          ]);
          await deleteEdgesStale.stale();
          return { expectedState: await deleteEdgesStale.observe() };
        },
        execute: () =>
          deleteEdgesStale
            .requireStore()
            .edges.relates.bulkDelete([
              "stale-delete-edge-a" as never,
              "stale-delete-edge-b" as never,
            ]),
        observeState: deleteEdgesStale.observe,
        errorMatches: (error) => error instanceof StaleVersionError,
      },
      semanticRefusalRollback: {
        dispatch: "required",
        prepare: async () => {
          const store = await deleteEdgesRefusal.open();
          const { from, to } = await seedPeople(store, "refuse-delete-edge");
          await store.edges.relates.bulkCreate([
            { from, to, props: { label: "Valid" }, id: "delete-valid" },
            { from, to, props: { label: "Filler" }, id: "delete-filler" },
          ]);
          await store.edges.otherRelates.bulkCreate([
            { from, to, props: { label: "Foreign" }, id: "delete-foreign" },
            {
              from,
              to,
              props: { label: "Foreign filler" },
              id: "delete-foreign-filler",
            },
          ]);
          return { expectedState: await deleteEdgesRefusal.observe() };
        },
        execute: () =>
          deleteEdgesRefusal
            .requireStore()
            .edges.relates.bulkDelete([
              "delete-valid" as never,
              "delete-foreign" as never,
            ]),
        observeState: deleteEdgesRefusal.observe,
        errorMatches: (error) => error instanceof ValidationError,
      },
    },
    ...buildResolvedCases(
      client,
      {
        mutateEdgesRefusal,
        mutateEdgesStale,
        mutateEdgesSuccess,
        mutateNodesRefusal,
        mutateNodesStale,
        mutateNodesSuccess,
        updateEdgesRefusal,
        updateEdgesStale,
        updateEdgesSuccess,
        updateNodesRefusal,
        updateNodesStale,
        updateNodesSuccess,
      },
      backend.capabilities.execution.interactiveTransactions,
    ),
    buildConvergenceCase(convergeSuccess, convergeStale, convergeRefusal),
  ];
  return cases.map((conformanceCase) => ({ ...conformanceCase, backend }));
}

type Scenario = ReturnType<typeof scenario>;

function buildResolvedCases(
  client: ReturnType<typeof createClient>,
  scenarios: Readonly<{
    mutateEdgesRefusal: Scenario;
    mutateEdgesStale: Scenario;
    mutateEdgesSuccess: Scenario;
    mutateNodesRefusal: Scenario;
    mutateNodesStale: Scenario;
    mutateNodesSuccess: Scenario;
    updateEdgesRefusal: Scenario;
    updateEdgesStale: Scenario;
    updateEdgesSuccess: Scenario;
    updateNodesRefusal: Scenario;
    updateNodesStale: Scenario;
    updateNodesSuccess: Scenario;
  }>,
  singletonUpdateRoute: boolean,
): readonly UnboundConformanceCase[] {
  return [
    buildNodeResolvedCase(
      "updateNodes",
      client,
      scenarios.updateNodesSuccess,
      scenarios.updateNodesStale,
      scenarios.updateNodesRefusal,
      false,
      singletonUpdateRoute,
    ),
    buildEdgeResolvedCase(
      "updateEdges",
      client,
      scenarios.updateEdgesSuccess,
      scenarios.updateEdgesStale,
      scenarios.updateEdgesRefusal,
      false,
      singletonUpdateRoute,
    ),
    buildNodeResolvedCase(
      "mutateNodes",
      client,
      scenarios.mutateNodesSuccess,
      scenarios.mutateNodesStale,
      scenarios.mutateNodesRefusal,
      true,
      singletonUpdateRoute,
    ),
    buildEdgeResolvedCase(
      "mutateEdges.resolvedSet",
      client,
      scenarios.mutateEdgesSuccess,
      scenarios.mutateEdgesStale,
      scenarios.mutateEdgesRefusal,
      true,
      singletonUpdateRoute,
    ),
  ];
}

function buildNodeResolvedCase(
  variant: "updateNodes" | "mutateNodes",
  client: ReturnType<typeof createClient>,
  success: Scenario,
  stale: Scenario,
  refusal: Scenario,
  mixed: boolean,
  singletonUpdateRoute: boolean,
): UnboundConformanceCase {
  return {
    variant,
    orderedSuccess: {
      prepare: async () => {
        const store = await success.open();
        await store.nodes.Person.bulkCreate([
          { id: `${variant}-a`, props: { name: "A", score: 1 } },
          { id: `${variant}-b`, props: { name: "B", score: 2 } },
        ]);
        return {
          expectedResult:
            mixed ?
              [
                [`${variant}-new`, "New", 3],
                [`${variant}-a`, "Updated", 4],
              ]
            : [
                [`${variant}-b`, "Updated B", 20],
                [`${variant}-a`, "Updated A", 10],
              ],
          expectedState: {
            edges: [],
            nodes:
              mixed ?
                [
                  [`${variant}-a`, "Updated", 4],
                  [`${variant}-b`, "B", 2],
                  [`${variant}-new`, "New", 3],
                ]
              : [
                  [`${variant}-a`, "Updated A", 10],
                  [`${variant}-b`, "Updated B", 20],
                ],
          },
        };
      },
      execute: async () => {
        if (!mixed && singletonUpdateRoute) {
          const collection = success.requireStore().nodes.Person;
          const second = await collection.update(`${variant}-b` as never, {
            name: "Updated B",
            score: 20,
          });
          const first = await collection.update(`${variant}-a` as never, {
            name: "Updated A",
            score: 10,
          });
          return [second, first].map((node) => [
            node.id,
            node.name,
            node.score,
          ]);
        }
        const inputs =
          mixed ?
            [
              {
                id: `${variant}-new`,
                props: { name: "New", score: 3 },
              },
              {
                id: `${variant}-a`,
                props: { name: "Updated", score: 4 },
              },
            ]
          : [
              {
                id: `${variant}-b`,
                props: { name: "Updated B", score: 20 },
              },
              {
                id: `${variant}-a`,
                props: { name: "Updated A", score: 10 },
              },
            ];
        const nodes = await success
          .requireStore()
          .nodes.Person.bulkUpsertById(inputs);
        return nodes.map((node) => [node.id, node.name, node.score]);
      },
      observeState: success.observe,
    },
    staleFenceNoWrite: {
      dispatch: "required",
      prepare: async () => {
        const store = await stale.open();
        await store.nodes.Person.bulkCreate([
          {
            id: `${variant}-stale-existing`,
            props: { name: "Existing", score: 1 },
          },
          {
            id: `${variant}-stale-filler`,
            props: { name: "Filler", score: 0 },
          },
        ]);
        await stale.stale();
        return { expectedState: await stale.observe() };
      },
      execute: () =>
        mixed ?
          stale.requireStore().nodes.Person.bulkUpsertById([
            {
              id: `${variant}-stale-new`,
              props: { name: "New", score: 2 },
            },
            {
              id: `${variant}-stale-existing`,
              props: { name: "Updated", score: 3 },
            },
          ])
        : singletonUpdateRoute ?
          stale
            .requireStore()
            .nodes.Person.update(`${variant}-stale-existing` as never, {
              name: "Updated",
              score: 3,
            })
        : stale.requireStore().nodes.Person.bulkUpsertById([
            {
              id: `${variant}-stale-existing`,
              props: { name: "Updated", score: 3 },
            },
          ]),
      observeState: stale.observe,
      errorMatches: (error) => error instanceof StaleVersionError,
    },
    semanticRefusalRollback: {
      dispatch: "required",
      prepare: async () => {
        const store = await refusal.open();
        await store.nodes.Person.bulkCreate([
          {
            id: `${variant}-refusal-existing`,
            props: { name: "Existing", score: 1 },
          },
          {
            id: `${variant}-refusal-filler`,
            props: { name: "Filler", score: 0 },
          },
        ]);
        await installUpdateRefusalTrigger(
          client,
          "typegraph_nodes",
          refusal.graph.id,
        );
        return { expectedState: await refusal.observe() };
      },
      execute: () =>
        mixed ?
          refusal.requireStore().nodes.Person.bulkUpsertById([
            {
              id: `${variant}-refusal-new`,
              props: { name: "New", score: 2 },
            },
            {
              id: `${variant}-refusal-existing`,
              props: { name: "Updated", score: 3 },
            },
          ])
        : singletonUpdateRoute ?
          refusal
            .requireStore()
            .nodes.Person.update(`${variant}-refusal-existing` as never, {
              name: "Updated",
              score: 3,
            })
        : refusal.requireStore().nodes.Person.bulkUpsertById([
            {
              id: `${variant}-refusal-existing`,
              props: { name: "Updated", score: 3 },
            },
          ]),
      observeState: refusal.observe,
      errorMatches: (error) => error instanceof DatabaseOperationError,
    },
  };
}

function buildEdgeResolvedCase(
  variant: "updateEdges" | "mutateEdges.resolvedSet",
  client: ReturnType<typeof createClient>,
  success: Scenario,
  stale: Scenario,
  refusal: Scenario,
  mixed: boolean,
  singletonUpdateRoute: boolean,
): UnboundConformanceCase {
  return {
    variant,
    orderedSuccess: {
      prepare: async () => {
        const store = await success.open();
        await seedEdgeScenario(store, `${variant}-success`);
        if (!mixed) {
          const from = requireDefined(
            await store.nodes.Person.getById(
              `${variant}-success-from` as never,
            ),
          );
          const to = requireDefined(
            await store.nodes.Person.getById(`${variant}-success-to` as never),
          );
          await store.edges.relates.bulkCreate([
            {
              from,
              to,
              props: { label: "Second" },
              id: `${variant}-success-second`,
            },
            {
              from,
              to,
              props: { label: "Third" },
              id: `${variant}-success-third`,
            },
          ]);
        }
        return {
          expectedResult:
            mixed ?
              [
                [`${variant}-success-new`, "New"],
                [`${variant}-success-existing`, "Updated"],
              ]
            : [
                [`${variant}-success-second`, "Updated Second"],
                [`${variant}-success-existing`, "Updated Existing"],
              ],
          expectedState: {
            nodes: [
              [`${variant}-success-from`, "From", 1],
              [`${variant}-success-to`, "To", 2],
            ],
            edges:
              mixed ?
                [
                  [
                    `${variant}-success-existing`,
                    "relates",
                    `${variant}-success-from`,
                    `${variant}-success-to`,
                    "Updated",
                  ],
                  [
                    `${variant}-success-filler`,
                    "relates",
                    `${variant}-success-from`,
                    `${variant}-success-to`,
                    "Filler",
                  ],
                  [
                    `${variant}-success-new`,
                    "relates",
                    `${variant}-success-from`,
                    `${variant}-success-to`,
                    "New",
                  ],
                ]
              : [
                  [
                    `${variant}-success-existing`,
                    "relates",
                    `${variant}-success-from`,
                    `${variant}-success-to`,
                    "Updated Existing",
                  ],
                  [
                    `${variant}-success-filler`,
                    "relates",
                    `${variant}-success-from`,
                    `${variant}-success-to`,
                    "Filler",
                  ],
                  [
                    `${variant}-success-second`,
                    "relates",
                    `${variant}-success-from`,
                    `${variant}-success-to`,
                    "Updated Second",
                  ],
                  [
                    `${variant}-success-third`,
                    "relates",
                    `${variant}-success-from`,
                    `${variant}-success-to`,
                    "Third",
                  ],
                ],
          },
        };
      },
      execute: async () => {
        const store = success.requireStore();
        if (!mixed && singletonUpdateRoute) {
          const second = await store.edges.relates.update(
            `${variant}-success-second` as never,
            { label: "Updated Second" },
          );
          const first = await store.edges.relates.update(
            `${variant}-success-existing` as never,
            { label: "Updated Existing" },
          );
          return [second, first].map((edge) => [edge.id, edge.label]);
        }
        const from = requireDefined(
          await store.nodes.Person.getById(`${variant}-success-from` as never),
        );
        const to = requireDefined(
          await store.nodes.Person.getById(`${variant}-success-to` as never),
        );
        const inputs =
          mixed ?
            [
              {
                id: `${variant}-success-new` as never,
                from,
                to,
                props: { label: "New" },
              },
              {
                id: `${variant}-success-existing` as never,
                from,
                to,
                props: { label: "Updated" },
              },
            ]
          : [
              {
                id: `${variant}-success-second` as never,
                from,
                to,
                props: { label: "Updated Second" },
              },
              {
                id: `${variant}-success-existing` as never,
                from,
                to,
                props: { label: "Updated Existing" },
              },
            ];
        const edges = await store.edges.relates.bulkUpsertById(inputs);
        return edges.map((edge) => [edge.id, edge.label]);
      },
      observeState: success.observe,
    },
    staleFenceNoWrite: {
      dispatch: "required",
      prepare: async () => {
        const store = await stale.open();
        await seedEdgeScenario(store, `${variant}-stale`);
        await stale.stale();
        return { expectedState: await stale.observe() };
      },
      execute: async () => {
        const store = stale.requireStore();
        if (!mixed && singletonUpdateRoute) {
          return store.edges.relates.update(
            `${variant}-stale-existing` as never,
            { label: "Updated" },
          );
        }
        const from = requireDefined(
          await store.nodes.Person.getById(`${variant}-stale-from` as never),
        );
        const to = requireDefined(
          await store.nodes.Person.getById(`${variant}-stale-to` as never),
        );
        return store.edges.relates.bulkUpsertById(
          mixed ?
            [
              {
                id: `${variant}-stale-new` as never,
                from,
                to,
                props: { label: "New" },
              },
              {
                id: `${variant}-stale-existing` as never,
                from,
                to,
                props: { label: "Updated" },
              },
            ]
          : [
              {
                id: `${variant}-stale-existing` as never,
                from,
                to,
                props: { label: "Updated" },
              },
            ],
        );
      },
      observeState: stale.observe,
      errorMatches: (error) => error instanceof StaleVersionError,
    },
    semanticRefusalRollback: {
      dispatch: "required",
      prepare: async () => {
        const store = await refusal.open();
        await seedEdgeScenario(store, `${variant}-refusal`);
        await installUpdateRefusalTrigger(
          client,
          "typegraph_edges",
          refusal.graph.id,
        );
        return { expectedState: await refusal.observe() };
      },
      execute: async () => {
        const store = refusal.requireStore();
        if (!mixed && singletonUpdateRoute) {
          return store.edges.relates.update(
            `${variant}-refusal-existing` as never,
            { label: "Updated" },
          );
        }
        const from = requireDefined(
          await store.nodes.Person.getById(`${variant}-refusal-from` as never),
        );
        const to = requireDefined(
          await store.nodes.Person.getById(`${variant}-refusal-to` as never),
        );
        return store.edges.relates.bulkUpsertById(
          mixed ?
            [
              {
                id: `${variant}-refusal-new` as never,
                from,
                to,
                props: { label: "New" },
              },
              {
                id: `${variant}-refusal-existing` as never,
                from,
                to,
                props: { label: "Updated" },
              },
            ]
          : [
              {
                id: `${variant}-refusal-existing` as never,
                from,
                to,
                props: { label: "Updated" },
              },
            ],
        );
      },
      observeState: refusal.observe,
      errorMatches: (error) => error instanceof DatabaseOperationError,
    },
  };
}

function buildConvergenceCase(
  success: Scenario,
  stale: Scenario,
  refusal: Scenario,
): UnboundConformanceCase {
  const variant = "mutateEdges.durableConvergence" as const;
  async function durableState(target: Scenario) {
    const state = await target.observe();
    return {
      nodes: state.nodes,
      edges: state.edges
        .map((edge) => [edge[1], edge[2], edge[3], edge[4]] as const)
        .toSorted((left, right) => left[3].localeCompare(right[3])),
    };
  }
  return {
    variant,
    orderedSuccess: {
      prepare: async () => {
        const store = await success.open();
        await seedPeople(store, "converge");
        return {
          expectedResult: [
            ["created", "B"],
            ["created", "A"],
          ],
          expectedState: {
            nodes: [
              ["converge-from", "From", 1],
              ["converge-to", "To", 2],
            ],
            edges: [
              ["durableRelates", "converge-from", "converge-to", "A"],
              ["durableRelates", "converge-from", "converge-to", "B"],
            ],
          },
        };
      },
      execute: async () => {
        const store = success.requireStore();
        const from = requireDefined(
          await store.nodes.Person.getById("converge-from" as never),
        );
        const to = requireDefined(
          await store.nodes.Person.getById("converge-to" as never),
        );
        const results =
          await store.edges.durableRelates.bulkGetOrCreateByEndpoints([
            { from, to, props: { label: "B" } },
            { from, to, props: { label: "A" } },
          ]);
        return results.map((result) => [result.action, result.edge.label]);
      },
      observeState: () => durableState(success),
    },
    staleFenceNoWrite: {
      dispatch: "required",
      prepare: async () => {
        const store = await stale.open();
        await seedPeople(store, "converge-stale");
        await stale.stale();
        return { expectedState: await durableState(stale) };
      },
      execute: async () => {
        const store = stale.requireStore();
        const from = requireDefined(
          await store.nodes.Person.getById("converge-stale-from" as never),
        );
        const to = requireDefined(
          await store.nodes.Person.getById("converge-stale-to" as never),
        );
        return store.edges.durableRelates.bulkGetOrCreateByEndpoints([
          { from, to, props: { label: "Stale" } },
        ]);
      },
      observeState: () => durableState(stale),
      errorMatches: (error) => error instanceof StaleVersionError,
    },
    semanticRefusalRollback: {
      dispatch: "required",
      prepare: async () => {
        const store = await refusal.open();
        await seedPeople(store, "converge-refusal");
        return { expectedState: await durableState(refusal) };
      },
      execute: async () => {
        const store = refusal.requireStore();
        const from = requireDefined(
          await store.nodes.Person.getById("converge-refusal-from" as never),
        );
        const to = requireDefined(
          await store.nodes.Person.getById("converge-refusal-to" as never),
        );
        return store.edges.durableRelates.bulkGetOrCreateByEndpoints([
          { from, to, props: { label: "Valid" } },
          {
            from,
            to: { kind: Person.kind, id: "missing-person" } as typeof to,
            props: { label: "Invalid" },
          },
        ]);
      },
      observeState: () => durableState(refusal),
      errorMatches: (error) => error instanceof EndpointNotFoundError,
    },
  };
}

describe("bundled atomic mutation program semantic conformance: libSQL", () => {
  const clients: ReturnType<typeof createClient>[] = [];

  afterEach(() => {
    for (const client of clients) client.close();
    clients.length = 0;
  });

  it("certifies every reachable family variant against one exact bundled root", async () => {
    const client = createClient({ url: "file::memory:" });
    clients.push(client);
    const { backend } = await createLibsqlBackend(client);
    PRIVILEGED_SCHEMA_BACKENDS.set(backend, backend);

    try {
      const required = reachableAtomicMutationProgramVariants(
        requireDefined(resolveAtomicMutationPrograms(backend)),
        backend.capabilities.execution,
      );
      expect(required).toEqual([
        "createNodes",
        "replaceNodes",
        "createEdges",
        "deleteNodes",
        "deleteEdges",
        "updateNodes",
        "updateEdges",
        "mutateEdges.durableConvergence",
      ]);
      const report = await runAtomicMutationProgramConformance({
        backend,
        cases: buildCases(client, backend).filter((conformanceCase) =>
          required.includes(conformanceCase.variant),
        ),
        derivedBackends: [deriveBackend(backend, {})],
        equal,
      });

      expect(report.variants.map((entry) => entry.variant)).toEqual(required);
      expect(report.provenance).toEqual({
        passed: [
          "exact root registration",
          "derived backend lineage",
          "derived backend isolation",
          "transaction backend isolation",
        ],
        skipped: [],
      });
    } finally {
      await backend.close();
    }
  });

  it("certifies update-only and mixed variants on a transactionless bundled root", async () => {
    const client = createClient({ url: "file::memory:" });
    clients.push(client);
    const { backend: schemaBackend, db } = await createLibsqlBackend(client);
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: false, transactionMode: "none" },
    });
    PRIVILEGED_SCHEMA_BACKENDS.set(backend, schemaBackend);

    try {
      const report = await runAtomicMutationProgramConformance({
        backend,
        cases: buildCases(client, backend),
        derivedBackends: [deriveBackend(backend, {})],
        equal,
      });

      expect(report.variants.map((entry) => entry.variant)).toEqual(
        ATOMIC_MUTATION_PROGRAM_VARIANTS,
      );
      expect(report.provenance).toEqual({
        passed: [
          "exact root registration",
          "derived backend lineage",
          "derived backend isolation",
        ],
        skipped: ["transaction backend isolation"],
      });
    } finally {
      await backend.close();
    }
  });
});
