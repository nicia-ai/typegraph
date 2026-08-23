/**
 * Postgres/PGlite coverage for the Store's persisted edge-match key boundary.
 *
 * JSONB returns persisted values, while callers can supply JavaScript values
 * such as Dates and nested `undefined`. Every public match-key entry point
 * must compare the same persisted representation.
 */
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import { assertCommandResultMatchesCommand } from "../../../src/backend/command";
import { graphCommandExecutionContext } from "../../../src/backend/command-contract";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createPostgresBackend } from "../../../src/backend/postgres";
import type {
  EdgeConvergeCreateCommand,
  EdgeConvergeCreateCommandResult,
  GraphBackend,
  TransactionBackend,
} from "../../../src/backend/types";
import { createStore } from "../../../src/store";
import { lockRecordedGraphWrite } from "../../../src/store/recorded-capture";
import {
  setupSharedPgliteEngine,
  type SharedPgliteEngine,
} from "./pglite-correctness-harness";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const annotatedAt = defineEdge("annotatedAt", {
  schema: z.object({
    at: z.date(),
    annotation: z.object({ label: z.string().optional() }),
  }),
});

const graph = defineGraph({
  id: "pglite_edge_match_normalization",
  nodes: { Person: { type: Person } },
  edges: {
    annotatedAt: { type: annotatedAt, from: [Person], to: [Person] },
  },
});

let engine: SharedPgliteEngine;

beforeAll(async () => {
  engine = await setupSharedPgliteEngine();
});

afterAll(async () => {
  await engine.dispose();
});

beforeEach(async () => {
  await engine.resetData();
});

describe("PGlite persisted edge match keys", () => {
  it("normalizes Date and nested undefined consistently across single, bulk, and find", async () => {
    const store = createStore(graph, engine.makeBackend());
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const props = {
      at: new Date("2026-08-23T00:00:00.000Z"),
      annotation: { label: undefined },
    };
    const options = { matchOn: ["at", "annotation"] } as const;

    const created = await store.edges.annotatedAt.getOrCreateByEndpoints(
      alice,
      bob,
      props,
      options,
    );
    const [bulk] = await store.edges.annotatedAt.bulkGetOrCreateByEndpoints(
      [{ from: alice, to: bob, props }],
      options,
    );
    const found = await store.edges.annotatedAt.findByEndpoints(alice, bob, {
      ...options,
      props,
    });

    expect(created.action).toBe("created");
    expect(bulk).toMatchObject({
      action: "found",
      edge: { id: created.edge.id },
    });
    expect(found?.id).toBe(created.edge.id);
    expect(await store.edges.annotatedAt.findFrom(alice)).toHaveLength(1);
  });

  it("refuses a converged row whose match key differs from the request", async () => {
    const raw = engine.makeBackend();
    const backend = wrongMatchConvergenceBackend(raw);
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    await expect(
      store.edges.annotatedAt.getOrCreateByEndpoints(
        alice,
        bob,
        {
          at: new Date("2026-08-23T00:00:00.000Z"),
          annotation: { label: "requested" },
        },
        { matchOn: ["at", "annotation"] },
      ),
    ).rejects.toThrow("could not resolve a stable matching edge");
  });

  it("accepts a driver string for the convergent write discriminator", async () => {
    const backend = createPostgresBackend(
      drizzlePglite(stringDiscriminatorClient(engine.client)),
      { prepareStatements: false, vector: false },
    );
    for (const id of ["alice", "bob"]) {
      await backend.insertNode({
        graphId: graph.id,
        kind: "Person",
        id,
        props: {},
      });
    }

    const result = await executeConvergence(
      backend,
      convergenceCommand("string-discriminator", {
        at: new Date("2026-08-23T00:00:00.000Z"),
        annotation: {},
      }),
    );

    expect(result).toMatchObject({
      outcome: "created",
      entity: "edge",
      row: { id: "string-discriminator" },
    });
  });

  it("refuses a null convergent write discriminator", async () => {
    const backend = createPostgresBackend(
      drizzlePglite(
        discriminatorClient(engine.client, () => JSON.parse("null") as unknown),
      ),
      { prepareStatements: false, vector: false },
    );
    for (const id of ["alice", "bob"]) {
      await backend.insertNode({
        graphId: graph.id,
        kind: "Person",
        id,
        props: {},
      });
    }

    await expect(
      executeConvergence(
        backend,
        convergenceCommand("null-discriminator", {
          at: new Date("2026-08-23T00:00:00.000Z"),
          annotation: {},
        }),
      ),
    ).rejects.toThrow("unknown write discriminator");
  });
});

