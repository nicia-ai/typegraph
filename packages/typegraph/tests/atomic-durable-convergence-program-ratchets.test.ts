import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";

import { CompilerInvariantError, StaleVersionError } from "../src";
import {
  type AtomicEdgeConvergenceEntry,
  resolveBundledRootAtomicMutationPrograms,
} from "../src/backend/capabilities/atomic-mutation-program";
import type { AnyPgDatabase } from "../src/backend/drizzle/execution/postgres-execution";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { D1_MAX_BIND_PARAMETERS } from "../src/backend/types";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { migrateSchema } from "../src/schema";
import { createStoreWithSchema } from "../src/store";
import { resolveAtomicEdgeConvergenceExecutor } from "../src/store/operations/atomic-mutation-program";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

const durableGraph = defineGraph({
  id: "atomic-durable-convergence-program-ratchets",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      matchIdentity: { name: "role", fields: ["role"] },
    },
  },
});

const evolvedGraph = defineGraph({
  id: durableGraph.id,
  nodes: {
    Person: {
      type: defineNode("Person", {
        schema: z.object({ name: z.string(), nickname: z.string().optional() }),
      }),
    },
    Company: { type: Company },
  },
  edges: durableGraph.edges,
});

const schemaFence = { graphId: durableGraph.id, expectedVersion: 1 } as const;

function convergenceEntry(
  id: string,
  index: number,
): AtomicEdgeConvergenceEntry {
  const key = `role-${index}`;
  return {
    params: {
      graphId: durableGraph.id,
      id,
      kind: "worksAt",
      fromKind: "Person",
      fromId: `person-${index}`,
      toKind: "Company",
      toId: `company-${index}`,
      props: { role: key },
      matchIdentity: { name: "role", key },
    },
    match: { kind: "durable", identity: { name: "role", key } },
  };
}

function edgeResultRow(
  entry: AtomicEdgeConvergenceEntry,
  dialect: "postgres" | "sqlite",
): Record<string, unknown> {
  const { params } = entry;
  const identity = requireDefined(params.matchIdentity);
  return {
    graph_id: params.graphId,
    id: params.id,
    kind: params.kind,
    from_kind: params.fromKind,
    from_id: params.fromId,
    to_kind: params.toKind,
    to_id: params.toId,
    props: dialect === "sqlite" ? JSON.stringify(params.props) : params.props,
    match_identity_name: identity.name,
    match_identity_key: identity.key,
    valid_from: undefined,
    valid_to: undefined,
    created_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:00:00.000Z",
    deleted_at: undefined,
  };
}

type NeonRows = (
  sqlText: string,
  params: readonly unknown[],
) => readonly Record<string, unknown>[];

