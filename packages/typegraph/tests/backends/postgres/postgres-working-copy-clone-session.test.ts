/**
 * A PostgreSQL working copy of a history-enabled source clones the source's
 * relations inside one transaction on the source. The source's backend is the
 * capture overlay, whose `transaction` member opens the transaction together
 * with its one session; the clone must run in that session rather than open
 * a second one over the capture surface the member hands out.
 *
 * The probe: every session a module outside the mint opens through
 * `openTransactionSession` is checked for whether the object it opens over
 * already carries a session (a capture surface built for one). The mint's
 * own opens (`openRootTransaction`'s fallback, a bound session) are internal
 * calls the mock does not see.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresWorkingCopyManager } from "../../../src/backend/postgres/working-copy";
import { computeBaseVersion } from "../../../src/graph-merge";
import type * as OperationScopeModule from "../../../src/store/operation-scope";
import { storeBackend } from "../../../src/store/runtime-port";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const sessionOpens = vi.hoisted(() => ({ overHeldSurface: 0 }));

/** Whether `surface` carries the session it was built for. */
function carriesSession(surface: object): boolean {
  return Reflect.ownKeys(surface).some(
    (key) =>
      typeof key === "symbol" && key.description === "typegraph.surfaceSession",
  );
}

vi.mock("../../../src/store/operation-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof OperationScopeModule>();
  return {
    ...actual,
    openTransactionSession: (
      ...args: Parameters<typeof actual.openTransactionSession>
    ) => {
      if (carriesSession(args[0])) sessionOpens.overHeldSurface += 1;
      return actual.openTransactionSession(...args);
    },
  };
});

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "postgres_working_copy_clone_session",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe.runIf(process.env["POSTGRES_URL"])(
  "a PostgreSQL working copy of a history source",
  () => {
    it("clones in the session the source's capture overlay opened", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(graph, control, {
          history: true,
        });
        await source.nodes.Person.create({ name: "Source" });
        const manager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: (names, allocation) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
                ...(allocation === undefined ?
                  {}
                : { vector: allocation.vectorStrategy }),
              }),
            ),
        });
        const base = await computeBaseVersion(source);

        sessionOpens.overHeldSurface = 0;
        const copy = await manager.ephemeral.create(source, base);
        try {
          expect(sessionOpens.overHeldSurface).toBe(0);
          const people = await copy.nodes.Person.find();
          expect(people.map((person) => person.name)).toEqual(["Source"]);
        } finally {
          await storeBackend(copy).close();
        }
      } finally {
        await pool.end();
      }
    }, 60_000);
  },
);
