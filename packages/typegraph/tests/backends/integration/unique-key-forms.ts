/**
 * A uniqueness claim is released with the key it was taken with, on every
 * backend, whichever form the props hold.
 *
 * A write keys its claim from the props it validated; a release, an update's
 * before-image and a resolved-claim lookup key from the props they read back.
 * The two forms differ for a date: a `Date` before the write, ISO text after
 * it. Keyed as they arrived, the release named a claim
 * the write never took, so the value the row moved off stayed reserved: a
 * later create of it was refused and a lookup of it answered with a node that
 * no longer holds it.
 *
 * Every case creates a row holding value A, moves it off A through one write
 * path, and then requires that A is free (a lookup finds nothing, a create
 * takes it), that the value the row moved to is still held, and that
 * `verifyConstraintFences` and `validateStore` report nothing.
 *
 * MUTATION CHECK: make `computeUniqueKey` key a date field's text raw again
 * (drop the `forms.isDateField` test) — the update, upsert, lookup, import
 * and piped cases fail on every lane, and the soft-delete cases on the lanes
 * that release per key. The hard-delete cases and the deleted-owner repair
 * pass either way (a hard delete removes every claim its node owns); they
 * guard the paths, not the key.
 *
 * The last two cases guard what the key forms must NOT change: an object's
 * key bytes (an object `.default()` is written in its literal's order, and
 * claims already stored hold those bytes), and a kind with a recursive
 * property, whose typing must not be walked to key an unrelated field.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  type NodeId,
  UniquenessError,
} from "../../../src";
import { FORMAT_VERSION, importGraph } from "../../../src/interchange";
import { type IntegrationTestContext } from "./test-context";

const UkfEvent = defineNode("UkfEvent", {
  schema: z.object({ name: z.string(), at: z.date() }),
});

/** A date reached through a pipe: its input is text, its output a `Date`. */
const UkfPipedEvent = defineNode("UkfPipedEvent", {
  schema: z.object({
    name: z.string(),
    at: z.string().pipe(z.coerce.date()),
  }),
});

/** An object default whose literal order (`at`, `zone`) is not its shape's. */
const UkfSlot = defineNode("UkfSlot", {
  schema: z.object({
    name: z.string(),
    slot: z
      .object({ zone: z.string(), at: z.string() })
      .default({ at: "morning", zone: "north" }),
  }),
});

type UkfTreeValue = Readonly<{ label: string; children: UkfTreeValue[] }>;
const UkfTreeSchema: z.ZodType<UkfTreeValue> = z.object({
  label: z.string(),
  get children() {
    return z.array(UkfTreeSchema);
  },
});

