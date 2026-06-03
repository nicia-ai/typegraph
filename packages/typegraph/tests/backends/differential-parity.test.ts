/**
 * Differential backend-parity harness.
 *
 * The strongest guarantee that a query behaves identically across backends: run
 * the SAME query against BOTH a SQLite store and an (in-process, WASM)
 * PostgreSQL/PGlite store seeded with identical data, and assert the results
 * match. This is the net that catches semantic divergence the type system and
 * the `dialect.name` lint cannot see — it would have flagged the set-operation
 * gap instantly (SQLite threw, PostgreSQL returned rows).
 *
 * Scope: the PORTABLE query surface that MUST be identical — predicates,
 * ordering (incl. NULL placement), aggregates, traversals, recursion, set
 * operations, and pagination. Vector and fulltext are deliberately excluded:
 * they have *declared* engine gaps (see the capability matrix in
 * `backend-setup.md`), so identical behavior is not expected and is covered by
 * their own backend-specific tests.
 *
 * Comparison rules:
 * - Queries project business fields (names, prices, …), never generated ids, so
 *   the per-backend id nondeterminism is irrelevant.
 * - Results are compared as multisets unless the case declares a total order.
 * - Values are normalized: floats are rounded, and numeric-looking strings
 *   (PostgreSQL numeric/decimal can arrive as a string) are coerced to numbers.
 *   This is safe because no business field in the seed is a numeric-looking
 *   string.
 *
 * Runs in the default `pnpm test` lane: SQLite via better-sqlite3, PostgreSQL
 * via PGlite (Postgres-in-WASM) — no Docker.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avg, count, createStoreWithSchema, field, sum } from "../../src";
import { createSqliteBackend } from "../../src/backend/sqlite";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { type IntegrationStore, integrationTestGraph } from "./integration";
import {
  setupSharedPgliteEngine,
  type SharedPgliteEngine,
} from "./postgres/pglite-correctness-harness";

// ============================================================
// Seed — identical structure on both backends
// ============================================================

async function seedParityCorpus(store: IntegrationStore): Promise<void> {
  const tech = await store.nodes.Company.create({
    name: "TechCorp",
    industry: "Tech",
  });
  await store.nodes.Company.create({ name: "DataInc", industry: "Tech" });
  const bio = await store.nodes.Company.create({
    name: "BioMed",
    industry: "Healthcare",
  });
  await store.nodes.Company.create({
    name: "HealthFirst",
    industry: "Healthcare",
  });
  const finance = await store.nodes.Company.create({
    name: "FinanceHub",
    industry: "Finance",
  });

  const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
  const bob = await store.nodes.Person.create({ name: "Bob", age: 25 });
  const charlie = await store.nodes.Person.create({ name: "Charlie" }); // age null
  const diana = await store.nodes.Person.create({ name: "Diana", age: 40 });
  const eve = await store.nodes.Person.create({ name: "Eve", age: 25 });

  await store.edges.worksAt.create(alice, tech, {
    role: "Engineer",
    salary: 100_000,
  });
  await store.edges.worksAt.create(bob, finance, {
    role: "Analyst",
    salary: 80_000,
  });
  await store.edges.worksAt.create(diana, bio, { role: "Researcher" }); // null salary

  // knows chain: Alice → Bob → Charlie → Diana → Eve, plus a direct Alice → Charlie.
  await store.edges.knows.create(alice, bob, { since: "2020" });
  await store.edges.knows.create(bob, charlie, { since: "2021" });
  await store.edges.knows.create(charlie, diana, { since: "2022" });
  await store.edges.knows.create(diana, eve, { since: "2023" });
  await store.edges.knows.create(alice, charlie, { since: "2019" });

  await store.nodes.Product.create({
    name: "Laptop",
    price: 1200,
    category: "Electronics",
  });
  await store.nodes.Product.create({
    name: "Mouse",
    price: 25,
    category: "Electronics",
  });
  await store.nodes.Product.create({
    name: "Monitor",
    price: 300,
    category: "Electronics",
  });
  await store.nodes.Product.create({
    name: "Desk",
    price: 450,
    category: "Furniture",
  });
  await store.nodes.Product.create({
    name: "Chair",
    price: 150,
    category: "Furniture",
  });
}

// ============================================================
// Corpus — read-only queries over the portable surface
// ============================================================

type ParityCase = Readonly<{
  name: string;
  run: (store: IntegrationStore) => Promise<readonly unknown[]>;
  /** Compare results in order (the query has a total order). Default: multiset. */
  ordered?: boolean;
}>;

