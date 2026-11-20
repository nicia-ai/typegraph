/**
 * A released claim row resolves `getOrCreateByConstraint` only while it still
 * points at a tombstone holding the key.
 *
 * Releasing a claim is a soft delete of the claim row, and an ordinary update
 * that changes a unique key releases the old key while its owner lives on. A
 * lookup that read every released row as "the tombstone to revive" therefore
 * handed back a LIVE node whose props no longer carry the key — as `found` —
 * and with `ifExists: "update"` rewrote that node back onto the old key. The
 * cases here pin both readings: a released row whose owner is live, or whose
 * tombstone has moved off the key, is inert; a released row whose tombstone
 * still computes the key is what a resurrect revives.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, subClassOf } from "../../../src";
import { computeUniqueKey } from "../../../src/constraints";
import { requireDefined } from "../../../src/utils/presence";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

const ACCOUNT_EMAIL_CONSTRAINT = "released_lookup_email";

const ReleasedLookupAccount = defineNode("ReleasedLookupAccount", {
  schema: z.object({ email: z.string() }),
});

const releasedLookupGraph = defineGraph({
  id: "released_claim_lookup",
  nodes: {
    ReleasedLookupAccount: {
      type: ReleasedLookupAccount,
      unique: [
        {
          name: ACCOUNT_EMAIL_CONSTRAINT,
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

/**
 * Two related kinds declaring constraints of the SAME name over different
 * fields (`owner_key`) and different collations (`owner_handle`). A released
 * claim is checked against its owner's declaration, so a lookup through the
 * parent must still read a child's claim the way the child wrote it.
 */
const OWNER_KEY_CONSTRAINT = "owner_key";
const OWNER_HANDLE_CONSTRAINT = "owner_handle";

const OwnerParent = defineNode("OwnerParent", {
  schema: z.object({ email: z.string(), handle: z.string() }),
});
const OwnerChild = defineNode("OwnerChild", {
  schema: z.object({ email: z.string(), handle: z.string() }),
});

