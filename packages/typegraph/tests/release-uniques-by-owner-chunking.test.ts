/**
 * `releaseUniquesByOwner` stays within the backend's statement limits however
 * many constraints a release names and however many claims it keeps.
 *
 * The release binds the owner, the timestamp, one name per constraint and two
 * values per kept claim, so a write that moves many constraints at once can
 * outgrow one statement's bind budget (D1 declares 100). The bundled backend
 * splits it by constraint under the budget it was constructed with — a
 * constraint's kept claims always travel with its name — and the kept claims
 * are one flat row-value list, so the predicate's depth does not grow with
 * them (SQLite refuses an expression nested past 1000 levels).
 *
 * The budget is pinned at backend CONSTRUCTION, where chunk sizes are frozen;
 * the local engine accepts more binds than the pinned budget, so each case
 * records every statement prepared on the connection and asserts the release
 * statements' bind counts directly.
 *
 * A constraint whose kept claims alone exceed the budget cannot be split: the
 * statement carrying one part of its kept list would release the keys another
 * part keeps. The backend reads the owner's live keys under that constraint
 * and gives back exactly those outside its complete kept list.
 *
 * REVERT CHECK: building the release as one statement fails the 33-constraint
 * case on its bind count (103 > 100); restoring the `AND NOT (...)` chain per
 * kept claim fails the 1000-claim case with SQLite's expression-depth error;
 * restoring the split by constraint alone fails the 48-claim case with
 * `CompilerInvariantError` (101 > 96 binds for one constraint).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type GraphBackend,
  MODERN_SQLITE_MAX_BIND_PARAMETERS,
} from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { compareStrings } from "../src/utils/compare";
import { createInitializedStore } from "./test-utils";

const GRAPH_ID = "release_uniques_by_owner_chunking";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });

const graph = defineGraph({
  id: GRAPH_ID,
  nodes: { Item: { type: Item } },
  edges: {},
});

const openBackends: GraphBackend[] = [];

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((backend) => backend.close()));
});

/** The one member of the driver client the bind assertion observes. */
interface SqliteClient {
  prepare: (source: string) => unknown;
}

async function createBudgetedBackend(maxBindParameters: number) {
  const { backend, db } = createLocalSqliteBackend({
    capabilities: { maxBindParameters },
  });
  openBackends.push(backend);
  await createInitializedStore(graph, backend);
  const { $client: client } = db as unknown as Readonly<{
    $client: SqliteClient;
  }>;
  return { backend, client };
}

function constraintName(index: number): string {
  return `Item_c${String(index).padStart(4, "0")}`;
}

/**
 * The owner holds two live claims under each of `count` constraints: the
 * one a write keeps, and a stale one the release must give back.
 */
async function seedOwnerClaims(
  backend: GraphBackend,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    for (const key of [`kept${index}`, `stale${index}`]) {
      await backend.insertUnique({
        graphId: GRAPH_ID,
        nodeKind: "Item",
        constraintName: constraintName(index),
        key,
        nodeId: "owner",
        concreteKind: "Item",
      });
    }
  }
}

/** Every live claim of the owner, as `constraint:key`, sorted. */
async function liveOwnerClaims(
  backend: GraphBackend,
): Promise<readonly string[]> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<
    Readonly<{ constraint_name: string; key: string }>
  >(
    asCompiledRowsSql(sql`
      SELECT constraint_name, key
      FROM ${sql.identifier(schema.tables.uniques)}
      WHERE graph_id = ${GRAPH_ID}
        AND node_id = ${"owner"}
        AND deleted_at IS NULL
    `),
  );
  return rows
    .map((row) => `${row.constraint_name}:${row.key}`)
    .toSorted((left, right) => compareStrings(left, right));
}

/** Runs `operation`, returning the bind count of every release statement. */
async function releaseStatementBinds(
  client: SqliteClient,
  operation: () => Promise<unknown>,
): Promise<readonly number[]> {
  const prepared = vi.spyOn(client, "prepare");
  let statements: readonly string[];
  try {
    await operation();
  } finally {
    // Read before restoring: `mockRestore` also clears the recorded calls.
    statements = prepared.mock.calls.map(([source]) => source);
    prepared.mockRestore();
  }
  return statements
    .filter((source) => /\bUPDATE\b/.test(source))
    .map((source) => source.match(/\?/g)?.length ?? 0);
}

function releaseAll(backend: GraphBackend, count: number): Promise<void> {
  const names = Array.from({ length: count }, (_, index) =>
    constraintName(index),
  );
  return backend.releaseUniquesByOwner({
    graphId: GRAPH_ID,
    concreteKind: "Item",
    nodeId: "owner",
    constraintNames: names,
    keep: names.map((name, index) => ({
      constraintName: name,
      key: `kept${index}`,
    })),
  });
}

