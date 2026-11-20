import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  disjointWith,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { tables } from "../src/backend/sqlite";
import { ConfigurationError } from "../src/errors";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "constraint_adopted_transaction",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {},
  ontology: [disjointWith(Person, Company)],
});

const openDatabases: Database.Database[] = [];
const openDirectories: string[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    if (database.inTransaction) database.exec("ROLLBACK");
    database.close();
  }
  for (const directory of openDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function openStore() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "typegraph-constraint-fence-"),
  );
  openDirectories.push(directory);
  const file = path.join(directory, "graph.db");
  const ownerStatements: string[] = [];
  const owner = new Database(file, {
    verbose: (statement) => ownerStatements.push(String(statement)),
  });
  const other = new Database(file, { timeout: 0 });
  openDatabases.push(owner, other);
  owner.pragma("journal_mode = WAL");
  for (const statement of generateSqliteDDL(tables)) owner.exec(statement);
  const ownerDb = drizzle(owner);
  const backend = createSqliteBackend(ownerDb, {
    executionProfile: { isSync: true },
    tables,
  });
  const [store] = await createAdapterStoreWithSchema(graph, backend);
  await store.nodes.Person.create({ name: "Anchor" }, { id: "anchor" });
  return { other, owner, ownerDb, ownerStatements, store };
}

function commitUnrelatedRow(other: Database.Database): void {
  const stamp = "2026-01-01T00:00:00.000Z";
  other
    .prepare(
      `INSERT INTO ${getTableName(tables.nodes)} ` +
        "(graph_id, kind, id, props, created_at, updated_at, version) " +
        "VALUES (?, 'Person', 'racer', '{\"name\":\"Racer\"}', ?, ?, 1)",
    )
    .run(graph.id, stamp, stamp);
}

describe("constrained writes in adopted SQLite transactions", () => {
  it("refuses a stale DEFERRED snapshot before its constraint probe", async () => {
    const { other, owner, ownerDb, store } = await openStore();
    owner.exec("BEGIN");
    const transactionStore = store.withTransaction(ownerDb);
    await transactionStore.nodes.Person.find();
    commitUnrelatedRow(other);

    const refusal = await transactionStore.nodes.Company.create(
      { name: "Safe company" },
      { id: "company" },
    ).then(
      (created): unknown => created,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ConfigurationError);
    expect((refusal as ConfigurationError).details).toMatchObject({
      code: "CONSTRAINT_TRANSACTION_NOT_WRITE_FENCED",
      graphId: graph.id,
    });
    expect((refusal as ConfigurationError).suggestion).toContain(
      "BEGIN IMMEDIATE",
    );
  });

  it("runs normally when the adopted frame already owns the writer slot", async () => {
    const { owner, ownerDb, store } = await openStore();
    owner.exec("BEGIN IMMEDIATE");
    const transactionStore = store.withTransaction(ownerDb);

    const company = await transactionStore.nodes.Company.create(
      { name: "Serialized company" },
      { id: "company" },
    );
    expect(company.id).toBe("company");
    owner.exec("COMMIT");
  });

  it("proves the writer slot again for a later transaction on the same adopted store", async () => {
    const { other, owner, ownerDb, store } = await openStore();
    const transactionStore = store.withTransaction(ownerDb);

    owner.exec("BEGIN IMMEDIATE");
    await transactionStore.nodes.Company.create(
      { name: "First company" },
      { id: "first-company" },
    );
    owner.exec("COMMIT");

    owner.exec("BEGIN");
    await transactionStore.nodes.Person.find();
    commitUnrelatedRow(other);

    await expect(
      transactionStore.nodes.Company.create(
        { name: "Second company" },
        { id: "second-company" },
      ),
    ).rejects.toMatchObject({
      details: {
        code: "CONSTRAINT_TRANSACTION_NOT_WRITE_FENCED",
        graphId: graph.id,
      },
    });
  });

  it("does not probe the writer slot inside a transaction TypeGraph opened", async () => {
    const { ownerStatements, store } = await openStore();
    ownerStatements.length = 0;

    await store.transaction(async (transactionStore) => {
      await transactionStore.nodes.Company.create(
        { name: "Managed company" },
        { id: "managed-company" },
      );
    });

    expect(
      ownerStatements.some((statement) =>
        statement.includes("SET graph_id = graph_id WHERE 0"),
      ),
    ).toBe(false);
  });
});
