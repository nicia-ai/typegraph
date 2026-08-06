/**
 * Issue #410: a concurrent create of the same NEW id must lose with the create
 * API's already-exists error, not with a raw driver failure.
 *
 * A create probes for the id and then inserts it — two statements. PostgreSQL's
 * default READ COMMITTED does not serialize the two write transactions, so both
 * probes can see an absent row and both can then insert it; the loser learns the
 * truth only from the INSERT. That report used to escape as a
 * `DrizzleQueryError` whose `.message` is the raw SQL text, so the identical
 * condition surfaced as a typed user error when the probe caught it and as an
 * opaque system error when the engine did.
 *
 * The interleaving here is forced, not raced: the losing store is held at its
 * INSERT until the winner has committed, so the case means the same thing every
 * run instead of depending on scheduling.
 *
 * SQLite cannot reach this shape. `BEGIN IMMEDIATE` hands the writer slot to one
 * transaction at a time, so a node create cannot be between its probe and its
 * INSERT while another commits — the probe is authoritative, and the refusal is
 * the probe's own error. Staging the overlap there is not merely unnecessary but
 * impossible in-process: better-sqlite3 is synchronous, so a second writer's
 * blocked `BEGIN IMMEDIATE` blocks the event loop the holder needs to reach
 * COMMIT, and the attempt ends in `SQLITE_BUSY: database is locked` after the
 * full `busy_timeout` — never in a duplicate-key report.
 *
 * The translation itself is NOT Postgres-only, though: an edge create has no
 * existence probe at all, so the engine's refusal is its only report of a taken
 * id on every backend. That both backends answer with the same error is pinned by
 * the shared `Duplicate Identity` cases in
 * `tests/backends/integration/edge-cases.ts`; what is Postgres-only, and what
 * this file covers, is reaching that refusal by losing a race.
 *
 * The scoping matters as much as the translation: SQLSTATE 23505 also reports a
 * violated `unique: true` INDEX on the same relation, which is a
 * declared-uniqueness failure about the row's VALUES, not a duplicate identity.
 * The last two cases pin that both of those keep their own errors.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { GraphBackend, TransactionBackend } from "../../../src";
import {
  asEdgeId,
  asNodeId,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  ENTITY_ALREADY_EXISTS_CODE,
  UniquenessError,
  ValidationError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createGate, type Gate } from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(),
    tag: z.string().optional(),
  }),
});
const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
  from: [Person],
  to: [Person],
});

const graph = defineGraph({
  id: "concurrent-create",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "byEmail",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

/**
 * A props-expression UNIQUE INDEX over `tag` — a field NO declared uniqueness
 * constraint covers, so nothing pre-checks it and the index is what refuses the
 * second write.
 */
const TAG_UNIQUE_INDEX = "person_tag_unique_probe_idx";

let pool: Pool | undefined;
let db: NodePgDatabase | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): Readonly<{
  pool: Pool;
  db: NodePgDatabase;
}> {
  if (!isPostgresAvailable || pool === undefined || db === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return { pool, db };
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  // Four connections: the held loser transaction, the winner's, and headroom
  // for the setup/assertion queries that run alongside them.
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 6,
  });
  try {
    await candidate.query("SELECT 1");
    await candidate.query(generatePostgresMigrationSQL());
    pool = candidate;
    db = drizzle(candidate);
    isPostgresAvailable = true;
  } catch (error) {
    console.error(
      "concurrent-create-duplicate-key: Postgres setup failed; skipping suite.",
      error,
    );
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await candidate.end().catch(() => {});
  }
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

beforeEach(async () => {
  if (pool === undefined) return;
  await pool.query(`DROP INDEX IF EXISTS ${TAG_UNIQUE_INDEX}`);
  await pool.query(
    "TRUNCATE typegraph_node_uniques, typegraph_edges, typegraph_nodes",
  );
});