function keptClaims(count: number): readonly string[] {
  return Array.from(
    { length: count },
    (_, index) => `${constraintName(index)}:kept${index}`,
  ).toSorted((left, right) => compareStrings(left, right));
}

/**
 * Seeds one owner with 48 kept and 3 stale claims under one constraint (a
 * kept and a stale one also at a second axis) and a kept and a stale claim
 * under a second. Returns the release of both constraints, and the claims it
 * must leave live.
 */
async function seedWideConstraint(
  backend: GraphBackend,
): Promise<
  Readonly<{ release: () => Promise<void>; expected: readonly string[] }>
> {
  const wide = constraintName(0);
  const narrow = constraintName(1);
  const kept = Array.from({ length: 48 }, (_, index) => `kept${index}`);
  const claims = [
    // Every kept key, one of them also at a second axis, and three stale
    // keys (one at the second axis only) the release must give back.
    ...kept.map((key) => ({ axis: "Item", constraint: wide, key })),
    { axis: "LegacyItem", constraint: wide, key: "kept47" },
    { axis: "Item", constraint: wide, key: "stale0" },
    { axis: "Item", constraint: wide, key: "stale1" },
    { axis: "LegacyItem", constraint: wide, key: "stale2" },
    // A second constraint that fits one statement.
    { axis: "Item", constraint: narrow, key: "keptN" },
    { axis: "Item", constraint: narrow, key: "staleN" },
  ];
  for (const held of claims) {
    await backend.insertUnique({
      graphId: GRAPH_ID,
      nodeKind: held.axis,
      constraintName: held.constraint,
      key: held.key,
      nodeId: "owner",
      concreteKind: "Item",
    });
  }

  const release = () =>
    backend.releaseUniquesByOwner({
      graphId: GRAPH_ID,
      concreteKind: "Item",
      nodeId: "owner",
      constraintNames: [wide, narrow],
      keep: [
        ...kept.map((key) => ({ constraintName: wide, key })),
        { constraintName: narrow, key: "keptN" },
      ],
    });
  return {
    release,
    expected: [
      ...kept.map((key) => `${wide}:${key}`),
      `${wide}:kept47`,
      `${narrow}:keptN`,
    ].toSorted((left, right) => compareStrings(left, right)),
  };
}

describe("releaseUniquesByOwner statement limits", () => {
  it("splits a release of 33 kept constraints under a 100-bind budget", async () => {
    const { backend, client } = await createBudgetedBackend(100);
    await seedOwnerClaims(backend, 33);

    const binds = await releaseStatementBinds(client, () =>
      releaseAll(backend, 33),
    );

    // One statement would bind 4 + 33 + 2 × 33 = 103.
    expect(binds.length).toBeGreaterThan(1);
    expect(binds.filter((count) => count > 100)).toEqual([]);
    expect(await liveOwnerClaims(backend)).toEqual(keptClaims(33));
  });

  it("keeps 1000 claims in one statement without nesting the predicate", async () => {
    const { backend, client } = await createBudgetedBackend(
      MODERN_SQLITE_MAX_BIND_PARAMETERS,
    );
    await seedOwnerClaims(backend, 1000);

    const binds = await releaseStatementBinds(client, () =>
      releaseAll(backend, 1000),
    );

    expect(binds).toEqual([4 + 1000 + 2 * 1000]);
    expect(await liveOwnerClaims(backend)).toEqual(keptClaims(1000));
  });

  it("releases one constraint keeping 48 claims under a 100-bind budget, and keeps every one of them", async () => {
    const { backend, client } = await createBudgetedBackend(100);
    const { release, expected } = await seedWideConstraint(backend);

    const binds = await releaseStatementBinds(client, release);

    // Keeping 48 claims in one list would bind 4 + 1 + 2 × 48 = 101.
    expect(binds.length).toBeGreaterThan(0);
    expect(binds.filter((count) => count > 100)).toEqual([]);
    expect(await liveOwnerClaims(backend)).toEqual(expected);
  });

  it("releases one constraint keeping 48 claims under a 100-bind budget on PGlite", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    openBackends.push(local.backend);
    const backend = createPostgresBackend(local.db, {
      vector: false,
      capabilities: { maxBindParameters: 100 },
    });
    await createInitializedStore(graph, backend);

    const { release, expected } = await seedWideConstraint(backend);

    await release();

    expect(await liveOwnerClaims(backend)).toEqual(expected);
  });

  it("issues no statement for an empty constraint list", async () => {
    const { backend, client } = await createBudgetedBackend(100);
    await seedOwnerClaims(backend, 1);

    const binds = await releaseStatementBinds(client, () =>
      backend.releaseUniquesByOwner({
        graphId: GRAPH_ID,
        concreteKind: "Item",
        nodeId: "owner",
        constraintNames: [],
        keep: [],
      }),
    );

    expect(binds).toEqual([]);
    expect(await liveOwnerClaims(backend)).toHaveLength(2);
  });
});
