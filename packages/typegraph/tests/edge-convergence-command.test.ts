import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStore,
  defineEdge,
  defineGraph,
  defineNode,
  EndpointNotFoundError,
} from "../src";
import { assertCommandResultMatchesCommand } from "../src/backend/command";
import { graphCommandExecutionContext } from "../src/backend/command-contract";
import { deriveBackend } from "../src/backend/derive-backend";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresOperationStrategy } from "../src/backend/drizzle/operations/strategy";
import { tables as postgresTables } from "../src/backend/drizzle/schema/postgres";
import { createPostgresBackend } from "../src/backend/postgres";
import type {
  EdgeConvergeCreateCommand,
  EdgeConvergeCreateCommandResult,
  GraphBackend,
  GraphCommand,
  GraphCommandPort,
} from "../src/backend/types";
import { tsvectorStrategy } from "../src/query/dialect/fulltext-strategy";
import { createStore } from "../src/store";
import {
  createRecordedBackend,
  lockRecordedGraphWrite,
} from "../src/store/recorded-capture";
import { requireDefined } from "../src/utils/presence";

function convergenceCommand(
  id: string,
  props: Record<string, unknown>,
  matchOn: readonly string[],
): EdgeConvergeCreateCommand {
  return {
    kind: "edge.converge-create",
    plan: {
      entity: "edge",
      params: {
        graphId: "convergence-command",
        kind: "knows",
        id,
        fromKind: "Person",
        fromId: "alice",
        toKind: "Person",
        toId: "bob",
        props,
      },
    },
    match: { kind: "dynamic", matchOn, props },
  };
}

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", {
  schema: z.object({ label: z.string() }),
});
const graph = defineGraph({
  id: "convergence-command-store",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

async function executeConvergence(
  backend: GraphBackend,
  command: EdgeConvergeCreateCommand,
): Promise<EdgeConvergeCreateCommandResult> {
  return backend.transaction(async (transaction) => {
    const coordination = await lockRecordedGraphWrite(
      transaction,
      command.plan.params.graphId,
    );
    const result = await transaction.commands.execute(
      command,
      graphCommandExecutionContext(
        "transaction",
        coordination.coordination ?? "none",
      ),
    );
    assertCommandResultMatchesCommand(command, result);
    return result;
  });
}

describe("PostgreSQL edge convergence command", () => {
  it("refuses convergence under a repeatable-read server default", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      await client.exec(
        "SET default_transaction_isolation = 'repeatable read'",
      );
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      const store = createAdapterStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      await expect(
        store.edges.knows.getOrCreateByEndpoints(
          alice,
          bob,
          { label: "unsafe-default" },
          { matchOn: ["label"] },
        ),
      ).rejects.toMatchObject({
        details: {
          code: "MATCH_KEY_CONVERGENCE_REQUIRES_FRESH_SNAPSHOT",
          isolation: "repeatable_read",
        },
      });
    } finally {
      await client.close();
    }
  });

  it("allows an adopted transaction to return an existing match", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const db = drizzlePglite(client);
      const backend = createPostgresBackend(db, { vector: false });
      const store = createAdapterStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "existing" },
        { matchOn: ["label"] },
      );

      const result = await db.transaction(
        async (externalTransaction) => {
          const transactionStore = store.withTransaction(externalTransaction);
          const single =
            await transactionStore.edges.knows.getOrCreateByEndpoints(
              alice,
              bob,
              { label: "existing" },
              { matchOn: ["label"] },
            );
          const bulk =
            await transactionStore.edges.knows.bulkGetOrCreateByEndpoints(
              [
                {
                  from: alice,
                  to: bob,
                  props: { label: "existing" },
                },
              ],
              { matchOn: ["label"] },
            );
          return { bulk, single };
        },
        { isolationLevel: "repeatable read" },
      );

      expect(result.single.action).toBe("found");
      expect(result.bulk).toMatchObject([{ action: "found" }]);
    } finally {
      await client.close();
    }
  });

  it("refuses an adopted repeatable-read bulk create", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const db = drizzlePglite(client);
      const backend = createPostgresBackend(db, { vector: false });
      const store = createAdapterStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      await expect(
        db.transaction(
          async (externalTransaction) =>
            store
              .withTransaction(externalTransaction)
              .edges.knows.bulkGetOrCreateByEndpoints(
                [
                  {
                    from: alice,
                    to: bob,
                    props: { label: "unsafe-bulk-create" },
                  },
                ],
                { matchOn: ["label"] },
              ),
          { isolationLevel: "repeatable read" },
        ),
      ).rejects.toMatchObject({
        details: {
          code: "MATCH_KEY_CONVERGENCE_REQUIRES_FRESH_SNAPSHOT",
          isolation: "repeatable_read",
        },
      });
    } finally {
      await client.close();
    }
  });

  it("refuses a PostgreSQL override that falsely claims serialized writers", async () => {
    const client = await PGlite.create();
    try {
      expect(() =>
        createPostgresBackend(drizzlePglite(client), {
          capabilities: {
            pessimisticLocks: {
              advisoryLocks: false,
              tableLocks: false,
              serializedWriters: true,
            },
          },
          vector: false,
        }),
      ).toThrow("cannot claim serialized writers");
    } finally {
      await client.close();
    }
  });

  it("uses exact match-key equality and deterministic winner ordering", () => {
    const strategy = createPostgresOperationStrategy(
      postgresTables,
      tsvectorStrategy,
    );
    const query = requireDefined(strategy.buildConvergeEdgeCreate)({
      params: convergenceCommand("edge-a", { label: "friend" }, ["label"]).plan
        .params,
      match: {
        kind: "dynamic",
        matchOn: ["label"],
        props: { label: "friend" },
      },
      timestamp: "2026-08-23T00:00:00.000Z",
    });
    const compiled = new PgDialect().sqlToQuery(query);
    const statement = compiled.sql.toLowerCase();

    expect(statement).toContain('"candidate"."props" -> $');
    expect(statement).not.toContain("@>");
    expect(statement).toContain(
      'order by "candidate"."deleted_at" is null desc, "candidate"."created_at" desc, "candidate"."id" desc',
    );
    expect(statement).not.toContain("pg_advisory_xact_lock");
  });

  it("refuses an uncoordinated root command and converges in a locked transaction", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      await backend.insertNode({
        graphId: "convergence-command",
        kind: "Person",
        id: "alice",
        props: {},
      });
      await backend.insertNode({
        graphId: "convergence-command",
        kind: "Person",
        id: "bob",
        props: {},
      });

      const command = convergenceCommand("edge-a", { label: "friend" }, [
        "label",
      ]);
      const rootResult = await backend.commands.execute(
        command,
        graphCommandExecutionContext("root"),
      );
      await expect(
        backend.commands.execute(
          command,
          graphCommandExecutionContext("transaction"),
        ),
      ).rejects.toThrow("does not match its bound command port");
      const created = await executeConvergence(backend, command);
      const found = await executeConvergence(
        backend,
        convergenceCommand("edge-b", { label: "friend" }, ["label"]),
      );

      expect(rootResult).toEqual({
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["convergence"],
      });
      expect(created).toMatchObject({ outcome: "created", entity: "edge" });
      expect(found).toMatchObject({
        outcome: "found",
        entity: "edge",
        row: { id: "edge-a" },
      });
      expect(
        await backend.findEdgesByKind({
          graphId: "convergence-command",
          kind: "knows",
          excludeDeleted: false,
          temporalMode: "includeTombstones",
        }),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("distinguishes an absent match property from JSON null", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      for (const id of ["alice", "bob"]) {
        await backend.insertNode({
          graphId: "convergence-command",
          kind: "Person",
          id,
          props: {},
        });
      }

      const jsonNull = z.null().parse(JSON.parse("null"));
      const withNull = await executeConvergence(
        backend,
        convergenceCommand("edge-null", { label: jsonNull }, ["label"]),
      );
      const withAbsent = await executeConvergence(
        backend,
        convergenceCommand("edge-absent", {}, ["label"]),
      );

      expect(withNull.outcome).toBe("created");
      expect(withAbsent.outcome).toBe("created");
    } finally {
      await client.close();
    }
  });

  it("does not treat a nested object subset as an exact match", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      for (const id of ["alice", "bob"]) {
        await backend.insertNode({
          graphId: "convergence-command",
          kind: "Person",
          id,
          props: {},
        });
      }

      const broadObject = await executeConvergence(
        backend,
        convergenceCommand("edge-broad", { label: { a: 1, b: 2 } }, ["label"]),
      );
      const subsetObject = await executeConvergence(
        backend,
        convergenceCommand("edge-subset", { label: { a: 1 } }, ["label"]),
      );

      expect(broadObject.outcome).toBe("created");
      expect(subsetObject.outcome).toBe("created");
    } finally {
      await client.close();
    }
  });

  it("routes the Store no-match leg through the transaction command port", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      const observed: GraphCommand[] = [];
      const instrumented = deriveBackend(backend, {
        transaction: (run, options) =>
          backend.transaction(
            (transaction) =>
              run(
                deriveBackend(transaction, {
                  commands: {
                    session: transaction.commands.session,
                    execute(command, context) {
                      observed.push(command);
                      return transaction.commands.execute(command, context);
                    },
                  } satisfies GraphCommandPort,
                }),
              ),
            options,
          ),
      });
      const store = createStore(graph, instrumented);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      const result = await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend" },
        { matchOn: ["label"] },
      );

      expect(result.action).toBe("created");
      expect(
        observed.filter((command) => command.kind === "edge.converge-create"),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("preserves advisory-lock command binding through recorded capture", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      expect(createRecordedBackend(backend).commands.session).toBe("root");
      const store = createStore(graph, backend, { history: true });
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      await expect(
        store.edges.knows.getOrCreateByEndpoints(
          alice,
          bob,
          { label: "recorded" },
          { matchOn: ["label"] },
        ),
      ).resolves.toMatchObject({ action: "created" });
    } finally {
      await client.close();
    }
  });

  it("refuses repeatable-read convergence after the existing-match lookup", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      let matchLookups = 0;
      const counted = deriveBackend(backend, {
        transaction: (run, options) =>
          backend.transaction(
            (transaction) =>
              run(
                deriveBackend(transaction, {
                  findEdgesByKind(params) {
                    matchLookups += 1;
                    return transaction.findEdgesByKind(params);
                  },
                }),
              ),
            options,
          ),
      });
      const store = createStore(graph, counted);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      matchLookups = 0;
      await expect(
        store.transaction(
          (transaction) =>
            transaction.edges.knows.getOrCreateByEndpoints(
              alice,
              bob,
              { label: "repeatable" },
              { matchOn: ["label"] },
            ),
          { isolationLevel: "repeatable_read" },
        ),
      ).rejects.toMatchObject({
        details: { code: "MATCH_KEY_CONVERGENCE_REQUIRES_FRESH_SNAPSHOT" },
      });
      expect(matchLookups).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("checks the actual transaction target when a root backend wraps an unsafe port", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      let matchLookups = 0;
      const unsafe = deriveBackend(backend, {
        transaction: (run, options) =>
          backend.transaction((transaction) => {
            const opaqueCommands = {
              session: "transaction" as const,
              execute(command, context) {
                return transaction.commands.execute(command, context);
              },
            } satisfies GraphCommandPort;
            // This deliberately models a third-party transaction wrapper that
            // does not derive its command port, so its isolation is unknown.
            const unsafeTransaction = new Proxy(transaction, {
              get(target, property, receiver) {
                if (property === "commands") return opaqueCommands;
                if (property === "findEdgesByKind") {
                  return (
                    params: Parameters<typeof target.findEdgesByKind>[0],
                  ) => {
                    matchLookups += 1;
                    return target.findEdgesByKind(params);
                  };
                }
                return Reflect.get(target, property, receiver) as unknown;
              },
            });
            return run(unsafeTransaction);
          }, options),
      });
      const store = createStore(graph, unsafe);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      matchLookups = 0;
      await expect(
        store.edges.knows.getOrCreateByEndpoints(
          alice,
          bob,
          { label: "unsafe" },
          { matchOn: ["label"] },
        ),
      ).rejects.toThrow("coordination does not belong");
      expect(matchLookups).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("uses portable endpoint validation when a custom port refuses its predicate", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      let refusedEndpointCommands = 0;
      const refusingBackend = deriveBackend(backend, {
        transaction: (run, options) =>
          backend.transaction(
            (transaction) =>
              run(
                deriveBackend(transaction, {
                  commands: {
                    session: transaction.commands.session,
                    execute(command, context) {
                      if (command.kind === "edge.create") {
                        refusedEndpointCommands += 1;
                        return Promise.resolve({
                          outcome: "unsupported" as const,
                          entity: "edge" as const,
                          dimensions: ["endpointPredicate"] as const,
                        });
                      }
                      return transaction.commands.execute(command, context);
                    },
                  },
                }),
              ),
            options,
          ),
      });
      const store = createStore(graph, refusingBackend);
      const alice = await store.nodes.Person.create({ name: "Alice" });

      await expect(
        store.edges.knows.create(
          alice,
          { kind: "Person", id: "missing" },
          { label: "portable" },
        ),
      ).rejects.toBeInstanceOf(EndpointNotFoundError);
      expect(refusedEndpointCommands).toBe(1);
      expect(await store.edges.knows.find()).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("resurrects the tombstone returned by the authoritative command", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generatePostgresDDL().join("\n\n"));
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      const setup = createStore(graph, backend);
      const alice = await setup.nodes.Person.create({ name: "Alice" });
      const bob = await setup.nodes.Person.create({ name: "Bob" });
      const created = await setup.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend" },
        { matchOn: ["label"] },
      );
      await setup.edges.knows.delete(created.edge.id);

      const staleRoot = deriveBackend(backend, {
        findEdgesByKind: () => Promise.resolve([]),
        getEdge: () => Promise.resolve(undefined),
      });
      const resurrected = await createStore(
        graph,
        staleRoot,
      ).edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend" },
        { matchOn: ["label"] },
      );

      expect(resurrected.action).toBe("resurrected");
      expect(resurrected.edge.id).toBe(created.edge.id);
    } finally {
      await client.close();
    }
  });
});