/** Insert members whose call must be held until the winner has committed. */
const GATED_INSERT_METHODS = new Set([
  "insertNode",
  "insertNodeNoReturn",
  "insertNodesBatch",
  "insertNodesBatchReturning",
  "insertEdge",
  "insertEdgeNoReturn",
  "insertEdgesBatch",
  "insertEdgesBatchReturning",
]);

/**
 * A backend whose FIRST insert inside a transaction waits on `gate` before
 * reaching the engine. Everything before it — including the create's existence
 * probe — has already run, so opening the gate resumes a transaction that
 * decided the id was free.
 *
 * Interception is on the TRANSACTION target: the write runs against the backend
 * `runInWriteTransaction` yields, not against the outer object.
 */
function gatedAtFirstInsert(base: GraphBackend, gate: Gate): GraphBackend {
  return {
    ...base,
    transaction: (fn, options) =>
      base.transaction((transactionTarget) => {
        let held = false;
        const gatedTarget = new Proxy(transactionTarget, {
          get(source, property, receiver) {
            const value: unknown = Reflect.get(source, property, receiver);
            if (
              typeof property !== "string" ||
              typeof value !== "function" ||
              !GATED_INSERT_METHODS.has(property)
            ) {
              return value;
            }
            const method = value as (...args: unknown[]) => Promise<unknown>;
            return async (...args: unknown[]) => {
              if (!held) {
                held = true;
                await gate.opened;
              }
              return method.apply(source, args);
            };
          },
        }) as TransactionBackend;
        return fn(gatedTarget);
      }, options),
  } satisfies GraphBackend;
}

/**
 * Asserts a rejection is the already-exists refusal, identified by its stable
 * issue code rather than by message text, and reports the id it lost on.
 */
async function expectAlreadyExists(
  operation: Promise<unknown>,
  expected: Readonly<{ entityType: "node" | "edge"; kind: string; id: string }>,
): Promise<void> {
  const error = await operation.catch((error_: unknown) => error_);
  expect(error).toBeInstanceOf(ValidationError);
  const validation = error as ValidationError;
  expect(validation.details.issues.map((issue) => issue.code)).toContain(
    ENTITY_ALREADY_EXISTS_CODE,
  );
  expect(validation.details.entityType).toBe(expected.entityType);
  expect(validation.details.kind).toBe(expected.kind);
  expect(validation.details.id).toBe(expected.id);
  expect(validation.details.operation).toBe("create");
}

