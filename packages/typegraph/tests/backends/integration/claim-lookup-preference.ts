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
 * Rule 2 is the one that can be got wrong silently, so the first cases seed a
 * TOMBSTONED row at the axis — the row a first-hit lookup reads — and a LIVE
 * row at a legacy kind, owned by a different node. A lookup that stops at the
 * first hit returns the wrong node, and it returns it as a plain `found`.
 *
 * The preference orders the rows; it does not pick one. A released row whose
 * node no longer holds the key is inert, and an inert preferred row must not
 * hide an eligible one behind it, so later cases seed an inert row at the
 * axis over a legacy row whose tombstone still holds the key.
 *
 * Rule 2 holds even when a live row names a node that no longer exists: a
 * live reservation is in force, so while any live row exists only a live row
 * answers, and no tombstone is revived over it. The last cases seed a live
 * row naming a missing node ahead of the real holder, and beside a released
 * row whose tombstone would otherwise qualify — on every lookup route, since
 * the batched lookup reads claim rows two different ways, and through the find
 * lookups, which resolve their live rows by the same rule.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  subClassOf,
  UniquenessError,
} from "../../../src";
import { projectBackendWithout } from "../../../src/backend/derive-backend";
import { type GraphBackend } from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import { buildKindRegistry } from "../../../src/registry";
import { uniquenessClaimAxis } from "../../../src/store/claims/axis";
import { requireDefined } from "../../../src/utils/presence";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

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

/**
 * Builds the shape in which the PREFERRED row is inert and an eligible one
 * sits behind it: the axis row is released by a live node that moved off the
 * key, and the legacy row is released by a deleted node that still holds it.
 * Returns the tombstone's id — the node the lookup must revive.
 */
async function seedInertAxisOverLegacyTombstone(
  store: Awaited<ReturnType<typeof createLookupStore>>,
  email: string,
): Promise<string> {
  const backend = store.backend;
  const key = emailKey(email);
  const tombstone = await store.nodes.LookupEmployee.create(
    { email },
    { id: `${email}-tombstone` },
  );
  await backend.insertUnique({
    graphId: lookupGraph.id,
    nodeKind: LEGACY_KIND,
    constraintName: LOOKUP_EMAIL_CONSTRAINT,
    key,
    nodeId: tombstone.id,
    concreteKind: "LookupEmployee",
  });
  await backend.deleteUnique({
    graphId: lookupGraph.id,
    nodeKind: AXIS,
    constraintName: LOOKUP_EMAIL_CONSTRAINT,
    key,
    concreteKind: "LookupEmployee",
    nodeId: tombstone.id,
  });
  await store.nodes.LookupEmployee.delete(tombstone.id);

  const mover = await store.nodes.LookupContractor.create(
    { email },
    { id: `${email}-mover` },
  );
  await store.nodes.LookupContractor.update(mover.id, {
    email: `moved-${email}`,
  });

  expect(await readSeededRows(backend, lookupGraph.id, key)).toEqual({
    axis: {
      nodeId: mover.id,
      concreteKind: "LookupContractor",
      released: true,
    },
    legacy: {
      nodeId: tombstone.id,
      concreteKind: "LookupEmployee",
      released: true,
    },
  });
  return tombstone.id;
}

/**
 * A hierarchy whose three kinds share one constraint name but not one scope:
 * `GhostAxis` and `GhostCat` span the hierarchy (axis `GhostAxis`, the
 * code-point minimum), while `GhostZebra` keeps its key to its own kind. A
 * lookup through `GhostAxis` therefore reads all three rows: the hierarchy
 * axis, `GhostCat`'s legacy row, and `GhostZebra`'s own-kind row.
 */
const GHOST_KEY_CONSTRAINT = "ghost_key";

const GhostAxis = defineNode("GhostAxis", {
  schema: z.object({ key: z.string() }),
});
const GhostCat = defineNode("GhostCat", {
  schema: z.object({ key: z.string() }),
});
const GhostZebra = defineNode("GhostZebra", {
  schema: z.object({ key: z.string() }),
});

function ghostKeyUnique(scope: "kind" | "kindWithSubClasses") {
  return {
    name: GHOST_KEY_CONSTRAINT,
    fields: ["key"],
    scope,
    collation: "binary",
  } as const;
}

const ghostGraph = defineGraph({
  id: "claim_lookup_live_ghost",
  nodes: {
    GhostAxis: {
      type: GhostAxis,
      unique: [ghostKeyUnique("kindWithSubClasses")],
    },
    GhostCat: {
      type: GhostCat,
      unique: [ghostKeyUnique("kindWithSubClasses")],
    },
    GhostZebra: { type: GhostZebra, unique: [ghostKeyUnique("kind")] },
  },
  edges: {},
  ontology: [
    subClassOf(GhostCat, GhostAxis),
    subClassOf(GhostZebra, GhostAxis),
  ],
});

const GHOST_ROUTES = [
  "single",
  "bulk",
  "bulk without checkUniqueBatch",
] as const;
type GhostRoute = (typeof GHOST_ROUTES)[number];

/**
 * Seeds a released `GhostZebra` row whose tombstone still holds the key — a
 * row that would qualify for resurrection on its own — and a live row at the
 * hierarchy axis naming a `GhostAxis` node that does not exist. Returns the
 * tombstone's id.
 */
async function seedGhostOverTombstone(
  store: InspectableStore<typeof ghostGraph>,
  value: string,
): Promise<string> {
  const tombstone = await store.nodes.GhostZebra.create(
    { key: value },
    { id: `${value}-zebra` },
  );
  await store.nodes.GhostZebra.delete(tombstone.id);
  await store.backend.insertUnique({
    graphId: ghostGraph.id,
    nodeKind: "GhostAxis",
    constraintName: GHOST_KEY_CONSTRAINT,
    key: computeUniqueKey({ key: value }, ["key"], "binary"),
    nodeId: `${value}-ghost`,
    concreteKind: "GhostAxis",
  });
  return tombstone.id;
}

