/**
 * The history store answers `tx.assertUnchangedSince` by packing each
 * recorded relation's per-scope selects into UNION ALL statements, each
 * within the backend's bind-parameter budget. The shared cross-backend suite
 * never splits (SQLite's budget is 32766), so the chunk boundaries are
 * exercised only here, with a deliberately tiny `maxBindParameters`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { GraphBackend } from "../src";
import {
  asNodeId,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { ReadSetChangedError } from "../src/errors-entry";
import type { CompiledRowsSql } from "../src/query/sql-intent";
import type { ReadSetScope } from "../src/store/read-set";
import { requireDefined } from "../src/utils/presence";
import { toSqlWithParams } from "./sql-test-utils";
import { createTestDatabase } from "./test-utils";

const Document = defineNode("Doc", { schema: z.object({ title: z.string() }) });
const chunkingGraph = defineGraph({
  id: "read_set_fence_chunking",
  nodes: { Doc: { type: Document } },
  edges: {},
});
type Scope = ReadSetScope<typeof chunkingGraph>;

const SMALL_BIND_BUDGET = 40;
const SCOPE_COUNT = 60;
const CHANGED_INDEXES = [0, 17, 18, 41, SCOPE_COUNT - 1] as const;

const CHANGED_KEYS_RELATION = "read_set_changed_keys";

/**
 * Counts the fence's changed-key statements and records the bind budget of the
 * transaction session that ran them, so the test proves the forced budget
 * reached the session the fence sizes its statements against.
 */
function observeFenceStatements(root: GraphBackend) {
  const statements: { sql: string; parameters: number }[] = [];
  const sessionBudgets: (number | undefined)[] = [];
  const backend = deriveBackend(root, {
    transaction: (run, options) =>
      root.transaction(async (tx) => {
        sessionBudgets.push(tx.capabilities.maxBindParameters);
        const observedTransaction = deriveBackend(tx, {
          execute: <T>(query: CompiledRowsSql) => {
            const compiled = toSqlWithParams(query);
            if (compiled.sql.includes(CHANGED_KEYS_RELATION))
              statements.push({
                sql: compiled.sql,
                parameters: compiled.params.length,
              });
            return tx.execute<T>(query);
          },
        });
        return run(observedTransaction);
      }, options),
  });
  return { backend, statements, sessionBudgets };
}

async function fixture() {
  const observed = observeFenceStatements(
    createSqliteBackend(createTestDatabase(), {
      capabilities: { maxBindParameters: SMALL_BIND_BUDGET },
    }),
  );
  const { backend } = observed;
  const [store] = await createStoreWithSchema(chunkingGraph, backend, {
    history: true,
  });
  const ids = Array.from(
    { length: SCOPE_COUNT },
    (_, index) => `chunked-${String(index).padStart(3, "0")}`,
  );
  await store.nodes.Doc.bulkCreate(
    ids.map((id) => ({ id, props: { title: id } })),
  );
  const scopes: readonly Scope[] = ids.map((id) => ({
    node: { kind: "Doc" as const, id: asNodeId<typeof Document>(id) },
  }));
  return { store, ids, scopes, ...observed };
}

function expectChunkedWithinBudget(
  statements: readonly Readonly<{ parameters: number }>[],
): void {
  expect(
    statements.length,
    "scopes must be split across several statements",
  ).toBeGreaterThan(2);
  for (const statement of statements)
    expect(statement.parameters).toBeLessThanOrEqual(SMALL_BIND_BUDGET);
}

describe("read-set fence statement chunking on the history path", () => {
  it("reports exactly the changed scopes when the scopes span several statements", async () => {
    const { store, ids, scopes, statements, sessionBudgets } = await fixture();
    const anchor = requireDefined(await store.lineageRevisionNow());
    for (const index of CHANGED_INDEXES) {
      await store.nodes.Doc.update(
        asNodeId<typeof Document>(requireDefined(ids[index])),
        { title: "changed" },
      );
    }

    const error = await store
      .transaction((tx) => tx.assertUnchangedSince(anchor, scopes))
      .then(
        () => "resolved",
        (error_: unknown) => error_,
      );

    expect(new Set(sessionBudgets)).toEqual(new Set([SMALL_BIND_BUDGET]));
    expectChunkedWithinBudget(statements);
    expect(error).toBeInstanceOf(ReadSetChangedError);
    const { changes } = (error as ReadSetChangedError).details;
    expect(changes.map((change) => change.index)).toEqual([...CHANGED_INDEXES]);
    expect(changes.map((change) => change.nodes)).toEqual(
      CHANGED_INDEXES.map((index) => [{ kind: "Doc", id: ids[index] }]),
    );
  });

  it("resolves when no scope changed, whatever the statement split", async () => {
    const { store, scopes, statements } = await fixture();
    const anchor = requireDefined(await store.lineageRevisionNow());

    await expect(
      store.transaction((tx) => tx.assertUnchangedSince(anchor, scopes)),
    ).resolves.toBeUndefined();
    expectChunkedWithinBudget(statements);
  });
});