const CASES: readonly ParityCase[] = [
  {
    name: "predicate: eq on number",
    run: (store) =>
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.age.eq(25))
        .select((ctx) => ctx.p.name)
        .execute(),
  },
  {
    name: "predicate: gt",
    run: (store) =>
      store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.price.gt(100))
        .select((ctx) => ctx.p.name)
        .execute(),
  },
  {
    name: "predicate: in",
    run: (store) =>
      store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.in(["Tech", "Finance"]))
        .select((ctx) => ctx.c.name)
        .execute(),
  },
  {
    name: "predicate: isNull",
    run: (store) =>
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.age.isNull())
        .select((ctx) => ctx.p.name)
        .execute(),
  },
  {
    name: "predicate: between",
    run: (store) =>
      store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.price.between(100, 500))
        .select((ctx) => ctx.p.name)
        .execute(),
  },
  {
    name: "ordering: age asc, NULLS placement (name tiebreaker)",
    ordered: true,
    run: (store) =>
      store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "asc")
        .orderBy("p", "name", "asc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute(),
  },
  {
    name: "ordering: name desc",
    ordered: true,
    run: (store) =>
      store
        .query()
        .from("Product", "p")
        .orderBy("p", "name", "desc")
        .select((ctx) => ctx.p.name)
        .execute(),
  },
  {
    name: "aggregate: groupBy count",
    run: (store) =>
      store
        .query()
        .from("Company", "c")
        .groupBy("c", "industry")
        .aggregate({ industry: field("c", "industry"), n: count("c") })
        .execute(),
  },
  {
    name: "aggregate: sum + avg by category",
    run: (store) =>
      store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .aggregate({
          category: field("p", "category"),
          total: sum("p", "price"),
          mean: avg("p", "price"),
        })
        .execute(),
  },
  {
    name: "traversal: worksAt filtered by industry",
    run: (store) =>
      store
        .query()
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.p.name)
        .execute(),
  },
  {
    name: "traversal: optional (LEFT JOIN)",
    run: (store) =>
      store
        .query()
        .from("Person", "p")
        .optionalTraverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ({ person: ctx.p.name, company: ctx.c?.name }))
        .execute(),
  },
  {
    name: "recursive: knows reachability from Alice (unlimited)",
    run: (store) =>
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive()
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute(),
  },
  {
    name: "recursive: knows reachability from Alice (maxHops 2)",
    run: (store) =>
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive({ maxHops: 2 })
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute(),
  },
  {
    name: "set op: union",
    run: (store) => {
      const tech = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);
      const healthcare = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Healthcare"))
        .select((ctx) => ctx.c.name);
      return tech.union(healthcare).execute();
    },
  },
  {
    name: "set op: intersect",
    run: (store) => {
      const all = store
        .query()
        .from("Company", "c")
        .select((ctx) => ctx.c.name);
      const tech = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);
      return all.intersect(tech).execute();
    },
  },
  {
    name: "set op: except",
    run: (store) => {
      const all = store
        .query()
        .from("Company", "c")
        .select((ctx) => ctx.c.name);
      const tech = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);
      return all.except(tech).execute();
    },
  },
  {
    // The exact shape that used to throw on SQLite while running on Postgres.
    name: "set op: union of traversal-filtered queries",
    run: (store) => {
      const techWorkers = store
        .query()
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.p.name);
      const financeWorkers = store
        .query()
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Finance"))
        .select((ctx) => ctx.p.name);
      return techWorkers.union(financeWorkers).execute();
    },
  },
  {
    name: "set op: union with per-leaf ORDER BY + LIMIT",
    run: (store) => {
      const topTech = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .orderBy("c", "name", "asc")
        .limit(1)
        .select((ctx) => ctx.c.name);
      const topHealth = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Healthcare"))
        .orderBy("c", "name", "asc")
        .limit(1)
        .select((ctx) => ctx.c.name);
      return topTech.union(topHealth).execute();
    },
  },
  {
    name: "pagination: ORDER BY price, LIMIT 2 OFFSET 1",
    ordered: true,
    run: (store) =>
      store
        .query()
        .from("Product", "p")
        .orderBy("p", "price", "asc")
        .limit(2)
        .offset(1)
        .select((ctx) => ctx.p.name)
        .execute(),
  },
];