/**
 * Adds the real holder behind the ghost: a live `GhostCat` whose row sits at
 * its own (legacy) kind, while the axis row stays the ghost's.
 */
async function seedLegacyHolderBehindGhost(
  store: InspectableStore<typeof ghostGraph>,
  value: string,
): Promise<string> {
  const backend = store.backend;
  const key = computeUniqueKey({ key: value }, ["key"], "binary");
  const holderId = `${value}-cat`;
  await backend.insertNode({
    graphId: ghostGraph.id,
    kind: "GhostCat",
    id: holderId,
    props: { key: value },
  });
  await backend.insertUnique({
    graphId: ghostGraph.id,
    nodeKind: "GhostCat",
    constraintName: GHOST_KEY_CONSTRAINT,
    key,
    nodeId: holderId,
    concreteKind: "GhostCat",
  });
  return holderId;
}

async function ghostGetOrCreate(
  store: InspectableStore<typeof ghostGraph>,
  route: GhostRoute,
  value: string,
): Promise<Readonly<{ action: string; id: string }>> {
  if (route === "single") {
    const result = await store.nodes.GhostAxis.getOrCreateByConstraint(
      GHOST_KEY_CONSTRAINT,
      { key: value },
    );
    return { action: result.action, id: result.node.id };
  }
  const target =
    route === "bulk" ? store : (
      createStore(
        ghostGraph,
        projectBackendWithout(store.backend, ["checkUniqueBatch"]),
      )
    );
  const [result] = await target.nodes.GhostAxis.bulkGetOrCreateByConstraint(
    GHOST_KEY_CONSTRAINT,
    [{ props: { key: value } }],
  );
  return { action: String(result?.action), id: String(result?.node.id) };
}

async function ghostFind(
  store: InspectableStore<typeof ghostGraph>,
  route: GhostRoute,
  value: string,
): Promise<string | undefined> {
  if (route === "single") {
    const found = await store.nodes.GhostAxis.findByConstraint(
      GHOST_KEY_CONSTRAINT,
      { key: value },
    );
    return found?.id;
  }
  const target =
    route === "bulk" ? store : (
      createStore(
        ghostGraph,
        projectBackendWithout(store.backend, ["checkUniqueBatch"]),
      )
    );
  const [found] = await target.nodes.GhostAxis.bulkFindByConstraint(
    GHOST_KEY_CONSTRAINT,
    [{ props: { key: value } }],
  );
  return found?.id;
}

async function isStillDeleted(
  backend: GraphBackend,
  id: string,
): Promise<boolean> {
  const row = await backend.getNode(ghostGraph.id, "GhostZebra", id);
  return row?.deleted_at !== undefined;
}

function createLookupStore(context: IntegrationTestContext) {
  return context.createStore(lookupGraph);
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

    it("revives an eligible legacy tombstone behind an inert axis row", async () => {
      const store = await createLookupStore(context);
      const email = "inert-single@lookup.example";
      const tombstoneId = await seedInertAxisOverLegacyTombstone(store, email);

      const result = await store.nodes.LookupEmployee.getOrCreateByConstraint(
        LOOKUP_EMAIL_CONSTRAINT,
        { email },
      );

      expect({ action: result.action, id: result.node.id }).toEqual({
        action: "resurrected",
        id: tombstoneId,
      });
    });

    it("revives an eligible legacy tombstone behind an inert axis row in the batched lookup", async () => {
      const store = await createLookupStore(context);
      const email = "inert-bulk@lookup.example";
      const tombstoneId = await seedInertAxisOverLegacyTombstone(store, email);

      const results =
        await store.nodes.LookupEmployee.bulkGetOrCreateByConstraint(
          LOOKUP_EMAIL_CONSTRAINT,
          [{ props: { email } }],
        );

      expect(
        results.map((entry) => ({ action: entry.action, id: entry.node.id })),
      ).toEqual([{ action: "resurrected", id: tombstoneId }]);
    });
  });

  describe("a live claim outranks every released claim", () => {
    for (const route of GHOST_ROUTES) {
      it(`finds the live holder behind a live row naming a missing node (${route})`, async () => {
        const store = await context.createStore(ghostGraph);
        const value = `behind-ghost-${route.replaceAll(" ", "-")}`;
        const tombstoneId = await seedGhostOverTombstone(store, value);
        const holderId = await seedLegacyHolderBehindGhost(store, value);

        const outcome = await ghostGetOrCreate(store, route, value);

        expect(outcome).toEqual({ action: "found", id: holderId });
        expect(await isStillDeleted(store.backend, tombstoneId)).toBe(true);
      });

      it(`finds the live holder behind a live row naming a missing node through the find lookup (${route})`, async () => {
        const store = await context.createStore(ghostGraph);
        const value = `find-behind-ghost-${route.replaceAll(" ", "-")}`;
        await seedGhostOverTombstone(store, value);
        const holderId = await seedLegacyHolderBehindGhost(store, value);

        expect(await ghostFind(store, route, value)).toBe(holderId);
      });

      it(`revives no tombstone over a live row naming a missing node (${route})`, async () => {
        const store = await context.createStore(ghostGraph);
        const value = `ghost-only-${route.replaceAll(" ", "-")}`;
        const tombstoneId = await seedGhostOverTombstone(store, value);

        await expect(ghostGetOrCreate(store, route, value)).rejects.toThrow(
          UniquenessError,
        );
        expect(await isStillDeleted(store.backend, tombstoneId)).toBe(true);
      });
    }
  });
}
