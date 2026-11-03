/**
 * The order a composition cascade locks its members in, read off the
 * statements it sends: one `FOR UPDATE` statement per member kind, kinds in
 * code-point order.
 *
 * Two cascades over overlapping closures must take their member row locks in
 * one agreed order or they can deadlock; recording the statements pins that
 * order directly instead of racing two deletes and hoping to catch a deadlock.
 * The fixture's kinds disagree on every other plausible order: the cascade
 * reports the leaf `alpha` before its whole `Zed` (leaf-first), and a
 * locale-aware sort puts `alpha` before `Zed`, while code-point order puts
 * `Zed` (U+005A) before `alpha` (U+0061).
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  type Store,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Hub = defineNode("Hub", { schema: z.object({}) });
const Zed = defineNode("Zed", { schema: z.object({}) });
const Alpha = defineNode("alpha", { schema: z.object({}) });
const zedOf = defineEdge("zedOf", { schema: z.object({}) });
const alphaOf = defineEdge("alphaOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition-cascade-lock-order",
  nodes: { Hub: { type: Hub }, Zed: { type: Zed }, alpha: { type: Alpha } },
  edges: {
    zedOf: { type: zedOf, from: [Zed], to: [Hub], cardinality: "one" },
    alphaOf: { type: alphaOf, from: [Alpha], to: [Zed], cardinality: "one" },
  },
  ontology: [
    partOf(Zed, Hub, { via: zedOf }),
    partOf(Alpha, Zed, { via: alphaOf }),
  ],
});

const MEMBER_KINDS = ["Zed", "alpha"] as const;

type RecordedStatement = Readonly<{ query: string; params: unknown[] }>;

const statements: RecordedStatement[] = [];
let pool: Pool | undefined;
let store: Store<typeof graph> | undefined;

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const created = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 2,
  });
  await runServerSuiteSetup(
    "composition-cascade-lock-order",
    [created],
    async () => {
      await created.query(generatePostgresMigrationSQL());
      pool = created;
      const db = drizzle(created, {
        logger: {
          logQuery(query: string, params: unknown[]): void {
            statements.push({ query, params });
          },
        },
      });
      [store] = await createStoreWithSchema(graph, createPostgresBackend(db));
    },
  );
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

describe.runIf(process.env["POSTGRES_URL"])(
  "composition cascade member lock order (PostgreSQL)",
  () => {
    // MUTATION CHECK: reverse the comparator of `lockOrder` in
    // `lockCascadeMembers` (src/store/operations/node-operations.ts), or drop
    // the sort and lock in the cascade's own leaf-first order — the recorded
    // kinds then read `["alpha", "Zed"]`.
    it("locks one statement per member kind, kinds in code-point order", async () => {
      if (store === undefined) throw new Error("PostgreSQL store unavailable");
      const hub = await store.nodes.Hub.create({});
      for (const id of ["zed-b", "zed-a"]) {
        const zed = await store.nodes.Zed.create(
          {},
          { id, partOf: { whole: hub } },
        );
        await store.nodes.alpha.create({}, { partOf: { whole: zed } });
      }

      statements.splice(0);
      await store.nodes.Hub.delete(hub.id);

      const lockedKinds = statements
        .filter(
          ({ query }) =>
            query.includes("FOR UPDATE") && query.includes("typegraph_nodes"),
        )
        .flatMap(({ params }) =>
          MEMBER_KINDS.filter((kind) => params.includes(kind)),
        );
      expect(lockedKinds).toEqual(["Zed", "alpha"]);
      expect(await store.nodes.Zed.count()).toBe(0);
      expect(await store.nodes.alpha.count()).toBe(0);
    });
  },
);