const ownerConstraintGraph = defineGraph({
  id: "released_claim_owner_constraint",
  nodes: {
    OwnerParent: {
      type: OwnerParent,
      unique: [
        {
          name: OWNER_KEY_CONSTRAINT,
          fields: ["email"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
        {
          name: OWNER_HANDLE_CONSTRAINT,
          fields: ["handle"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
    OwnerChild: {
      type: OwnerChild,
      unique: [
        {
          name: OWNER_KEY_CONSTRAINT,
          fields: ["handle"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
        {
          name: OWNER_HANDLE_CONSTRAINT,
          fields: ["handle"],
          scope: "kindWithSubClasses",
          collation: "caseInsensitive",
        },
      ],
    },
  },
  edges: {},
  ontology: [subClassOf(OwnerChild, OwnerParent)],
});

/**
 * A child whose same-name constraint is scoped to its own kind, under a parent
 * whose declaration spans the hierarchy. `ScopeZChild` sorts after
 * `ScopeParent`, so the hierarchy axis is the parent's kind — an axis the
 * child's own scope does not claim, which is the shape a scope narrowed after
 * the claim was written leaves behind.
 */
const SCOPED_CONSTRAINT = "scoped_email";

const ScopeParent = defineNode("ScopeParent", {
  schema: z.object({ email: z.string() }),
});
const ScopeZChild = defineNode("ScopeZChild", {
  schema: z.object({ email: z.string() }),
});

const scopeChangeGraph = defineGraph({
  id: "released_claim_owner_scope",
  nodes: {
    ScopeParent: {
      type: ScopeParent,
      unique: [
        {
          name: SCOPED_CONSTRAINT,
          fields: ["email"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
    ScopeZChild: {
      type: ScopeZChild,
      unique: [
        {
          name: SCOPED_CONSTRAINT,
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
  ontology: [subClassOf(ScopeZChild, ScopeParent)],
});

type LookupOutcome = Readonly<{ action: string; id: string }>;

/** Runs one get-or-create through the parent, single or batched. */
async function parentGetOrCreate(
  store: InspectableStore<typeof ownerConstraintGraph>,
  mode: "single" | "bulk",
  constraintName: typeof OWNER_KEY_CONSTRAINT | typeof OWNER_HANDLE_CONSTRAINT,
  props: Readonly<{ email: string; handle: string }>,
): Promise<LookupOutcome> {
  const parents = store.nodes.OwnerParent;
  if (mode === "single") {
    const result = await parents.getOrCreateByConstraint(constraintName, props);
    return { action: result.action, id: result.node.id };
  }
  const [result] = await parents.bulkGetOrCreateByConstraint(constraintName, [
    { props },
  ]);
  return { action: String(result?.action), id: String(result?.node.id) };
}

const OLD_EMAIL = "old@released-lookup.example";
const NEW_EMAIL = "new@released-lookup.example";
const MOVED_ID = "released-lookup-moved";

type GetOrCreateShape = Readonly<{
  action: string;
  reusedMovedNode: boolean;
  email: string;
}>;

function outcomeShape(
  result: Readonly<{ action: string; node: { id: string; email: string } }>,
): GetOrCreateShape {
  return {
    action: result.action,
    reusedMovedNode: result.node.id === MOVED_ID,
    email: result.node.email,
  };
}

async function accountsWithKeyMovedOffOldEmail(
  context: IntegrationTestContext,
) {
  const store = await context.createStore(releasedLookupGraph);
  const accounts = store.nodes.ReleasedLookupAccount;
  const moved = await accounts.create({ email: OLD_EMAIL }, { id: MOVED_ID });
  await accounts.update(moved.id, { email: NEW_EMAIL });
  return { accounts, movedId: moved.id };
}

export function registerReleasedClaimLookupIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("getOrCreateByConstraint over a released claim row", () => {
    for (const ifExists of ["return", "update"] as const) {
      it(`creates a fresh node for a key its live owner moved off (ifExists: ${ifExists})`, async () => {
        const { accounts, movedId } =
          await accountsWithKeyMovedOffOldEmail(context);

        const result = await accounts.getOrCreateByConstraint(
          ACCOUNT_EMAIL_CONSTRAINT,
          { email: OLD_EMAIL },
          { ifExists },
        );

        expect(outcomeShape(result)).toEqual({
          action: "created",
          reusedMovedNode: false,
          email: OLD_EMAIL,
        });
        const moved = await accounts.getById(movedId);
        expect(moved?.email).toBe(NEW_EMAIL);
      });

      it(`creates a fresh node for a key its live owner moved off in the batched lookup (ifExists: ${ifExists})`, async () => {
        const { accounts, movedId } =
          await accountsWithKeyMovedOffOldEmail(context);

        const results = await accounts.bulkGetOrCreateByConstraint(
          ACCOUNT_EMAIL_CONSTRAINT,
          [{ props: { email: OLD_EMAIL } }, { props: { email: NEW_EMAIL } }],
          { ifExists },
        );

        expect(results.map((result) => outcomeShape(result))).toEqual([
          { action: "created", reusedMovedNode: false, email: OLD_EMAIL },
          {
            action: ifExists === "update" ? "updated" : "found",
            reusedMovedNode: true,
            email: NEW_EMAIL,
          },
        ]);
        const moved = await accounts.getById(movedId);
        expect(moved?.email).toBe(NEW_EMAIL);
      });
    }

    it("creates a fresh node when the tombstone moved off the key before its delete", async () => {
      const { accounts, movedId } =
        await accountsWithKeyMovedOffOldEmail(context);
      await accounts.delete(movedId);

      const single = await accounts.getOrCreateByConstraint(
        ACCOUNT_EMAIL_CONSTRAINT,
        { email: OLD_EMAIL },
      );
      expect(outcomeShape(single)).toEqual({
        action: "created",
        reusedMovedNode: false,
        email: OLD_EMAIL,
      });

      const [batched] = await accounts.bulkGetOrCreateByConstraint(
        ACCOUNT_EMAIL_CONSTRAINT,
        [{ props: { email: NEW_EMAIL } }],
      );
      expect(batched === undefined ? undefined : outcomeShape(batched)).toEqual(
        { action: "resurrected", reusedMovedNode: true, email: NEW_EMAIL },
      );
    });

    it("resurrects the tombstone that still holds the key", async () => {
      const store = await context.createStore(releasedLookupGraph);
      const accounts = store.nodes.ReleasedLookupAccount;
      const tombstone = await accounts.create(
        { email: OLD_EMAIL },
        { id: MOVED_ID },
      );
      await accounts.delete(tombstone.id);

      const single = await accounts.getOrCreateByConstraint(
        ACCOUNT_EMAIL_CONSTRAINT,
        { email: OLD_EMAIL },
      );
      expect(outcomeShape(single)).toEqual({
        action: "resurrected",
        reusedMovedNode: true,
        email: OLD_EMAIL,
      });

      await accounts.delete(tombstone.id);
      const [batched] = await accounts.bulkGetOrCreateByConstraint(
        ACCOUNT_EMAIL_CONSTRAINT,
        [{ props: { email: OLD_EMAIL } }],
      );
      expect(batched === undefined ? undefined : outcomeShape(batched)).toEqual(
        { action: "resurrected", reusedMovedNode: true, email: OLD_EMAIL },
      );
    });
  });

  describe("a released claim is read with its owner's constraint", () => {
    for (const mode of ["single", "bulk"] as const) {
      it(`ignores a child's stale claim that matches only the parent's fields (${mode})`, async () => {
        const store = await context.createStore(ownerConstraintGraph);
        const child = await store.nodes.OwnerChild.create(
          { email: "old", handle: "old" },
          { id: `stale-child-${mode}` },
        );
        await store.nodes.OwnerChild.update(child.id, { handle: "new" });

        const outcome = await parentGetOrCreate(
          store,
          mode,
          OWNER_KEY_CONSTRAINT,
          { email: "old", handle: "parent" },
        );

        expect(outcome.action).toBe("created");
        expect(outcome.id).not.toBe(child.id);
      });

      it(`revives a child tombstone that holds the key under its own fields (${mode})`, async () => {
        const store = await context.createStore(ownerConstraintGraph);
        const child = await store.nodes.OwnerChild.create(
          { email: "other", handle: "old" },
          { id: `tombstone-child-${mode}` },
        );
        await store.nodes.OwnerChild.delete(child.id);

        const outcome = await parentGetOrCreate(
          store,
          mode,
          OWNER_KEY_CONSTRAINT,
          { email: "old", handle: "parent" },
        );

        expect(outcome).toEqual({ action: "resurrected", id: child.id });
      });

      it(`revives a child tombstone that holds the key under its own collation (${mode})`, async () => {
        const store = await context.createStore(ownerConstraintGraph);
        const child = await store.nodes.OwnerChild.create(
          { email: "child", handle: "Mixed@Case" },
          { id: `collation-child-${mode}` },
        );
        await store.nodes.OwnerChild.delete(child.id);

        const outcome = await parentGetOrCreate(
          store,
          mode,
          OWNER_HANDLE_CONSTRAINT,
          { email: "parent", handle: "mixed@case" },
        );

        expect(outcome).toEqual({ action: "resurrected", id: child.id });
      });

      it(`ignores a released claim at an axis its owner's scope does not claim (${mode})`, async () => {
        const store = await context.createStore(scopeChangeGraph);
        const backend = store.backend;
        const email = `scoped-${mode}@released-lookup.example`;
        const key = computeUniqueKey({ email }, ["email"], "binary");
        const child = await store.nodes.ScopeZChild.create(
          { email },
          { id: `scoped-child-${mode}` },
        );
        await store.nodes.ScopeZChild.delete(child.id);
        // Leave the child's only claim at the hierarchy axis, released.
        await requireDefined(backend.hardDeleteUniquesByNodeIds)({
          graphId: scopeChangeGraph.id,
          concreteKind: "ScopeZChild",
          nodeIds: [child.id],
        });
        const claim = {
          graphId: scopeChangeGraph.id,
          nodeKind: "ScopeParent",
          constraintName: SCOPED_CONSTRAINT,
          key,
          nodeId: child.id,
          concreteKind: "ScopeZChild",
        };
        await backend.insertUnique(claim);
        await backend.deleteUnique(claim);

        const parents = store.nodes.ScopeParent;
        const [outcome] =
          mode === "single" ?
            [
              await parents.getOrCreateByConstraint(SCOPED_CONSTRAINT, {
                email,
              }),
            ]
          : await parents.bulkGetOrCreateByConstraint(SCOPED_CONSTRAINT, [
              { props: { email } },
            ]);

        expect(outcome?.action).toBe("created");
        expect(outcome?.node.id).not.toBe(child.id);
      });
    }
  });
}