// ============================================================
// Comparison
// ============================================================

/** Canonical stand-in for SQL NULL / `undefined`, so the two normalize equally. */
const NULL_SENTINEL = "∅";

function roundFloat(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined || value === null) return NULL_SENTINEL;
  if (typeof value === "number") return roundFloat(value);
  // PostgreSQL numeric/decimal can come back as a string; SQLite returns a JS
  // number. Coerce so aggregate parity (sum/avg/count) survives the driver
  // difference. Skip leading-zero strings (e.g. a "00123" code) — those are
  // never numeric-aggregate output, and coercing them could collide a string
  // field with a real number and mask a divergence.
  if (
    typeof value === "string" &&
    /^-?\d+(\.\d+)?$/.test(value) &&
    !/^-?0\d/.test(value)
  ) {
    return roundFloat(Number(value));
  }
  if (Array.isArray(value)) {
    return value.map((element) => normalizeValue(element));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).toSorted()) {
      normalized[key] = normalizeValue(record[key]);
    }
    return normalized;
  }
  return value;
}

function canonical(rows: readonly unknown[]): string[] {
  return rows.map((row) => JSON.stringify(normalizeValue(row)));
}

// ============================================================
// Suite
// ============================================================

describe("Differential backend parity (SQLite vs PGlite)", () => {
  let sqliteStore: IntegrationStore;
  let pgStore: IntegrationStore;
  let engine: SharedPgliteEngine;

  beforeAll(async () => {
    const { db } = createLocalSqliteBackend();
    [sqliteStore] = await createStoreWithSchema(
      integrationTestGraph,
      createSqliteBackend(db),
    );

    engine = await setupSharedPgliteEngine();
    [pgStore] = await createStoreWithSchema(
      integrationTestGraph,
      engine.makeBackend(),
    );

    // Independent stores — seed concurrently.
    await Promise.all([
      seedParityCorpus(sqliteStore),
      seedParityCorpus(pgStore),
    ]);
  });

  afterAll(async () => {
    await engine.dispose();
  });

  for (const parityCase of CASES) {
    it(`agrees across backends — ${parityCase.name}`, async () => {
      const [sqliteRows, pgRows] = await Promise.all([
        parityCase.run(sqliteStore),
        parityCase.run(pgStore),
      ]);

      // The corpus is intentionally all-non-empty: a result that is empty on
      // either backend signals a seed/query mistake (and an empty-on-both case
      // would otherwise pass vacuously). Check both backends, not just one.
      expect(sqliteRows.length).toBeGreaterThan(0);
      expect(pgRows.length).toBeGreaterThan(0);

      // Compare in order when the query has a total order; otherwise as a
      // multiset (unordered queries may return rows in any order).
      const sqliteCanonical = canonical(sqliteRows);
      const pgCanonical = canonical(pgRows);
      const [expected, actual] =
        parityCase.ordered ?
          [sqliteCanonical, pgCanonical]
        : [sqliteCanonical.toSorted(), pgCanonical.toSorted()];

      expect(actual).toEqual(expected);
    });
  }
});
