/**
 * Interchange assertion ordering is code-point ordering on PostgreSQL too.
 *
 * `readIdentityAssertionPageAtTarget` is the sole owner of the order its two
 * consumers see: the interchange export walks its pages by an `id > after`
 * keyset cursor, and `computeContentComponent` hashes the returned list in
 * READ order into a `base@V` content token. A bare `ORDER BY
 * identity_assertions.id` sorts under the database's locale collation, which
 * on this project's test container (`pgvector/pgvector:pg18`, initdb'd under
 * `en_US.utf8`) is case-insensitive — so mixed-case assertion ids, which
 * includes every nanoid, paged differently than on SQLite's BINARY order and
 * produced a different base-version token than the same content did before the
 * read carried an `ORDER BY` at all.
 *
 * These tests are backend-specific wiring rather than query semantics: they
 * assert the collation pinning is present on PostgreSQL, which is by
 * definition not observable on SQLite. Note they can only fail on a database
 * whose `datcollate` is not `C`/`POSIX` — the first test therefore reports the
 * collation it ran under so a vacuous pass is visible.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { type GraphBackend } from "../../../src/backend/types";
import { computeContentComponent } from "../../../src/graph-merge/base-version";
import { type IdentityTransferAssertion } from "../../../src/identity/service";
import { exportGraphStream } from "../../../src/interchange";
import { storeRuntime } from "../../../src/store/runtime-port";
import { type Store } from "../../../src/store/store";
import { compareCodePoints } from "../../../src/utils/compare";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "identity_interchange_order",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const CANONICAL_TIMESTAMP = "2024-01-01T00:00:00.000Z";

/**
 * Assertion ids chosen so the two candidate orders disagree: code point sorts
 * every uppercase letter before every lowercase one, while `en_US.utf8` sorts
 * them as a dictionary does.
 */
const ASSERTION_IDS = ["B", "a", "C", "b", "A", "c"] as const;
const CODE_POINT_ORDER = [...ASSERTION_IDS].toSorted((left, right) =>
  compareCodePoints(left, right),
);

let pool: Pool | undefined;

function requirePool(): Pool {
  return requireDefined(pool, "PostgreSQL pool was not initialized");
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await candidate.query("SELECT 1");
  await candidate.query(generatePostgresMigrationSQL());
  pool = candidate;
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

/**
 * Seeds one identity assertion per id in {@link ASSERTION_IDS}, each over its
 * own disjoint node pair, imported in an order that matches neither candidate
 * sort so insertion order cannot stand in for the answer.
 */
async function seedAssertions(
  backend: GraphBackend,
): Promise<Store<typeof graph>> {
  const [store] = await createStoreWithSchema(graph, backend);
  const assertions: IdentityTransferAssertion[] = [];
  for (const [index, id] of ASSERTION_IDS.entries()) {
    const person = await store.nodes.Person.create(
      { name: `Person ${index}` },
      { id: `person-${index}` },
    );
    const company = await store.nodes.Company.create(
      { name: `Company ${index}` },
      { id: `company-${index}` },
    );
    assertions.push({
      id,
      relation: "same",
      // Endpoints are canonically ordered by kind: "Company" < "Person".
      a: { kind: "Company", id: company.id },
      b: { kind: "Person", id: person.id },
      validFrom: CANONICAL_TIMESTAMP,
    });
  }
  await storeRuntime(store).importIdentityAssertionsAtTarget(
    backend,
    assertions,
    "state",
  );
  return store;
}

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL identity interchange ordering",
  () => {
    let backend: GraphBackend | undefined;

    beforeEach(async () => {
      await requirePool().query(
        `TRUNCATE typegraph_recorded_identity_assertions,
                  typegraph_identity_closure,
                  typegraph_identity_assertions,
                  typegraph_nodes,
                  typegraph_edges,
                  typegraph_node_uniques,
                  typegraph_schema_versions CASCADE`,
      );
      backend = createPostgresBackend(drizzle(requirePool()));
    });

    it("reads mixed-case assertion ids in code-point order", async () => {
      const target = requireDefined(backend);
      const collation = await requirePool().query<{ datcollate: string }>(
        "SELECT datcollate FROM pg_database WHERE datname = current_database()",
      );
      const datcollate = requireDefined(collation.rows[0]).datcollate;
      // A `C`/`POSIX` database already sorts by code point, so this assertion
      // would hold with or without the pinning. Surface that rather than
      // reporting a green run that proved nothing.
      expect(
        { datcollate, discriminating: !["C", "POSIX"].includes(datcollate) },
        "the test database's collation must differ from code-point order for this to be load-bearing",
      ).toMatchObject({ discriminating: true });

      const store = await seedAssertions(target);

      const page = await storeRuntime(store).readIdentityAssertionPageAtTarget(
        target,
        "state",
        { limit: ASSERTION_IDS.length },
      );

      expect(page.assertions.map((assertion) => assertion.id)).toEqual(
        CODE_POINT_ORDER,
      );
      expect(page.nextAfter).toBe(CODE_POINT_ORDER.at(-1));
    });

    it("paginates mixed-case assertion ids without skips or duplicates", async () => {
      const target = requireDefined(backend);
      const store = await seedAssertions(target);

      // The keyset cursor compares under the same collation as the scan, or a
      // page boundary lands mid-order and rows are skipped or repeated.
      const paged: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await storeRuntime(
          store,
        ).readIdentityAssertionPageAtTarget(target, "state", {
          limit: 2,
          ...(after === undefined ? {} : { after }),
        });
        paged.push(...page.assertions.map((assertion) => assertion.id));
        if (page.done) break;
        after = requireDefined(page.nextAfter);
      }

      expect(paged).toEqual(CODE_POINT_ORDER);
      expect(new Set(paged).size).toBe(ASSERTION_IDS.length);
    });

    it("mints a base-version content token over code-point-ordered assertions", async () => {
      const target = requireDefined(backend);
      const store = await seedAssertions(target);

      // The regression this guards: `computeContentComponent` hashes the read's
      // output positionally, so a locale-ordered read mints a different
      // `base@V` token than the same content did before — a spurious
      // BaseVersionMismatchError on an untouched base.
      const asRead = await storeRuntime(store).identityAssertionsAtTarget(
        target,
        "state",
      );
      const codePointOrdered = [...asRead].toSorted((left, right) =>
        compareCodePoints(left.id, right.id),
      );
      expect(
        await computeContentComponent(target, graph.id, graph, asRead),
      ).toBe(
        await computeContentComponent(
          target,
          graph.id,
          graph,
          codePointOrdered,
        ),
      );
      expect(asRead.map((assertion) => assertion.id)).toEqual(CODE_POINT_ORDER);
    });

    it("streams exported identity chunks in code-point order", async () => {
      const target = requireDefined(backend);
      const store = await seedAssertions(target);

      const exported: string[] = [];
      for await (const chunk of exportGraphStream(store, { batchSize: 2 })) {
        if (chunk.type === "identity") {
          exported.push(...chunk.assertions.map((assertion) => assertion.id));
        }
      }

      expect(exported).toEqual(CODE_POINT_ORDER);
    });
  },
);
