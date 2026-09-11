/**
 * The ONE state a stated `identity.pairing` cannot be honored in: the target's
 * identity separation relation is missing (or never filled) while its ledger
 * holds a live `different` assertion. `bulkIsSeparated` refuses that read with
 * `IDENTITY_STORAGE_MISSING`, and `captureSeparationFactsForPairing`
 * (src/graph-merge/merge.ts) re-raises it as an invalid-option refusal naming
 * `identity.pairing` — an accepted option the state cannot honor, refused as
 * that option rather than surfaced as an opaque storage fault.
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
  id: "identity_pairing_storage_missing",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

const BRANCH_A = asBranchId("branch-a");
const SEPARATION_TABLE = "typegraph_identity_separation";

function rawClient(result: LocalSqliteBackendResult): Database.Database {
  return (result.db as unknown as { $client: Database.Database }).$client;
}

describe("identity.pairing against a target whose separation relation is unreadable", () => {
  const disposers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });

  async function makeBranchBackend() {
    const result = createLocalSqliteBackend();
    disposers.push(() => result.backend.close());
    return result.backend;
  }

  it("refuses the stated pairing as an invalid option naming identity.pairing, not as a storage fault", async () => {
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

    const result = await merge(target, [source], {
      branchOrder: [BRANCH_A],
      identity: { pairing: "definitional" },
    });
    if (isOk(result)) throw new Error("expected an invalid-options refusal");
    console.info("refusal:", result.error.code, result.error.details);
    expect(result.error.code).toBe("GRAPH_MERGE_INVALID_OPTIONS");
    expect(result.error.details["option"]).toBe("identity.pairing");
    expect(result.error.details["graphId"]).toBe(graph.id);
    // The storage fault travels as the cause, never as the face of the refusal.
    expect(
      (result.error.cause as { details: Record<string, unknown> }).details[
        "code"
      ],
    ).toBe("IDENTITY_STORAGE_MISSING");
  });
  // MUTATION CHECK: in `captureSeparationFactsForPairing` (src/graph-merge/
  // merge.ts) restore the comparison to `error.code !==
  // IDENTITY_STORAGE_MISSING_CODE` — `ConfigurationError.code` is always
  // `CONFIGURATION_ERROR`, so the translation never fires, the raw storage
  // fault propagates, and the `GRAPH_MERGE_INVALID_OPTIONS` assertion fails.
});
