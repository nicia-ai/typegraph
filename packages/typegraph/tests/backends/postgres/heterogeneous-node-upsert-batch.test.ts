import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  type RecordedInstant,
} from "../../../src";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { ConfigurationError, ValidationError } from "../../../src/errors";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);
const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number().optional() }),
});
const Company = defineNode("Company", {
  schema: z.object({ title: z.string() }),
});
const ConfiguredPerson = defineNode("ConfiguredPerson", {
  schema: z.object({
    name: z.string().transform((value) => value.trim()),
    state: z.string().default("new"),
  }),
});
const graph = defineGraph({
  id: "heterogeneous-node-upsert-batch",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    ConfiguredPerson: { type: ConfiguredPerson },
  },
  edges: {},
});
const pool = new Pool({ connectionString: TEST_DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

function requireRecorded(
  instant: RecordedInstant | undefined,
): RecordedInstant {
  if (instant === undefined)
    throw new Error("Expected a recorded receipt instant");
  return instant;
}

describe.runIf(process.env["POSTGRES_URL"])(
  "heterogeneous recorded node upsert batch",
  () => {
    it("uses one CTE, merges live rows, replaces resurrected rows, and records postimages", async () => {
      const queries: string[] = [];
      const db = drizzle(pool, {
        logger: {
          logQuery(query) {
            queries.push(query);
          },
        },
      });
      const backend = createPostgresBackend(db, { vector: false });
      const [store] = await createAdapterStoreWithSchema(graph, backend, {
        history: true,
      });
      await store.nodes.Person.create(
        { name: "before", age: 1 },
        { id: "person" },
      );
      await store.nodes.Person.delete(asNodeId<typeof Person>("person"));
      queries.length = 0;

      const outcome = await db.transaction(async (pgTx) =>
        store.withRecordedTransaction(pgTx, async (tx) =>
          tx.writeNodeUpsertBatch([
            {
              kind: "Person",
              id: asNodeId<typeof Person>("person"),
              props: { name: "after" },
            },
            {
              kind: "Company",
              id: asNodeId<typeof Company>("company"),
              props: { title: "Nicia" },
            },
          ] as const),
        ),
      );

      expect(outcome.result).toHaveLength(2);
      const resurrected = await store.nodes.Person.getById(
        asNodeId<typeof Person>("person"),
      );
      expect(resurrected).toMatchObject({ name: "after" });
      expect(resurrected).not.toHaveProperty("age");
      expect(
        await store.nodes.Company.getById(asNodeId<typeof Company>("company")),
      ).toMatchObject({ title: "Nicia" });
      expect(
        queries.filter((query) => query.includes('WITH "schema_fence"')),
      ).toHaveLength(1);
      expect(outcome.receipt.writes.nodes).toMatchObject({
        Person: 1,
        Company: 1,
      });
      expect(outcome.receipt.recorded).toBeDefined();

      const recorded = requireRecorded(outcome.receipt.recorded);
      await expect(
        store
          .asOfRecorded(recorded)
          .nodes.Person.getById(asNodeId<typeof Person>("person")),
      ).resolves.toMatchObject({ name: "after" });

      await db.transaction(async (pgTx) =>
        store.withRecordedTransaction(pgTx, async (tx) =>
          tx.writeNodeUpsertBatch([
            {
              kind: "Person",
              id: asNodeId<typeof Person>("person"),
              props: { age: 2, name: "merged" },
            },
          ] as const),
        ),
      );
      await expect(
        store.nodes.Person.getById(asNodeId<typeof Person>("person")),
      ).resolves.toMatchObject({ name: "merged", age: 2 });
      await db.transaction(async (pgTx) =>
        store.withRecordedTransaction(pgTx, async (tx) =>
          tx.writeNodeUpsertBatch([
            {
              kind: "Person",
              id: asNodeId<typeof Person>("person"),
              props: { name: "preserved" },
            },
          ] as const),
        ),
      );
      await expect(
        store.nodes.Person.getById(asNodeId<typeof Person>("person")),
      ).resolves.toMatchObject({ name: "preserved", age: 2 });
    });

    it("preserves omitted defaulted fields on live rows while applying defaults on creates and resurrections", async () => {
      const db = drizzle(pool);
      const backend = createPostgresBackend(db, { vector: false });
      const [store] = await createAdapterStoreWithSchema(graph, backend, {
        history: true,
      });
      await store.nodes.ConfiguredPerson.create(
        { name: "live", state: "preserved" },
        { id: "live" },
      );

      await db.transaction(async (pgTx) =>
        store.withRecordedTransaction(pgTx, async (tx) =>
          tx.writeNodeUpsertBatch([
            {
              kind: "ConfiguredPerson",
              id: asNodeId<typeof ConfiguredPerson>("live"),
              props: { name: "  updated  " },
            },
            {
              kind: "ConfiguredPerson",
              id: asNodeId<typeof ConfiguredPerson>("created"),
              props: { name: "  created  " },
            },
          ] as const),
        ),
      );

      await expect(
        store.nodes.ConfiguredPerson.getById(
          asNodeId<typeof ConfiguredPerson>("live"),
        ),
      ).resolves.toMatchObject({ name: "updated", state: "preserved" });
      await expect(
        store.nodes.ConfiguredPerson.getById(
          asNodeId<typeof ConfiguredPerson>("created"),
        ),
      ).resolves.toMatchObject({ name: "created", state: "new" });

      await store.nodes.ConfiguredPerson.delete(
        asNodeId<typeof ConfiguredPerson>("live"),
      );
      await db.transaction(async (pgTx) =>
        store.withRecordedTransaction(pgTx, async (tx) =>
          tx.writeNodeUpsertBatch([
            {
              kind: "ConfiguredPerson",
              id: asNodeId<typeof ConfiguredPerson>("live"),
              props: { name: "  resurrected  " },
            },
          ] as const),
        ),
      );
      await expect(
        store.nodes.ConfiguredPerson.getById(
          asNodeId<typeof ConfiguredPerson>("live"),
        ),
      ).resolves.toMatchObject({ name: "resurrected", state: "new" });
    });

    it("refuses an over-budget batch before issuing its CTE", async () => {
      const queries: string[] = [];
      const db = drizzle(pool, {
        logger: {
          logQuery(query) {
            queries.push(query);
          },
        },
      });
      const backend = createPostgresBackend(db, {
        capabilities: { maxBindParameters: 10 },
        vector: false,
      });
      const [store] = await createAdapterStoreWithSchema(graph, backend, {
        history: true,
      });
      queries.length = 0;

      await expect(
        db.transaction(async (pgTx) =>
          store.withRecordedTransaction(pgTx, async (tx) =>
            tx.writeNodeUpsertBatch([
              {
                kind: "Person",
                id: asNodeId<typeof Person>("over-budget"),
                props: { name: "too many binds" },
              },
            ] as const),
          ),
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ConfigurationError &&
          error.details["capability"] === "maxBindParameters" &&
          error.details["maxBindParameters"] === 10 &&
          error.details["parameterCount"] === 11,
      );

      expect(
        queries.some((query) => query.includes('WITH "schema_fence"')),
      ).toBe(false);
      await expect(
        store.nodes.Person.getById(asNodeId<typeof Person>("over-budget")),
      ).resolves.toBeUndefined();
    });

    it("refuses malformed and repeated entries before the CTE runs", async () => {
      const queries: string[] = [];
      const db = drizzle(pool, {
        logger: {
          logQuery(query) {
            queries.push(query);
          },
        },
      });
      const backend = createPostgresBackend(db, { vector: false });
      const [store] = await createAdapterStoreWithSchema(graph, backend, {
        history: true,
      });
      queries.length = 0;

      await expect(
        db.transaction(async (pgTx) =>
          store.withRecordedTransaction(pgTx, async (tx) =>
            tx.writeNodeUpsertBatch([
              {
                kind: "Person",
                id: asNodeId<typeof Person>("duplicate"),
                props: { name: "one" },
              },
              {
                kind: "Person",
                id: asNodeId<typeof Person>("duplicate"),
                props: { name: "two" },
              },
            ] as const),
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(
        queries.some((query) => query.includes('WITH "schema_fence"')),
      ).toBe(false);
      await expect(
        store.nodes.Person.getById(asNodeId<typeof Person>("duplicate")),
      ).resolves.toBeUndefined();

      await expect(
        db.transaction(async (pgTx) =>
          store.withRecordedTransaction(pgTx, async (tx) =>
            tx.writeNodeUpsertBatch([
              {
                kind: "Person",
                id: asNodeId<typeof Person>("missing"),
                // @ts-expect-error Runtime callers can bypass the full create input type.
                props: {},
              },
            ]),
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(
        queries.some((query) => query.includes('WITH "schema_fence"')),
      ).toBe(false);
    });
  },
);
