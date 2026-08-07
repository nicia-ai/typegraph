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
 * definition not observable on SQLite. A collation not literally named
 * `C`/`POSIX` is not necessarily discriminating for a given set of ids, so the
 * first test does not trust the name: it runs the identical scan with the
 * collation pin removed (a bare `ORDER BY id`, under the database's default
 * collation) and only proceeds when that unpinned order provably disagrees
 * with code-point order. When it does not, the environment cannot tell the
 * fix from its absence, and the test skips and says so rather than reporting
 * a vacuous pass.
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
import {
  normalizeIdentityAssertionRow,
  type RawIdentityAssertionRow,
  toTransferAssertion,
} from "../../../src/identity/row-codec";
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

/**
 * Reads back the raw ids for {@link ASSERTION_IDS} under a bare `ORDER BY id`
 * — no `COLLATE` override — so the scan sorts under the database's actual
 * default collation. Used to prove (or disprove) that this environment's
 * collation is discriminating for this fixture, independent of what
 * `datcollate` happens to be named.
 */
async function readUnpinnedAssertionIdOrder(
  graphId: string,
): Promise<readonly string[]> {
  const result = await requirePool().query<{ id: string }>(
    `SELECT id FROM typegraph_identity_assertions
      WHERE graph_id = $1 AND deleted_at IS NULL AND valid_to IS NULL
      ORDER BY id`,
    [graphId],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Fetches the seeded assertions through a path independent of the code under
 * test: a raw query against the ledger table with no `ORDER BY` at all (so
 * nothing here can accidentally inherit code-point order from the pinned
 * `binaryText` scan), decoded through the same row-codec helpers production
 * uses. Callers that need a specific order must impose it themselves in JS —
 * exactly what 0.45's `readIdentityAssertionsForInterchange` did before this
 * read carried its own `ORDER BY`.
 */
async function fetchAssertionsIndependently(
  graphId: string,
): Promise<readonly IdentityTransferAssertion[]> {
  const result = await requirePool().query<RawIdentityAssertionRow>(
    `SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id, valid_from,
            valid_to, created_at, updated_at, deleted_at, ended_by_kind,
            ended_by_id
       FROM typegraph_identity_assertions
      WHERE graph_id = $1 AND deleted_at IS NULL AND valid_to IS NULL`,
    [graphId],
  );
  return result.rows.map((row) =>
    toTransferAssertion(normalizeIdentityAssertionRow(row)),
  );
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

    it("reads mixed-case assertion ids in code-point order", async (ctx) => {
      const target = requireDefined(backend);
      const store = await seedAssertions(target);

      // Naming the collation `C`/`POSIX` is not what matters — whether it
      // actually reorders THIS fixture's ids is. Run the identical scan with
      // the collation pin removed (bare `ORDER BY id`) and compare it to
      // code-point order directly. Only a provable disagreement here makes the
      // pinned assertion below load-bearing.
      const unpinnedOrder = await readUnpinnedAssertionIdOrder(graph.id);
      const unpinnedAlreadyMatchesCodePointOrder =
        JSON.stringify(unpinnedOrder) === JSON.stringify(CODE_POINT_ORDER);
      if (unpinnedAlreadyMatchesCodePointOrder) {
        // Not a silent pass: announce why the discriminating case is absent.
        console.warn(
          "[identity-interchange-order] skipped: this database's default " +
            `collation already orders ${JSON.stringify(ASSERTION_IDS)} as ` +
            `code-point order (unpinned read: ${JSON.stringify(unpinnedOrder)}). ` +
            "The pinned and unpinned reads would agree either way, so this " +
            "run cannot distinguish the fix from its absence.",
        );
        ctx.skip();
        return;
      }

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

      // Pin the 0.45 compatibility expectation INDEPENDENTLY of the code
      // under test: fetch the assertions through a raw query with no
      // `ORDER BY` at all (so this array cannot inherit order from the pinned
      // `binaryText` scan), then sort in JS with the exact comparator 0.45's
      // `readIdentityAssertionsForInterchange` used before this read carried
      // its own pinned `ORDER BY`. Feeding that into `computeContentComponent`
      // — the same hashing entry point the production fingerprint uses —
      // gives an expectation that does not depend on `asRead`'s order at all.
      const independentlyFetched = await fetchAssertionsIndependently(graph.id);
      const independentlySorted = [...independentlyFetched].toSorted(
        (left, right) => compareCodePoints(left.id, right.id),
      );
      const expectedContentComponent = await computeContentComponent(
        target,
        graph.id,
        graph,
        independentlySorted,
      );

      // The regression this guards: `computeContentComponent` hashes the
      // read's output positionally, so a locale-ordered read mints a
      // different `base@V` token than the same content did before — a
      // spurious BaseVersionMismatchError on an untouched base. `asRead` comes
      // straight from the production, pinned-SQL path with no re-sort here —
      // if the collation pin were reverted on a discriminating locale, its
      // order would follow the database's locale collation instead of
      // code-point order, disagreeing with `expectedContentComponent` above
      // and failing this assertion.
      const asRead = await storeRuntime(store).identityAssertionsAtTarget(
        target,
        "state",
      );
      expect(
        await computeContentComponent(target, graph.id, graph, asRead),
      ).toBe(expectedContentComponent);
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
