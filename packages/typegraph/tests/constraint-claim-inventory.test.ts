/**
 * Every write path that makes a declared cardinality newly true issues a claim
 * — and the batch paths issue exactly ONE (I1, §9.8).
 *
 * The fence is only as complete as the set of paths that take it, and "did this
 * path claim?" is not visible in any outcome: a single writer enforces
 * cardinality correctly through the probe alone, so an unfenced path passes
 * every functional test in the suite. What distinguishes it is the statement
 * the engine is asked to run, which is what the shared recorder captures.
 *
 * The EXACTLY-one half is the other direction of the same invariant. The batch
 * paths claim once, sorted, against the real backend after preparation — never
 * per input inside the preparation loop, where the claims would be taken in
 * input order rather than canonical order and taken for rows the loop may still
 * refuse. Nothing structural forbids a future edit from claiming there (the
 * batch validation wrapper is a Proxy that forwards every claim member to the
 * real target, so such a claim would silently work), so the count is asserted
 * here.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { claimsVerdict } from "../src/backend/capabilities/resolve";
import { projectGraphBackend } from "../src/backend/derive-backend";
import { type GraphBackend } from "../src/backend/types";
import {
  FORMAT_VERSION,
  type GraphData,
  type GraphInterchangeChunk,
  importGraph,
  importGraphStream,
} from "../src/interchange";
import { claimSupport } from "../src/store/claims/backing";
import { createHistoryStoreBackendProjection } from "../src/store/history-store-backend";
import {
  createRecordedPostgresStore,
  type LoggedStatement,
} from "./statement-recorder";

const InventoryPerson = defineNode("InventoryPerson", {
  schema: z.object({ name: z.string() }),
});

/** Constrained: at most one live edge of this kind per source. */
const inventoryReportsTo = defineEdge("inventoryReportsTo", {
  schema: z.object({}),
});
/** Unconstrained: declares nothing, so it must claim nothing. */
const inventoryKnows = defineEdge("inventoryKnows", { schema: z.object({}) });
/** Constrained on the ACTIVE population, which a reopened window re-enters. */
const inventoryActiveShift = defineEdge("inventoryActiveShift", {
  schema: z.object({}),
});

const inventoryGraph = defineGraph({
  id: "constraint_claim_inventory",
  nodes: { InventoryPerson: { type: InventoryPerson } },
  edges: {
    inventoryReportsTo: {
      type: inventoryReportsTo,
      from: [InventoryPerson],
      to: [InventoryPerson],
      cardinality: "one",
    },
    inventoryKnows: {
      type: inventoryKnows,
      from: [InventoryPerson],
      to: [InventoryPerson],
    },
    inventoryActiveShift: {
      type: inventoryActiveShift,
      from: [InventoryPerson],
      to: [InventoryPerson],
      cardinality: "oneActive",
    },
  },
});

/** A bound already in the past, so an edge stated with it is born ended. */
const ENDED = "2020-01-01T00:00:00.000Z";

function edgeClaimStatements(
  statements: readonly LoggedStatement[],
): readonly LoggedStatement[] {
  return statements.filter((statement) =>
    /insert into "typegraph_edge_claims"/iu.test(statement.query),
  );
}

function edgeInsertIndex(statements: readonly LoggedStatement[]): number {
  return statements.findIndex((statement) =>
    /insert into "typegraph_edges"/iu.test(statement.query),
  );
}

function edgeClaimIndex(statements: readonly LoggedStatement[]): number {
  return statements.findIndex((statement) =>
    /insert into "typegraph_edge_claims"/iu.test(statement.query),
  );
}

function edgeUpdateIndex(statements: readonly LoggedStatement[]): number {
  return statements.findIndex((statement) =>
    /update "typegraph_edges"/iu.test(statement.query),
  );
}

/** The streamed protocol's chunks, as the async iterable the entry point takes. */
async function* chunkStream(
  chunks: readonly GraphInterchangeChunk[],
): AsyncIterable<GraphInterchangeChunk> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

function edgeClaimPurges(
  statements: readonly LoggedStatement[],
): readonly LoggedStatement[] {
  return statements.filter((statement) =>
    /delete from "typegraph_edge_claims"/iu.test(statement.query),
  );
}

function importPayload(
  nodes: GraphData["nodes"],
  edges: GraphData["edges"],
): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "claim inventory" },
    nodes,
    edges,
  };
}