type NeonQuery = (
  sqlText: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

function makeNeonDatabase(rows: NeonRows): Readonly<{
  db: AnyPgDatabase;
  query: Mock<NeonQuery>;
}> {
  const query = vi.fn((sqlText: string, params: readonly unknown[]) =>
    Promise.resolve(
      rows(sqlText, params).map((row) => ({ ...row, sqlText, params })),
    ),
  );
  const transaction = vi.fn(
    async (queries: readonly Promise<readonly unknown[]>[]) =>
      Promise.all(queries),
  );
  const neonClient = Object.assign(vi.fn(), { query, transaction });
  const db = {
    $client: neonClient,
    dialect: {
      sqlToQuery(query: SQL) {
        return new PgDialect().sqlToQuery(query);
      },
    },
    execute: vi.fn(),
  } as unknown as AnyPgDatabase;
  return { db, query };
}

type BoundD1Statement = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

function makeD1Database(rows: readonly Record<string, unknown>[]): Readonly<{
  batch: ReturnType<typeof vi.fn>;
  boundStatements: BoundD1Statement[];
  db: AnySqliteDatabase;
}> {
  const boundStatements: BoundD1Statement[] = [];
  const prepare = vi.fn((sqlText: string) => ({
    bind(...params: readonly unknown[]) {
      const statement = { sql: sqlText, params };
      boundStatements.push(statement);
      return statement;
    },
  }));
  const batch = vi.fn((statements: readonly BoundD1Statement[]) =>
    Promise.resolve(
      statements.map((statement) => ({
        results: statement.sql.includes("INSERT INTO") ? rows : [],
      })),
    ),
  );
  const dialect = new SQLiteSyncDialect();
  const db = {
    $client: { batch, prepare },
    session: { constructor: { name: "SQLiteD1Session" } },
    dialect: {
      sqlToQuery(query: SQL) {
        return dialect.sqlToQuery(query);
      },
    },
    all: vi.fn(() => Promise.resolve([])),
    get: vi.fn(() => Promise.resolve(undefined)),
    run: vi.fn(() => Promise.resolve()),
  } as unknown as AnySqliteDatabase;
  return { batch, boundStatements, db };
}

describe("durable convergence program ratchets", () => {
  it("has zero eligibility when the bind budget cannot fit one row", () => {
    const { db } = makeNeonDatabase(() => []);
    const backend = createPostgresBackend(db, {
      capabilities: { maxBindParameters: 15 },
      vector: false,
    });
    const profile = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend),
    );
    expect(
      requireDefined(profile.mutateEdges).maxEntries.durableConvergence,
    ).toBe(0);
    expect(
      resolveAtomicEdgeConvergenceExecutor({
        backend,
        graph: durableGraph,
        schemaVersion: 1,
        historyEnabled: false,
        revisionTrackingEnabled: false,
        kind: "worksAt",
        matchOn: ["role"],
        inputs: [{}],
        uniqueEntryCount: 1,
        ifExists: "return",
      }),
    ).toBeUndefined();
  });

  it("budgets duplicate-heavy batches by their unique durable identities", () => {
    const { db } = makeD1Database([]);
    const backend = createSqliteBackend(db);
    const executor = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend),
    ).mutateEdges;

    expect(requireDefined(executor).maxEntries.durableConvergence).toBe(7);
    expect(
      resolveAtomicEdgeConvergenceExecutor({
        backend,
        graph: durableGraph,
        schemaVersion: 1,
        historyEnabled: false,
        revisionTrackingEnabled: false,
        kind: "worksAt",
        matchOn: ["role"],
        inputs: Array.from({ length: 8 }, () => ({})),
        uniqueEntryCount: 1,
        ifExists: "return",
      }),
    ).toBe(executor);
    expect(
      resolveAtomicEdgeConvergenceExecutor({
        backend,
        graph: durableGraph,
        schemaVersion: 1,
        historyEnabled: false,
        revisionTrackingEnabled: false,
        kind: "worksAt",
        matchOn: ["role"],
        inputs: Array.from({ length: 8 }, () => ({})),
        uniqueEntryCount: 8,
        ifExists: "return",
      }),
    ).toBeUndefined();
  });

  it("maps durable rows back to input order when SQL returns them reversed", async () => {
    const first = convergenceEntry("edge-a", 0);
    const second = convergenceEntry("edge-b", 1);
    const { db, query } = makeNeonDatabase((sqlText) =>
      sqlText.includes("INSERT INTO") ?
        [edgeResultRow(second, "postgres"), edgeResultRow(first, "postgres")]
      : [],
    );
    const backend = createPostgresBackend(db, { vector: false });
    const executor = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend),
    ).mutateEdges;

    const results = await requireDefined(executor)({
      kind: "durable-convergence",
      entries: [first, second],
      schemaFence,
    });

    expect(results.map((result) => result.row.id)).toEqual([
      "edge-a",
      "edge-b",
    ]);
    expect(results.map((result) => result.outcome)).toEqual([
      "created",
      "created",
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "partial",
      rows: (
        first: AtomicEdgeConvergenceEntry,
        _second: AtomicEdgeConvergenceEntry,
      ) => [edgeResultRow(first, "postgres")],
    },
    {
      name: "identityless",
      rows: (
        first: AtomicEdgeConvergenceEntry,
        second: AtomicEdgeConvergenceEntry,
      ) => [
        {
          ...edgeResultRow(first, "postgres"),
          match_identity_name: undefined,
        },
        edgeResultRow(second, "postgres"),
      ],
    },
    {
      name: "duplicate identity",
      rows: (
        first: AtomicEdgeConvergenceEntry,
        _second: AtomicEdgeConvergenceEntry,
      ) => [
        edgeResultRow(first, "postgres"),
        { ...edgeResultRow(first, "postgres"), id: "duplicate-row" },
      ],
    },
    {
      name: "omitted identity",
      rows: (
        first: AtomicEdgeConvergenceEntry,
        second: AtomicEdgeConvergenceEntry,
      ) => [
        edgeResultRow(first, "postgres"),
        {
          ...edgeResultRow(second, "postgres"),
          match_identity_key: "unexpected-identity",
        },
      ],
    },
  ])("rejects a $name convergence postimage", async ({ rows }) => {
    const first = convergenceEntry("edge-a", 0);
    const second = convergenceEntry("edge-b", 1);
    const { db } = makeNeonDatabase((sqlText) =>
      sqlText.includes("INSERT INTO") ? rows(first, second) : [],
    );
    const backend = createPostgresBackend(db, { vector: false });
    const executor = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend),
    ).mutateEdges;

    await expect(
      requireDefined(executor)({
        kind: "durable-convergence",
        entries: [first, second],
        schemaFence,
      }),
    ).rejects.toBeInstanceOf(CompilerInvariantError);
  });

  it("pins the exact D1 ceiling and keeps every compiled slot within it", async () => {
    const entries = Array.from({ length: 7 }, (_, index) =>
      convergenceEntry(`edge-${index}`, index),
    );
    const rows = entries.map((entry) => edgeResultRow(entry, "sqlite"));
    const { db, batch, boundStatements } = makeD1Database(rows);
    const backend = createSqliteBackend(db);
    const executor = requireDefined(
      resolveBundledRootAtomicMutationPrograms(backend),
    ).mutateEdges;

    expect(requireDefined(executor).maxEntries.durableConvergence).toBe(7);
    await expect(
      requireDefined(executor)({
        kind: "durable-convergence",
        entries,
        schemaFence,
      }),
    ).resolves.toHaveLength(7);

    expect(batch).toHaveBeenCalledOnce();
    expect(boundStatements).toHaveLength(2);
    for (const statement of boundStatements) {
      expect(statement.params.length).toBeLessThanOrEqual(
        D1_MAX_BIND_PARAMETERS,
      );
    }
  });

  it("does not write and diagnoses a stale fence through the Store", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-durable-convergence-stale-fence-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const [store] = await createStoreWithSchema(durableGraph, backend);
      const from = await store.nodes.Person.create({ name: "Alice" });
      const to = await store.nodes.Company.create({ name: "Acme" });
      await migrateSchema(backend, evolvedGraph, 1);

      await expect(
        store.edges.worksAt.bulkGetOrCreateByEndpoints([
          { from, to, props: { role: "stale" } },
        ]),
      ).rejects.toBeInstanceOf(StaleVersionError);
      await expect(store.edges.worksAt.find()).resolves.toEqual([]);
    } finally {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
