/**
 * Cross-kind claim lookup has a STATED preference, not an iteration order
 * (Contract G).
 *
 * After the axis move a key can legitimately carry two claim rows: one written
 * by this version at the scope's axis, and one written by an older version
 * under a concrete kind. `getOrCreateByConstraint` decides which node to hand
 * back — or revive — from whichever row the lookup returns, so "whichever kind
 * the loop reached first" is not an answer. The rule is:
 *
 * 1. visit the axis first, then the remaining kinds in scope in code-point
 *    order;
 * 2. prefer a LIVE row over a tombstoned one, wherever each was found;
 * 3. among rows of the same liveness prefer the axis row, which rule 1 already
 *    delivers.
 *
 * Rule 2 is the one that can be got wrong silently, so every case here seeds a
 * TOMBSTONED row at the axis — the row a first-hit lookup reads — and a LIVE
 * row at a legacy kind, owned by a different node. A lookup that stops at the
 * first hit returns the wrong node, and it returns it as a plain `found`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, subClassOf } from "../../../src";
import { type GraphBackend } from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import { buildKindRegistry } from "../../../src/registry";
import { uniquenessClaimAxis } from "../../../src/store/claims/axis";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const LOOKUP_EMAIL_CONSTRAINT = "lookup_staff_email";

const LOOKUP_EMAIL_UNIQUE = {
  name: LOOKUP_EMAIL_CONSTRAINT,
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const LookupWorker = defineNode("LookupWorker", {
  schema: z.object({ email: z.string() }),
});
const LookupEmployee = defineNode("LookupEmployee", {
  schema: z.object({ email: z.string() }),
});
const LookupContractor = defineNode("LookupContractor", {
  schema: z.object({ email: z.string() }),
});

const lookupGraph = defineGraph({
  id: "claim_lookup_preference",
  nodes: {
    LookupWorker: { type: LookupWorker, unique: [LOOKUP_EMAIL_UNIQUE] },
    LookupEmployee: { type: LookupEmployee, unique: [LOOKUP_EMAIL_UNIQUE] },
    LookupContractor: { type: LookupContractor, unique: [LOOKUP_EMAIL_UNIQUE] },
  },
  edges: {},
  ontology: [
    subClassOf(LookupEmployee, LookupWorker),
    subClassOf(LookupContractor, LookupWorker),
  ],
});

const registry = buildKindRegistry(lookupGraph);
/** Where this version writes, and therefore the kind the lookup reads first. */
const AXIS = uniquenessClaimAxis(
  "LookupEmployee",
  "kindWithSubClasses",
  registry,
);
/** A kind in scope that is NOT the axis — where an older version would write. */
const LEGACY_KIND = "LookupEmployee";

function emailKey(email: string): string {
  return computeUniqueKey({ email }, ["email"], "binary");
}

/**
 * Rewrites one key's claim rows into the shape a half-migrated database has:
 * the live reservation under the holder's own kind (pre-axis), and a tombstone
 * at the axis left behind by a node that released the key afterwards.
 */
async function seedLegacyLiveAndAxisTombstone(
  backend: GraphBackend,
  graphId: string,
  key: string,
  holder: Readonly<{ kind: string; id: string }>,
  releaser: Readonly<{ kind: string; id: string }>,
): Promise<void> {
  await backend.insertUnique({
    graphId,
    nodeKind: LEGACY_KIND,
    constraintName: LOOKUP_EMAIL_CONSTRAINT,
    key,
    nodeId: holder.id,
    concreteKind: holder.kind,
  });
  await backend.deleteUnique({
    graphId,
    nodeKind: AXIS,
    constraintName: LOOKUP_EMAIL_CONSTRAINT,
    key,
    concreteKind: holder.kind,
    nodeId: holder.id,
  });
  // The tombstone at the axis belongs to somebody else, which is what makes
  // "which row did the lookup take?" observable in the node it returns.
  await backend.insertUnique({
    graphId,
    nodeKind: AXIS,
    constraintName: LOOKUP_EMAIL_CONSTRAINT,
    key,
    nodeId: releaser.id,
    concreteKind: releaser.kind,
  });
  await backend.deleteUnique({
    graphId,
    nodeKind: AXIS,
    constraintName: LOOKUP_EMAIL_CONSTRAINT,
    key,
    concreteKind: releaser.kind,
    nodeId: releaser.id,
  });
}

