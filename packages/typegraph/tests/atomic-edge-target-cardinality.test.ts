/**
 * The silent-bypass guard for a target-only-constrained edge kind (issue
 * #610). Highest-value test in the target-cardinality change: every fast-path
 * eligibility gate that reads `cardinality === "many"` (single-write, bulk
 * batch, atomic-resolved-update, convergence) must be blind to NOTHING — a
 * kind declared `{cardinality: "many", targetCardinality: "one"}` still owes
 * a claim, so none of those gates may accept it into a program that writes no
 * claim.
 *
 * PGlite (a real PostgreSQL engine) rather than SQLite: the fused/atomic
 * command ports these gates protect are a PostgreSQL-only optimization
 * (`edgeCardinalityInsertFusion`), so only this engine can prove a claim
 * statement was actually issued.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CardinalityError, defineEdge, defineGraph, defineNode } from "../src";
import { createRecordedPostgresStore } from "./statement-recorder";

const Owner = defineNode("AebOwner", { schema: z.object({}) });
const Asset = defineNode("AebAsset", { schema: z.object({}) });

// Deliberately `cardinality: "many"` (the DEFAULT, unconstrained source) with
// `targetCardinality: "one"` — the exact shape a bare `!== "many"` check
// reads as unconstrained.
const owns = defineEdge("aebOwns", { schema: z.object({}) });

const graph = defineGraph({
  id: "atomic_edge_target_cardinality",
  nodes: { AebOwner: { type: Owner }, AebAsset: { type: Asset } },
  edges: {
    aebOwns: {
      type: owns,
      from: [Owner],
      to: [Asset],
      targetCardinality: "one",
    },
  },
});

function claimStatements(queries: readonly string[]): readonly string[] {
  return queries.filter((query) =>
    /insert into "typegraph_edge_claims"/iu.test(query),
  );
}

describe("target-only-constrained edge kind never takes a claim-free fast path", () => {
  it("issues a claim statement on the single-write path, and refuses a second incoming edge", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const owner1 = await fixture.store.nodes.AebOwner.create({});
    const owner2 = await fixture.store.nodes.AebOwner.create({});
    const asset = await fixture.store.nodes.AebAsset.create({});

    fixture.reset();
    await fixture.store.edges.aebOwns.create(owner1, asset, {});
    const statements = fixture.statements.map((statement) => statement.query);
    expect(claimStatements(statements).length).toBeGreaterThan(0);

    await expect(
      fixture.store.edges.aebOwns.create(owner2, asset, {}),
    ).rejects.toBeInstanceOf(CardinalityError);
  });
  // MUTATION CHECK (verified): in `validateAndPrepareEdgeCreate`
  // (`src/store/operations/edge-operations.ts`), replace
  // `const declarations: EdgeCardinalityDeclarations = registration;` with
  // `{ cardinality: registration.cardinality ?? "many" }` (i.e. blind to
  // `targetCardinality`, the pre-D.1 shape). `claimStatements(statements)
  // .length` then drops to 0 and the first assertion above fails — this one
  // mutation also fails the next two tests, since all three share this
  // construction site.

  it("issues a claim statement on the bulk-create path, refusing the second of two targeting one asset", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const owner1 = await fixture.store.nodes.AebOwner.create({});
    const owner2 = await fixture.store.nodes.AebOwner.create({});
    const asset1 = await fixture.store.nodes.AebAsset.create({});
    const asset2 = await fixture.store.nodes.AebAsset.create({});

    fixture.reset();
    const results = await fixture.store.edges.aebOwns.bulkCreate([
      { from: owner1, to: asset1, props: {} },
      { from: owner2, to: asset2, props: {} },
    ]);
    expect(results).toHaveLength(2);
    const statements = fixture.statements.map((statement) => statement.query);
    expect(claimStatements(statements).length).toBeGreaterThan(0);

    await expect(
      fixture.store.edges.aebOwns.create(owner2, asset1, {}),
    ).rejects.toBeInstanceOf(CardinalityError);
  });
  // Covered by the same mutation above (verified): both assertions fail.

  it("re-probes on resurrection: a target-one asset freed by a hard delete is takeable, and blocked once retaken", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const owner1 = await fixture.store.nodes.AebOwner.create({});
    const owner2 = await fixture.store.nodes.AebOwner.create({});
    const owner3 = await fixture.store.nodes.AebOwner.create({});
    const asset = await fixture.store.nodes.AebAsset.create({});

    const first = await fixture.store.edges.aebOwns.create(owner1, asset, {});
    await expect(
      fixture.store.edges.aebOwns.create(owner2, asset, {}),
    ).rejects.toBeInstanceOf(CardinalityError);

    await fixture.store.edges.aebOwns.delete(first.id);
    // The slot is genuinely freed by the delete, not merely "eligible for a
    // program that skips the probe": a claim-free fast path would let BOTH
    // of the next two writes land.
    await fixture.store.edges.aebOwns.create(owner2, asset, {});
    await expect(
      fixture.store.edges.aebOwns.create(owner3, asset, {}),
    ).rejects.toBeInstanceOf(CardinalityError);
  });
  // Covered by the same mutation above (verified): `owner2`'s create after
  // the resurrection also wrongly succeeds instead of refusing.
});
