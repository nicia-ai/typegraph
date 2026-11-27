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
 * REVERT CHECK: building the release as one statement fails the 33-constraint
 * case on its bind count (103 > 100); restoring the `AND NOT (...)` chain per
 * kept claim fails the 1000-claim case with SQLite's expression-depth error.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
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