describe.runIf(process.env["POSTGRES_URL"])(
  "concurrent create of the same new id (PostgreSQL)",
  () => {
    it("reports the losing node batch as already exists, not a driver error", async (ctx) => {
      const live = requirePostgres(ctx);
      const gate = createGate();
      const winner = createStore(graph, createPostgresBackend(live.db));
      const loser = createStore(
        graph,
        gatedAtFirstInsert(createPostgresBackend(live.db), gate),
      );

      // The loser probes `contended`, finds nothing, and stops at its INSERT.
      const losing = loser.nodes.Person.bulkUpsertById([
        { id: asNodeId("contended"), props: { name: "Loser" } },
      ]);
      await winner.nodes.Person.bulkUpsertById([
        { id: asNodeId("contended"), props: { name: "Winner" } },
      ]);
      gate.open();

      await expectAlreadyExists(losing, {
        entityType: "node",
        kind: "Person",
        id: "contended",
      });

      // The winner's row stands, uncorrupted by the rolled-back loser.
      const survivor = await winner.nodes.Person.getById(asNodeId("contended"));
      expect(survivor?.name).toBe("Winner");
    });

    it("reports the losing edge batch as already exists, not a driver error", async (ctx) => {
      const live = requirePostgres(ctx);
      const setup = createStore(graph, createPostgresBackend(live.db));
      // Distinct emails: the declared `byEmail` constraint treats a shared absent
      // value as one key, which is a different conflict than this case is about.
      const alice = await setup.nodes.Person.create(
        { name: "Alice", email: "alice@example.com" },
        { id: "edge-alice" },
      );
      const bob = await setup.nodes.Person.create(
        { name: "Bob", email: "bob@example.com" },
        { id: "edge-bob" },
      );

      const gate = createGate();
      const winner = createStore(graph, createPostgresBackend(live.db));
      const loser = createStore(
        graph,
        gatedAtFirstInsert(createPostgresBackend(live.db), gate),
      );

      const losing = loser.edges.knows.bulkUpsertById([
        {
          id: asEdgeId("contended-edge"),
          from: alice,
          to: bob,
          props: { since: "loser" },
        },
      ]);
      await winner.edges.knows.bulkUpsertById([
        {
          id: asEdgeId("contended-edge"),
          from: alice,
          to: bob,
          props: { since: "winner" },
        },
      ]);
      gate.open();

      await expectAlreadyExists(losing, {
        entityType: "edge",
        kind: "knows",
        id: "contended-edge",
      });

      const survivor = await winner.edges.knows.getById(
        asEdgeId("contended-edge"),
      );
      expect((survivor as { since?: string } | undefined)?.since).toBe(
        "winner",
      );
    });

    it("reports a losing single node create as already exists too", async (ctx) => {
      // Same seam, non-batch path: `create` inserts one row rather than a chunk.
      const live = requirePostgres(ctx);
      const gate = createGate();
      const winner = createStore(graph, createPostgresBackend(live.db));
      const loser = createStore(
        graph,
        gatedAtFirstInsert(createPostgresBackend(live.db), gate),
      );

      const losing = loser.nodes.Person.create(
        { name: "Loser" },
        { id: "contended-single" },
      );
      await winner.nodes.Person.create(
        { name: "Winner" },
        { id: "contended-single" },
      );
      gate.open();

      await expectAlreadyExists(losing, {
        entityType: "node",
        kind: "Person",
        id: "contended-single",
      });
    });

    it("still reports a DECLARED uniqueness conflict as UniquenessError", async (ctx) => {
      // Two DIFFERENT ids claiming one unique key: no primary-key collision at
      // all. The conflict surfaces from the uniqueness relation, and must not be
      // reshaped into a duplicate-identity error by the new translation.
      const live = requirePostgres(ctx);
      const gate = createGate();
      const winner = createStore(graph, createPostgresBackend(live.db));
      const loser = createStore(
        graph,
        gatedAtFirstInsert(createPostgresBackend(live.db), gate),
      );

      const losing = loser.nodes.Person.create(
        { name: "Loser", email: "shared@example.com" },
        { id: "unique-loser" },
      );
      await winner.nodes.Person.create(
        { name: "Winner", email: "shared@example.com" },
        { id: "unique-winner" },
      );
      gate.open();

      await expect(losing).rejects.toThrow(UniquenessError);
      const error = await losing.catch((error_: unknown) => error_);
      expect((error as UniquenessError).details.constraintName).toBe("byEmail");
    });

    it("does not translate a violated unique INDEX into already exists", async (ctx) => {
      // A `unique: true` index declaration materializes a UNIQUE INDEX on the
      // nodes relation, so violating it raises the SAME SQLSTATE (23505) on the
      // SAME table as a duplicate id. It carries the index's own name rather
      // than the relation's primary key, which is exactly why the classification
      // is scoped to the primary key: this must keep surfacing as the driver
      // failure it was, never as "this id already exists".
      const live = requirePostgres(ctx);
      await live.pool.query(
        `CREATE UNIQUE INDEX ${TAG_UNIQUE_INDEX}
           ON typegraph_nodes ((props->>'tag'))
           WHERE kind = 'Person'`,
      );
      const store = createStore(graph, createPostgresBackend(live.db));

      await store.nodes.Person.create(
        { name: "First", tag: "shared-tag" },
        { id: asNodeId("index-first") },
      );
      const refused = store.nodes.Person.create(
        { name: "Second", tag: "shared-tag" },
        { id: asNodeId("index-second") },
      );

      const error = await refused.catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(Error);
      const alreadyExists =
        error instanceof ValidationError &&
        error.details.issues.some(
          (issue) => issue.code === ENTITY_ALREADY_EXISTS_CODE,
        );
      expect(alreadyExists).toBe(false);
    });
  },
);