function convergenceCommand(
  id: string,
  props: Record<string, unknown>,
): EdgeConvergeCreateCommand {
  return {
    kind: "edge.converge-create",
    plan: {
      entity: "edge",
      params: {
        graphId: graph.id,
        kind: "annotatedAt",
        id,
        fromKind: "Person",
        fromId: "alice",
        toKind: "Person",
        toId: "bob",
        props,
      },
    },
    match: { matchOn: ["at", "annotation"], props },
  };
}

async function executeConvergence(
  backend: GraphBackend,
  command: EdgeConvergeCreateCommand,
): Promise<EdgeConvergeCreateCommandResult> {
  return backend.transaction(async (transaction) => {
    const lock = await lockRecordedGraphWrite(
      transaction,
      command.plan.params.graphId,
    );
    const result = await transaction.commands.execute(
      command,
      graphCommandExecutionContext("transaction", lock.coordination ?? "none"),
    );
    assertCommandResultMatchesCommand(command, result);
    return result;
  });
}

function stringDiscriminatorClient(client: PGlite): PGlite {
  return discriminatorClient(client, String);
}

function discriminatorClient(
  client: PGlite,
  mapDiscriminator: (value: unknown) => unknown,
): PGlite {
  return new Proxy(client, {
    get(target, property): unknown {
      if (property === "query")
        return discriminatorQuery.bind(undefined, target, mapDiscriminator);
      if (property === "constructor") return target.constructor;
      if (property === "transaction") {
        return async <T>(
          run: (transaction: Transaction) => Promise<T>,
        ): Promise<T> =>
          target.transaction(async (transaction) =>
            run(discriminatorTransaction(transaction, mapDiscriminator)),
          );
      }
      return undefined;
    },
  });
}

function discriminatorTransaction(
  transaction: Transaction,
  mapDiscriminator: (value: unknown) => unknown,
): Transaction {
  return new Proxy(transaction, {
    get(target, property): unknown {
      if (property === "query") {
        return discriminatorQuery.bind(undefined, target, mapDiscriminator);
      }
      return undefined;
    },
  });
}

async function discriminatorQuery(
  client: PGlite | Transaction,
  mapDiscriminator: (value: unknown) => unknown,
  query: string,
  params?: unknown[],
): Promise<unknown> {
  const result = await client.query<Record<string, unknown>>(query, params);
  return {
    ...result,
    rows: result.rows.map((row) => {
      if (!("write_discriminator" in row)) return row;
      return {
        ...row,
        write_discriminator: mapDiscriminator(row["write_discriminator"]),
      };
    }),
  };
}

function wrongMatchConvergenceBackend(backend: GraphBackend): GraphBackend {
  return deriveBackend(backend, {
    transaction: async <T>(
      run: (transaction: TransactionBackend) => Promise<T>,
      options?: Parameters<GraphBackend["transaction"]>[1],
    ): Promise<T> =>
      backend.transaction(
        (transaction) =>
          run(
            deriveBackend(transaction, {
              commands: {
                session: transaction.commands.session,
                execute(command, context) {
                  if (command.kind !== "edge.converge-create") {
                    return transaction.commands.execute(command, context);
                  }
                  return Promise.resolve({
                    outcome: "found" as const,
                    entity: "edge" as const,
                    row: {
                      graph_id: command.plan.params.graphId,
                      id: "wrong-match",
                      kind: command.plan.params.kind,
                      from_kind: command.plan.params.fromKind,
                      from_id: command.plan.params.fromId,
                      to_kind: command.plan.params.toKind,
                      to_id: command.plan.params.toId,
                      props: {
                        at: "2026-08-24T00:00:00.000Z",
                        annotation: { label: "different" },
                      },
                      valid_from: undefined,
                      valid_to: undefined,
                      created_at: "2026-08-23T00:00:00.000Z",
                      updated_at: "2026-08-23T00:00:00.000Z",
                      deleted_at: undefined,
                    },
                  });
                },
              },
            }),
          ),
        options,
      ),
  });
}
