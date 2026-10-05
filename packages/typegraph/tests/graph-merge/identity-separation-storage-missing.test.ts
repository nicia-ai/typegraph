/**
 * A merge never answers "not separated" for a target whose identity separation
 * relation is unreadable. When the relation is missing (or never filled) while
 * the ledger holds a live `different` assertion, `bulkIsSeparated` refuses the
 * read with `IDENTITY_STORAGE_MISSING`, the merge's separation-fact capture
 * surfaces that refusal, and nothing is written.
 *
 * SQLite-local on purpose: the fixture drops the relation out from under a
 * live handle through the raw client, which the merge backend matrix has no
 * portable spelling for.
 */
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../src";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../../src/backend/sqlite/local";
import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "identity_separation_storage_missing",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

const BRANCH_A = asBranchId("branch-a");
const SEPARATION_TABLE = "typegraph_identity_separation";

/** `details` of an error and of every cause beneath it. */
function errorChain(error: unknown): readonly unknown[] {
  const details: unknown[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    details.push((current as Error & { details?: unknown }).details);
  }
  return details;
}

function rawClient(result: LocalSqliteBackendResult): Database.Database {
  return (result.db as unknown as { $client: Database.Database }).$client;
}

describe("a merge against a target whose separation relation is unreadable", () => {
  const disposers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });

  async function makeBranchBackend() {
    const result = createLocalSqliteBackend();
    disposers.push(() => result.backend.close());
    return result.backend;
  }

  it("refuses with the storage fault and writes nothing", async () => {
    const targetResult = createLocalSqliteBackend();
    disposers.push(() => targetResult.backend.close());
    const [target] = await createStoreWithSchema(graph, targetResult.backend, {
      history: true,
    });
    // A live `different` in the ledger is what makes the missing relation a
    // fact the veto must read — a graph separating nothing needs no relation.
    const alice = await target.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const bob = await target.nodes.Person.create(
      { name: "Bob" },
      { id: "bob" },
    );
    await target.identity.assertDifferent(alice, bob);

    const source = unwrap(
      await branch(target, () => makeBranchBackend(), { id: BRANCH_A }),
    );
    await source.store.nodes.Person.create({ name: "Ada" }, { id: "a1" });
    await source.store.nodes.Person.create({ name: "Ada L." }, { id: "b1" });
    await source.store.identity.assertSame(
      { kind: "Person", id: "a1" },
      { kind: "Person", id: "b1" },
    );

    // The relation goes away under the target's LIVE handle: every separation
    // read from here on is loud, and the merge's fact capture is one of them.
    rawClient(targetResult).exec(`DROP TABLE ${SEPARATION_TABLE}`);

    // A scored candidate pair gives the veto a pair to judge, so the plan's
    // own fact capture is what reads the relation.
    const outcome = await merge(target, [source], {
      branchOrder: [BRANCH_A],
      resolve: {
        Person: {
          block: () => "all",
          threshold: 0.5,
          similarity: { kind: "custom", score: () => 1 },
        },
      },
    }).then(
      (result) => (isOk(result) ? undefined : result.error),
      (error: unknown) => error,
    );
    console.info("refusal:", outcome);
    expect(JSON.stringify(errorChain(outcome))).toContain(
      "IDENTITY_STORAGE_MISSING",
    );
    expect(await target.nodes.Person.count()).toBe(2);
  });
});