/** The seeded shape, asserted so a case cannot pass against drifted fixtures. */
async function readSeededRows(
  backend: GraphBackend,
  graphId: string,
  key: string,
): Promise<unknown> {
  const read = async (nodeKind: string) => {
    const row = await backend.checkUnique({
      graphId,
      nodeKind,
      constraintName: LOOKUP_EMAIL_CONSTRAINT,
      key,
      includeDeleted: true,
    });
    const found = requireDefined(row, `claim row at ${nodeKind}`);
    return {
      nodeId: found.node_id,
      concreteKind: found.concrete_kind,
      released: found.deleted_at !== undefined,
    };
  };
  return { axis: await read(AXIS), legacy: await read(LEGACY_KIND) };
}

export function registerClaimLookupPreferenceIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("cross-kind claim lookup preference", () => {
    it("takes the live claim at a legacy kind over the tombstone at the axis", async () => {
      const store = await context.createStore(lookupGraph);
      const backend = store.backend;
      const email = "single@lookup.example";
      const key = emailKey(email);

      const releaser = await store.nodes.LookupContractor.create(
        { email: "single-releaser@lookup.example" },
        { id: "lookup-single-releaser" },
      );
      const holder = await store.nodes.LookupEmployee.create(
        { email },
        { id: "lookup-single-holder" },
      );
      await seedLegacyLiveAndAxisTombstone(
        backend,
        lookupGraph.id,
        key,
        { kind: "LookupEmployee", id: holder.id },
        { kind: "LookupContractor", id: releaser.id },
      );
      expect(await readSeededRows(backend, lookupGraph.id, key)).toEqual({
        axis: {
          nodeId: releaser.id,
          concreteKind: "LookupContractor",
          released: true,
        },
        legacy: {
          nodeId: holder.id,
          concreteKind: "LookupEmployee",
          released: false,
        },
      });

      const result = await store.nodes.LookupEmployee.getOrCreateByConstraint(
        LOOKUP_EMAIL_CONSTRAINT,
        { email },
      );

      expect({ action: result.action, id: result.node.id }).toEqual({
        action: "found",
        id: holder.id,
      });
      // The lookup that hides tombstones must name the same node, or the two
      // readings of one key disagree.
      const found = await store.nodes.LookupEmployee.findByConstraint(
        LOOKUP_EMAIL_CONSTRAINT,
        { email },
      );
      expect(found?.id).toBe(holder.id);
    });

    it("takes the live claim at a legacy kind in the batched lookup too", async () => {
      const store = await context.createStore(lookupGraph);
      const backend = store.backend;
      const email = "bulk@lookup.example";
      const key = emailKey(email);

      const releaser = await store.nodes.LookupContractor.create(
        { email: "bulk-releaser@lookup.example" },
        { id: "lookup-bulk-releaser" },
      );
      const holder = await store.nodes.LookupEmployee.create(
        { email },
        { id: "lookup-bulk-holder" },
      );
      await seedLegacyLiveAndAxisTombstone(
        backend,
        lookupGraph.id,
        key,
        { kind: "LookupEmployee", id: holder.id },
        { kind: "LookupContractor", id: releaser.id },
      );

      const results =
        await store.nodes.LookupEmployee.bulkGetOrCreateByConstraint(
          LOOKUP_EMAIL_CONSTRAINT,
          [{ props: { email } }],
        );

      expect(
        results.map((entry) => ({ action: entry.action, id: entry.node.id })),
      ).toEqual([{ action: "found", id: holder.id }]);
    });
  });
}