/** A kind with a recursive property beside the constrained one. */
const UkfTree = defineNode("UkfTree", {
  schema: z.object({ name: z.string(), tree: UkfTreeSchema.optional() }),
});

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      UkfEvent: {
        type: UkfEvent,
        unique: [
          {
            name: "ukf_event_at",
            fields: ["at"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      UkfPipedEvent: {
        type: UkfPipedEvent,
        unique: [
          {
            name: "ukf_piped_at",
            fields: ["at"],
            scope: "kind",
            collation: "caseInsensitive",
          },
        ],
      },
      UkfSlot: {
        type: UkfSlot,
        unique: [
          {
            name: "ukf_slot",
            fields: ["slot"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      UkfTree: {
        type: UkfTree,
        unique: [
          {
            name: "ukf_tree_name",
            fields: ["name"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
    },
    edges: {},
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `unique_key_forms_${graphIdCounter}`;
}

const A = new Date("2024-01-01T00:00:00.000Z");
const B = new Date("2024-02-01T00:00:00.000Z");
const C = new Date("2024-03-01T00:00:00.000Z");

async function createGraphStore(context: IntegrationTestContext) {
  const graphId = nextGraphId();
  const store = await context.createStore(buildGraph(graphId));
  return { graphId, store };
}

type EventStore = Awaited<ReturnType<typeof createGraphStore>>["store"];
type EventId = NodeId<typeof UkfEvent>;

/** Requires that `value` is free for a new `UkfEvent`, and leaves it taken. */
async function expectEventValueFree(
  store: EventStore,
  value: Date,
): Promise<void> {
  expect(
    await store.nodes.UkfEvent.findByConstraint("ukf_event_at", {
      name: "probe",
      at: value,
    }),
  ).toBeUndefined();
  const taken = await store.nodes.UkfEvent.create({ name: "taker", at: value });
  expect(taken.at).toBe(value.toISOString());
}

async function expectEventValueHeld(
  store: EventStore,
  value: Date,
  holder: string,
): Promise<void> {
  const found = await store.nodes.UkfEvent.findByConstraint("ukf_event_at", {
    name: "probe",
    at: value,
  });
  expect(found?.id).toBe(holder);
  await expect(
    store.nodes.UkfEvent.create({ name: "intruder", at: value }),
  ).rejects.toBeInstanceOf(UniquenessError);
}

async function expectNoViolations(store: EventStore): Promise<void> {
  expect(await store.verifyConstraintFences()).toEqual([]);
  for (const kind of [
    "UkfEvent",
    "UkfPipedEvent",
    "UkfSlot",
    "UkfTree",
  ] as const) {
    const page = await store.validateStore({ entity: "node", kind });
    expect(page.violations).toEqual([]);
  }
}

/** A write path that moves the row `id` from A to B. */
type MovePath = Readonly<{
  name: string;
  move: (store: EventStore, id: EventId) => Promise<void>;
}>;

const MOVE_PATHS: readonly MovePath[] = [
  {
    name: "update",
    move: async (store, id) => {
      await store.nodes.UkfEvent.update(id, { at: B });
    },
  },
  {
    name: "upsertById",
    move: async (store, id) => {
      await store.nodes.UkfEvent.upsertById(id, { name: "row", at: B });
    },
  },
  {
    name: "bulkUpsertById",
    move: async (store, id) => {
      await store.nodes.UkfEvent.bulkUpsertById([
        { id, props: { name: "row", at: B } },
      ]);
    },
  },
  {
    name: "bulkReplaceById",
    move: async (store, id) => {
      await store.nodes.UkfEvent.bulkReplaceById([
        { id, props: { name: "row", at: B } },
      ]);
    },
  },
  {
    name: "update inside a transaction",
    move: async (store, id) => {
      await store.transaction(async (tx) => {
        await tx.nodes.UkfEvent.update(id, { at: B });
      });
    },
  },
  {
    name: "update after a set update rewrote the row",
    move: async (store, id) => {
      await store.nodes.UkfEvent.updateWhere({
        patch: { name: "renamed" },
        where: (event) => event.name.eq("row"),
      });
      await store.nodes.UkfEvent.update(id, { at: B });
    },
  },
];

/** A write path that removes the row `id`. */
type RemovePath = Readonly<{
  name: string;
  remove: (store: EventStore, id: EventId) => Promise<void>;
}>;

const REMOVE_PATHS: readonly RemovePath[] = [
  {
    name: "delete",
    remove: (store, id) => store.nodes.UkfEvent.delete(id),
  },
  {
    name: "bulkDelete",
    remove: (store, id) => store.nodes.UkfEvent.bulkDelete([id]),
  },
  {
    name: "hardDelete",
    remove: (store, id) => store.nodes.UkfEvent.hardDelete(id),
  },
  {
    name: "bulkHardDelete",
    remove: (store, id) => store.nodes.UkfEvent.bulkHardDelete([id]),
  },
  {
    name: "delete inside a transaction",
    remove: (store, id) =>
      store.transaction(async (tx) => {
        await tx.nodes.UkfEvent.delete(id);
      }),
  },
];

export function registerUniqueKeyFormIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a uniqueness claim is released with the key it was taken with", () => {
    for (const path of MOVE_PATHS) {
      it(`${path.name}: a date the row moved off is free again`, async () => {
        const { store } = await createGraphStore(context);
        const row = await store.nodes.UkfEvent.create(
          { name: "row", at: A },
          { id: "row" },
        );

        await path.move(store, row.id);

        await expectEventValueFree(store, A);
        await expectEventValueHeld(store, B, "row");
        await expectNoViolations(store);
      });
    }

    for (const path of REMOVE_PATHS) {
      it(`${path.name}: a removed row's date is free again`, async () => {
        const { store } = await createGraphStore(context);
        const row = await store.nodes.UkfEvent.create(
          { name: "row", at: A },
          { id: "row" },
        );

        await path.remove(store, row.id);

        await expectEventValueFree(store, A);
        await expectNoViolations(store);
      });
    }

    it("getOrCreateByConstraint creates on a date the row moved off instead of returning that row", async () => {
      const { store } = await createGraphStore(context);
      await store.nodes.UkfEvent.create({ name: "row", at: A }, { id: "row" });
      await store.nodes.UkfEvent.update("row" as EventId, { at: B });

      const result = await store.nodes.UkfEvent.getOrCreateByConstraint(
        "ukf_event_at",
        { name: "taker", at: A },
      );
      expect(result.action).toBe("created");
      expect(result.node.id).not.toBe("row");
      await expectNoViolations(store);
    });

    // The repair the upgrade notes describe for a claim an earlier release
    // left behind: the leaked row is planted exactly as that release left it
    // (the owner's own live claim on a value the owner no longer holds).
    it("a claim leaked before the fix is freed by moving its live owner back onto the value and off it", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.UkfEvent.create({ name: "row", at: B }, { id: "row" });
      await store.backend.insertUnique({
        graphId,
        nodeKind: "UkfEvent",
        constraintName: "ukf_event_at",
        key: JSON.stringify(A),
        nodeId: "row",
        concreteKind: "UkfEvent",
      });
      await expect(
        store.nodes.UkfEvent.create({ name: "taker", at: A }),
      ).rejects.toMatchObject({ details: { existingId: "row" } });

      await store.nodes.UkfEvent.update("row" as EventId, { at: A });
      await store.nodes.UkfEvent.update("row" as EventId, { at: B });

      await expectEventValueFree(store, A);
      await expectEventValueHeld(store, B, "row");
    });

    it("a claim leaked before the fix by a deleted owner is freed by hard-deleting that owner", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.UkfEvent.create({ name: "row", at: B }, { id: "row" });
      await store.nodes.UkfEvent.delete("row" as EventId);
      await store.backend.insertUnique({
        graphId,
        nodeKind: "UkfEvent",
        constraintName: "ukf_event_at",
        key: JSON.stringify(A),
        nodeId: "row",
        concreteKind: "UkfEvent",
      });

      await store.nodes.UkfEvent.hardDelete("row" as EventId);

      await expectEventValueFree(store, A);
    });

    it("an update that does not touch the date keeps its claim, and a later move releases it", async () => {
      const { store } = await createGraphStore(context);
      await store.nodes.UkfEvent.create({ name: "row", at: A }, { id: "row" });

      await store.nodes.UkfEvent.update("row" as EventId, { name: "renamed" });
      await expectEventValueHeld(store, A, "row");

      await store.nodes.UkfEvent.update("row" as EventId, { at: C });
      await expectEventValueFree(store, A);
      await expectEventValueHeld(store, C, "row");
    });

    it("a resurrected row reclaims its date, and its next delete releases it", async () => {
      const { store } = await createGraphStore(context);
      await store.nodes.UkfEvent.create({ name: "row", at: A }, { id: "row" });
      await store.nodes.UkfEvent.delete("row" as EventId);

      await store.nodes.UkfEvent.upsertById("row", { name: "row", at: A });
      await expectEventValueHeld(store, A, "row");

      await store.nodes.UkfEvent.delete("row" as EventId);
      await expectEventValueFree(store, A);
    });

    it("importGraph onConflict update releases the date a row moves off", async () => {
      const { store } = await createGraphStore(context);
      // Through the piped kind: its input is the ISO text an import carries.
      const document = (at: Date) => ({
        formatVersion: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        source: { type: "external" as const, description: "unique key forms" },
        nodes: [
          {
            kind: "UkfPipedEvent",
            id: "row",
            properties: { name: "row", at: at.toISOString() },
          },
        ],
        edges: [],
      });
      const options = {
        onConflict: "update",
        onUnknownProperty: "error",
        validateReferences: true,
      } as const;
      const first = await importGraph(store, document(A), options);
      expect(first.success).toBe(true);
      const second = await importGraph(store, document(B), options);
      expect(second.success).toBe(true);

      const taken = await store.nodes.UkfPipedEvent.create({
        name: "taker",
        at: A.toISOString(),
      });
      expect(taken.id).not.toBe("row");
      await expect(
        store.nodes.UkfPipedEvent.create({
          name: "intruder",
          at: B.toISOString(),
        }),
      ).rejects.toBeInstanceOf(UniquenessError);
      await expectNoViolations(store);
    });

    it("a piped date under a case-insensitive collation is released by update and delete", async () => {
      const { store } = await createGraphStore(context);
      const row = await store.nodes.UkfPipedEvent.create({
        name: "row",
        at: A.toISOString(),
      });
      await store.nodes.UkfPipedEvent.update(row.id, { at: B.toISOString() });
      const taker = await store.nodes.UkfPipedEvent.create({
        name: "taker",
        at: A.toISOString(),
      });

      await store.nodes.UkfPipedEvent.delete(row.id);
      const second = await store.nodes.UkfPipedEvent.create({
        name: "second",
        at: B.toISOString(),
      });
      expect(second.id).not.toBe(taker.id);
      await expectNoViolations(store);
    });

    it("an object default keeps the key bytes it has always been claimed under", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.UkfSlot.create({ name: "first" }, { id: "first" });

      const claim = await store.backend.checkUnique({
        graphId,
        nodeKind: "UkfSlot",
        constraintName: "ukf_slot",
        key: JSON.stringify({ at: "morning", zone: "north" }),
      });
      expect(claim?.node_id).toBe("first");
      await expect(
        store.nodes.UkfSlot.create({ name: "second" }),
      ).rejects.toBeInstanceOf(UniquenessError);
    });

    it("a kind with a recursive property keys its constrained field", async () => {
      const { store } = await createGraphStore(context);
      await store.nodes.UkfTree.create({
        name: "root",
        tree: { label: "a", children: [{ label: "b", children: [] }] },
      });
      await expect(
        store.nodes.UkfTree.create({ name: "root" }),
      ).rejects.toBeInstanceOf(UniquenessError);
    });
  });
}