const IMPORT_NODES: GraphData["nodes"] = [
  { kind: "InventoryPerson", id: "src-a", properties: { name: "A" } },
  { kind: "InventoryPerson", id: "src-b", properties: { name: "B" } },
  { kind: "InventoryPerson", id: "dst", properties: { name: "D" } },
];

const IMPORT_EDGES: GraphData["edges"] = [
  {
    kind: "inventoryReportsTo",
    id: "import-edge-a",
    from: { kind: "InventoryPerson", id: "src-a" },
    to: { kind: "InventoryPerson", id: "dst" },
    properties: {},
  },
  {
    kind: "inventoryReportsTo",
    id: "import-edge-b",
    from: { kind: "InventoryPerson", id: "src-b" },
    to: { kind: "InventoryPerson", id: "dst" },
    properties: {},
  },
];

describe("every constrained edge write claims its axis", () => {
  it("claims once on a single create, before the row it gates", async () => {
    const { store, statements, reset } =
      await createRecordedPostgresStore(inventoryGraph);
    const alice = await store.nodes.InventoryPerson.create({ name: "Alice" });
    const bob = await store.nodes.InventoryPerson.create({ name: "Bob" });

    reset();
    await store.edges.inventoryReportsTo.create(alice, bob, {});

    expect(edgeClaimStatements(statements)).toHaveLength(1);
    expect(edgeClaimIndex(statements)).toBeLessThan(
      edgeInsertIndex(statements),
    );
  });

  it("claims nothing for an unconstrained edge create", async () => {
    const { store, statements, reset } =
      await createRecordedPostgresStore(inventoryGraph);
    const alice = await store.nodes.InventoryPerson.create({ name: "Alice" });
    const bob = await store.nodes.InventoryPerson.create({ name: "Bob" });

    reset();
    await store.edges.inventoryKnows.create(alice, bob, {});

    expect(edgeClaimStatements(statements)).toHaveLength(0);
  });

  it("claims EXACTLY once for a whole batch create, before the rows", async () => {
    const { store, statements, reset } =
      await createRecordedPostgresStore(inventoryGraph);
    const alice = await store.nodes.InventoryPerson.create({ name: "Alice" });
    const bob = await store.nodes.InventoryPerson.create({ name: "Bob" });
    const carol = await store.nodes.InventoryPerson.create({ name: "Carol" });

    reset();
    await store.edges.inventoryReportsTo.bulkCreate([
      { from: alice, to: carol, props: {} },
      { from: bob, to: carol, props: {} },
    ]);

    // One statement for two constrained rows: a per-input claim inside the
    // preparation loop would make this two.
    expect(edgeClaimStatements(statements)).toHaveLength(1);
    expect(edgeClaimIndex(statements)).toBeLessThan(
      edgeInsertIndex(statements),
    );
  });

  it("claims on a resurrecting upsert, which re-admits the edge to the population", async () => {
    const { store, statements, reset } =
      await createRecordedPostgresStore(inventoryGraph);
    const alice = await store.nodes.InventoryPerson.create({ name: "Alice" });
    const bob = await store.nodes.InventoryPerson.create({ name: "Bob" });
    const created = await store.edges.inventoryReportsTo.create(alice, bob, {});
    await store.edges.inventoryReportsTo.delete(created.id);

    reset();
    // The tombstone is the only match, so this leg RESURRECTS it — which
    // re-admits the edge to the population the cardinality constrains and is
    // therefore a claim site of its own.
    const revived = await store.edges.inventoryReportsTo.getOrCreateByEndpoints(
      alice,
      bob,
      {},
    );
    expect(revived.action).toBe("resurrected");

    expect(edgeClaimStatements(statements)).toHaveLength(1);
  });

  it("claims when a reopened window re-enters the active population", async () => {
    // The other leg of the same site. #469 let an update clear an edge's upper
    // bound, which puts a row that was outside the `oneActive` population back
    // inside it — the identical "re-admitted after a probe no key backs" event a
    // resurrect is, reached through a different caller. A claim on the resurrect
    // leg alone would leave this one unfenced.
    const { store, statements, reset } =
      await createRecordedPostgresStore(inventoryGraph);
    const alice = await store.nodes.InventoryPerson.create({ name: "Alice" });
    const bob = await store.nodes.InventoryPerson.create({ name: "Bob" });
    const ended = await store.edges.inventoryActiveShift.create(
      alice,
      bob,
      {},
      { validTo: ENDED },
    );
    // Born ended, so it joined no active population and claimed nothing.
    expect(edgeClaimStatements(statements)).toHaveLength(0);

    reset();
    const reopened = await store.edges.inventoryActiveShift.update(
      ended.id,
      {},
      { clearValidTo: true },
    );

    expect(reopened.meta.validTo).toBeUndefined();
    expect(edgeClaimStatements(statements)).toHaveLength(1);
    expect(edgeClaimIndex(statements)).toBeLessThan(
      edgeUpdateIndex(statements),
    );
  });

  it("purges a hard-deleted constrained edge's claim, and only a constrained one's", async () => {
    // Housekeeping, not a fence: the claim is already takeable once the row
    // is gone. What must not happen is the relation growing by one row per
    // hard-deleted constrained edge — or an UNCONSTRAINED hard delete paying
    // for a statement it owes nothing to.
    const { store, statements, reset } =
      await createRecordedPostgresStore(inventoryGraph);
    const alice = await store.nodes.InventoryPerson.create({ name: "Alice" });
    const bob = await store.nodes.InventoryPerson.create({ name: "Bob" });
    const constrained = await store.edges.inventoryReportsTo.create(
      alice,
      bob,
      {},
    );
    const unconstrained = await store.edges.inventoryKnows.create(
      alice,
      bob,
      {},
    );

    reset();
    await store.edges.inventoryReportsTo.hardDelete(constrained.id);
    expect(edgeClaimPurges(statements)).toHaveLength(1);

    reset();
    await store.edges.inventoryKnows.hardDelete(unconstrained.id);
    expect(edgeClaimPurges(statements)).toHaveLength(0);
  });

  it("claims EXACTLY once for an importGraph slice, before the rows", async () => {
    const { store, statements, reset } =
      await createRecordedPostgresStore(inventoryGraph);

    reset();
    const result = await importGraph(
      store,
      importPayload(IMPORT_NODES, IMPORT_EDGES),
      { onConflict: "error", batchSize: 100, refreshStatistics: false },
    );
    expect(result.errors).toEqual([]);
    expect(result.edges.created).toBe(2);

    expect(edgeClaimStatements(statements)).toHaveLength(1);
    const claims = edgeClaimIndex(statements);
    const edgeInserts = statements.findIndex((statement) =>
      /insert into "typegraph_edges"/iu.test(statement.query),
    );
    expect(claims).toBeLessThan(edgeInserts);
  });

  it("claims on importGraphStream too, which is the other import entry point", async () => {
    const { store, statements, reset } =
      await createRecordedPostgresStore(inventoryGraph);

    reset();
    const payload = importPayload(IMPORT_NODES, IMPORT_EDGES);
    const result = await importGraphStream(
      store,
      chunkStream([
        {
          type: "header",
          header: {
            formatVersion: payload.formatVersion,
            exportedAt: payload.exportedAt,
            source: payload.source,
          },
        },
        { type: "nodes", nodes: payload.nodes },
        { type: "edges", edges: payload.edges },
      ]),
      { onConflict: "error", batchSize: 100, refreshStatistics: false },
    );
    expect(result.errors).toEqual([]);
    expect(result.edges.created).toBe(2);

    expect(edgeClaimStatements(statements)).toHaveLength(1);
  });
});

/**
 * Both projections carry the claim surface, checked through the ONE reader that
 * consumes it rather than by comparing two allowlists by eye.
 *
 * `capabilities` is forwarded verbatim by both projections while each METHOD is
 * a separate allowlist entry, so a dropped entry produces an object that claims
 * support it cannot deliver — a verdict read from a different object than the
 * write goes to. `claimSupport` is what refuses that, and asking it about each
 * projection is what makes the omission fail here instead of on a user's first
 * constrained edge write.
 */
describe("every projection of a claim-capable backend stays claim-capable", () => {
  it("answers supported on the store projection and on the history projection", async () => {
    const { backend } = await createRecordedPostgresStore(inventoryGraph);

    const storeProjection = projectGraphBackend(backend);
    expect(
      claimSupport(storeProjection, claimsVerdict(storeProjection)),
    ).toMatchObject({
      supported: true,
    });
    const historyProjection = createHistoryStoreBackendProjection(
      backend,
    ) as unknown as GraphBackend;
    expect(
      claimSupport(historyProjection, claimsVerdict(historyProjection)),
    ).toMatchObject({ supported: true });
  });
});
