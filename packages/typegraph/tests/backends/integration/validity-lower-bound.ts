/**
 * A stated `validFrom` is applied or refused — never accepted and ignored.
 *
 * An in-place update never rewrites a live row's `valid_from` (only a
 * resurrection does), so every write path that accepts `validFrom` refuses one
 * that names an instant the row does not already hold. These cases run on every
 * backend because the comparison reads a STORED bound as the driver rendered it:
 * a per-dialect copy would certify a divergence rather than catch it.
 */
import { describe, expect, it } from "vitest";

import {
  asEdgeId,
  asNodeId,
  createStore,
  type EdgeId,
  IMMUTABLE_VALIDITY_LOWER_BOUND_CODE,
  type Node,
  type NodeId,
  type Store,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  type ImportOptions,
} from "../../../src/interchange";
import { canonicalizeDatabaseTimestamp } from "../../../src/utils/date";
import { requireDefined } from "../../../src/utils/presence";
import {
  expectImmutableLowerBoundRefusal,
  expectInvertedWindowRefusal,
} from "../../test-utils";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

/** A bound no row under test can hold: the store stamps creation instants. */
const FOREIGN_VALID_FROM = "2000-01-01T00:00:00.000Z";
const OTHER_FOREIGN_VALID_FROM = "2001-01-01T00:00:00.000Z";
/** A past window for the resurrection cases, ordered and permanently so. */
const REVIVED_VALID_FROM = "2023-01-01T00:00:00.000Z";
const REVIVED_VALID_TO = "2024-12-31T23:59:59.999Z";
const FUTURE_VALID_TO = "2100-01-01T00:00:00.000Z";

type PersonNode = Node<typeof integrationTestGraph.nodes.Person.type>;

/** Any store over the integration graph. */
type LowerBoundTestStore = Store<typeof integrationTestGraph>;

function personId(
  id: string,
): NodeId<typeof integrationTestGraph.nodes.Person.type> {
  return asNodeId(id);
}

function knowsId(
  id: string,
): EdgeId<typeof integrationTestGraph.edges.knows.type> {
  return asEdgeId(id);
}

/** Seeds a live Person whose lower bound is the store's own creation instant. */
function seedPerson(
  store: LowerBoundTestStore,
  id: string,
): Promise<PersonNode> {
  return store.nodes.Person.upsertById(id, { name: "Win", age: 1 });
}

/**
 * Seeds a LIVE Person with NO lower bound: born already ended, which is the
 * only write shape that reaches that state without interchange. The absence is
 * asserted here rather than in each case, so a regression in the born-ended
 * contract fails the seed instead of leaving the cases below vacuously green.
 */
async function seedBornEndedPerson(
  store: LowerBoundTestStore,
  id: string,
): Promise<PersonNode> {
  const created = await store.nodes.Person.create(
    { name: "Win", age: 1 },
    { id, validTo: REVIVED_VALID_TO },
  );
  expect(created.meta.validFrom).toBeUndefined();
  return created;
}

/** An interchange document carrying exactly the rows a case is about. */
function payload(
  nodes: GraphData["nodes"],
  edges: GraphData["edges"] = [],
): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "validity lower bound" },
    nodes,
    edges,
  };
}

/**
 * Import options at a given batch size. Batched and sequential are separate
 * update legs, so every import case runs at both sizes: a check present on one
 * leg is silently absent from the other, and which leg runs is a function of
 * `batchSize` rather than of the caller's intent.
 */
function importOptions(batchSize: number): ImportOptions {
  return {
    onConflict: "update",
    onUnknownProperty: "error",
    validateReferences: true,
    batchSize,
    refreshStatistics: false,
  };
}

/** The batch sizes that select import's sequential and batched update legs. */
const IMPORT_BATCH_SIZES = [1, 100] as const;

export function registerValidityLowerBoundIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a stated validFrom is applied or refused", () => {
    /* eslint-disable unicorn/no-null -- Explicit null is the open-left write protocol under test. */
    it("creates explicit open-left nodes and edges without changing omitted defaults", async () => {
      const store = await context.createStore(integrationTestGraph);
      const alice = await store.nodes.Person.create(
        { name: "Alice", age: 1 },
        { validFrom: null },
      );
      const bob = await store.nodes.Person.upsertById(
        "open-bob",
        { name: "Bob", age: 2 },
        { validFrom: null },
      );
      const stamped = await store.nodes.Person.create({
        name: "Stamped",
        age: 3,
      });
      const edge = await store.edges.knows.create(
        alice,
        bob,
        {},
        { validFrom: null },
      );
      expect(alice.meta.validFrom).toBeUndefined();
      expect(bob.meta.validFrom).toBeUndefined();
      expect(edge.meta.validFrom).toBeUndefined();
      expect(stamped.meta.validFrom).toBeDefined();
      const ancient = {
        temporalMode: "asOf",
        asOf: FOREIGN_VALID_FROM,
      } as const;
      expect(await store.nodes.Person.getById(alice.id, ancient)).toBeDefined();
      expect(await store.edges.knows.getById(edge.id, ancient)).toBeDefined();
      expect(
        await store.nodes.Person.getById(stamped.id, ancient),
      ).toBeUndefined();
    });

    it("preserves explicit open-left windows through bulk creation and resurrection", async () => {
      const store = await context.createStore(integrationTestGraph);
      const people = await store.nodes.Person.bulkCreate([
        { id: "open-bulk-a", props: { name: "A", age: 1 }, validFrom: null },
        { id: "open-bulk-b", props: { name: "B", age: 2 }, validFrom: null },
      ]);
      const alice = requireDefined(people[0]);
      const bob = requireDefined(people[1]);
      const edges = await store.edges.knows.bulkCreate([
        {
          id: "open-bulk-edge",
          from: alice,
          to: bob,
          props: {},
          validFrom: null,
        },
      ]);
      const edge = requireDefined(edges[0]);
      expect(people.map((person) => person.meta.validFrom)).toEqual([
        undefined,
        undefined,
      ]);
      expect(edge.meta.validFrom).toBeUndefined();
      await store.edges.knows.delete(edge.id);
      const [revivedEdge] = await store.edges.knows.bulkUpsertById([
        { id: edge.id, from: alice, to: bob, props: {}, validFrom: null },
      ]);
      expect(revivedEdge?.meta.validFrom).toBeUndefined();
      await store.edges.knows.delete(edge.id);
      await store.nodes.Person.delete(bob.id);
      const revived = await store.nodes.Person.upsertById(
        bob.id,
        { name: "B", age: 2 },
        { validFrom: null },
      );
      expect(revived.meta.validFrom).toBeUndefined();
    });

    it("replaces a tombstoned edge's timestamp with an explicit open-left historical window", async () => {
      const store = await context.createStore(integrationTestGraph);
      const alice = await seedPerson(store, "open-history-a");
      const bob = await seedPerson(store, "open-history-b");
      const edge = await store.edges.knows.create(alice, bob, {});
      expect(edge.meta.validFrom).toBeDefined();
      await store.edges.knows.delete(edge.id);
      const [revived] = await store.edges.knows.bulkUpsertById([
        {
          id: edge.id,
          from: alice,
          to: bob,
          props: {},
          validFrom: null,
          validTo: REVIVED_VALID_TO,
        },
      ]);
      expect(revived?.meta.validFrom).toBeUndefined();
      expect(revived?.meta.validTo).toBe(REVIVED_VALID_TO);
    });

    for (const coalesceUnchangedUpserts of [false, true]) {
      it.each(["node", "node bulk", "edge bulk"] as const)(
        `rejects an unsupported null validTo on unchanged %s upserts with coalescing ${String(coalesceUnchangedUpserts)}`,
        async (writePath) => {
          const store = await context.createStore(integrationTestGraph, {
            coalesceUnchangedUpserts,
          });
          const alice = await seedPerson(store, "invalid-end-a");
          const bob = await seedPerson(store, "invalid-end-b");
          const edge = await store.edges.knows.create(alice, bob, {});
          const write = () => {
            switch (writePath) {
              case "node": {
                return store.nodes.Person.upsertById(
                  alice.id,
                  { name: "Win", age: 1 },
                  {
                    // @ts-expect-error JavaScript callers can pass unsupported null upper bounds.
                    validTo: null,
                  },
                );
              }
              case "node bulk": {
                return store.nodes.Person.bulkUpsertById([
                  {
                    id: alice.id,
                    props: { name: "Win", age: 1 },
                    // @ts-expect-error JavaScript callers can pass unsupported null upper bounds.
                    validTo: null,
                  },
                ]);
              }
              case "edge bulk": {
                return store.edges.knows.bulkUpsertById([
                  {
                    id: edge.id,
                    from: alice,
                    to: bob,
                    props: {},
                    // @ts-expect-error JavaScript callers can pass unsupported null upper bounds.
                    validTo: null,
                  },
                ]);
              }
            }
          };
          await expect(write()).rejects.toMatchObject({
            name: "ValidationError",
            message:
              'Invalid canonical ISO 8601 datetime for "validTo": "null". Expected fixed-width UTC: YYYY-MM-DDTHH:mm:ss.sssZ',
          });
          const storedPerson = await store.nodes.Person.getById(alice.id);
          const storedEdge = await store.edges.knows.getById(edge.id);
          expect(storedPerson?.meta).toEqual(alice.meta);
          expect(storedEdge?.meta).toEqual(edge.meta);
        },
      );
      it(`applies or refuses explicit open-left requests with coalescing ${String(coalesceUnchangedUpserts)}`, async () => {
        const store = await context.createStore(integrationTestGraph, {
          coalesceUnchangedUpserts,
        });
        const open = await store.nodes.Person.create(
          { name: "Open", age: 1 },
          { validFrom: null },
        );
        const replay = await store.nodes.Person.upsertById(
          open.id,
          { name: "Open", age: 1 },
          { validFrom: null },
        );
        expect(replay.meta.validFrom).toBeUndefined();
        expect(replay.meta.version).toBe(
          open.meta.version + (coalesceUnchangedUpserts ? 0 : 1),
        );
        const stamped = await store.nodes.Person.create({
          name: "Stamped",
          age: 2,
        });
        await expectImmutableLowerBoundRefusal(
          store.nodes.Person.upsertById(
            stamped.id,
            { name: "Stamped", age: 2 },
            { validFrom: null },
          ),
        );
        const edge = await store.edges.knows.create(open, stamped, {});
        await expectImmutableLowerBoundRefusal(
          store.edges.knows.bulkUpsertById([
            {
              id: edge.id,
              from: open,
              to: stamped,
              props: {},
              validFrom: null,
            },
          ]),
        );
        await expectImmutableLowerBoundRefusal(
          store.nodes.Person.bulkUpsertById([
            { id: "pending-stamp", props: { name: "Pending", age: 3 } },
            {
              id: "pending-stamp",
              props: { name: "Pending", age: 3 },
              validFrom: null,
            },
          ]),
        );
        expect(
          await store.nodes.Person.getById(personId("pending-stamp")),
        ).toBeUndefined();
        await expectImmutableLowerBoundRefusal(
          store.edges.knows.bulkUpsertById([
            {
              id: knowsId("pending-edge-stamp"),
              from: open,
              to: stamped,
              props: {},
            },
            {
              id: knowsId("pending-edge-stamp"),
              from: open,
              to: stamped,
              props: {},
              validFrom: null,
            },
          ]),
        );
        expect(
          await store.edges.knows.getById(knowsId("pending-edge-stamp")),
        ).toBeUndefined();
      });
    }

    /* eslint-enable unicorn/no-null */

    /**
     * Registers the refusal cases against one `coalesceUnchangedUpserts` state.
     * Both are exercised, because the refusal is a property of the WRITE path:
     * coalescing decides whether an unchanged replay writes at all, and must not
     * decide whether a bound the write cannot apply is reported.
     */
    function registerFlagCases(coalesceUnchangedUpserts: boolean): void {
      {
        it("refuses a differing validFrom on a single node upsert", async () => {
          const store = await context.createStore(integrationTestGraph, {
            coalesceUnchangedUpserts,
          });
          const id = `vlb-single-${String(coalesceUnchangedUpserts)}`;
          const seeded = await seedPerson(store, id);

          await expectImmutableLowerBoundRefusal(
            store.nodes.Person.upsertById(
              id,
              { name: "Win", age: 2 },
              { validFrom: FOREIGN_VALID_FROM },
            ),
          );

          const stored = await store.nodes.Person.getById(personId(id));
          expect(stored?.meta.version).toBe(seeded.meta.version);
          expect(stored?.age).toBe(1);
        });

        it("refuses a differing validFrom on a bulk node upsert", async () => {
          const store = await context.createStore(integrationTestGraph, {
            coalesceUnchangedUpserts,
          });
          const id = `vlb-bulk-${String(coalesceUnchangedUpserts)}`;
          const seeded = await seedPerson(store, id);

          await expectImmutableLowerBoundRefusal(
            store.nodes.Person.bulkUpsertById([
              {
                id,
                props: { name: "Win", age: 2 },
                validFrom: FOREIGN_VALID_FROM,
              },
            ]),
          );

          const stored = await store.nodes.Person.getById(personId(id));
          expect(stored?.meta.version).toBe(seeded.meta.version);
          expect(stored?.age).toBe(1);
        });

        it("preserves a live node's lower bound when the upsert opts in", async () => {
          const store = await context.createStore(integrationTestGraph, {
            coalesceUnchangedUpserts,
          });
          const id = `vlb-preserve-${String(coalesceUnchangedUpserts)}`;
          const seeded = await seedPerson(store, id);

          const updated = await store.nodes.Person.upsertById(
            id,
            { name: "Win", age: 2 },
            {
              validFrom: FOREIGN_VALID_FROM,
              validTo: FUTURE_VALID_TO,
              onImmutableLowerBound: "preserve",
            },
          );

          expect(updated.age).toBe(2);
          expect(canonicalizeDatabaseTimestamp(updated.meta.validFrom)).toBe(
            canonicalizeDatabaseTimestamp(seeded.meta.validFrom),
          );
          expect(canonicalizeDatabaseTimestamp(updated.meta.validTo)).toBe(
            FUTURE_VALID_TO,
          );
        });

        it("still validates a preserved live node lower bound", async () => {
          const store = await context.createStore(integrationTestGraph, {
            coalesceUnchangedUpserts,
          });
          const id = `vlb-preserve-invalid-${String(coalesceUnchangedUpserts)}`;
          await seedPerson(store, id);

          await expect(
            store.nodes.Person.upsertById(
              id,
              { name: "Win", age: 1 },
              {
                validFrom: "not-a-date",
                onImmutableLowerBound: "preserve",
              },
            ),
          ).rejects.toThrow(
            /Invalid canonical ISO 8601 datetime for "validFrom"/,
          );
        });

        it("refuses a differing validFrom on a bulk edge upsert", async () => {
          const store = await context.createStore(integrationTestGraph, {
            coalesceUnchangedUpserts,
          });
          const suffix = String(coalesceUnchangedUpserts);
          const [alice, bob] = await store.nodes.Person.bulkCreate([
            { props: { name: "A" }, id: `vlb-edge-a-${suffix}` },
            { props: { name: "B" }, id: `vlb-edge-b-${suffix}` },
          ]);
          const edgeId = knowsId(`vlb-edge-${suffix}`);
          await store.edges.knows.bulkUpsertById([
            {
              id: edgeId,
              from: requireDefined(alice),
              to: requireDefined(bob),
              props: { since: "first" },
            },
          ]);

          await expectImmutableLowerBoundRefusal(
            store.edges.knows.bulkUpsertById([
              {
                id: edgeId,
                from: requireDefined(alice),
                to: requireDefined(bob),
                props: { since: "second" },
                validFrom: FOREIGN_VALID_FROM,
              },
            ]),
          );

          const stored = await store.edges.knows.getById(edgeId);
          expect(stored?.since).toBe("first");
        });
      }
    }

    describe("coalescing on", () => {
      registerFlagCases(true);
    });

    describe("coalescing off", () => {
      registerFlagCases(false);
    });

    it("coalesces an unchanged preserve-mode replay with a different source bound", async () => {
      const store = await context.createStore(integrationTestGraph, {
        coalesceUnchangedUpserts: true,
      });
      const seeded = await seedPerson(store, "vlb-preserve-coalesced");

      const replayed = await store.nodes.Person.upsertById(
        "vlb-preserve-coalesced",
        { name: "Win", age: 1 },
        {
          validFrom: FOREIGN_VALID_FROM,
          onImmutableLowerBound: "preserve",
        },
      );

      expect(replayed.meta.version).toBe(seeded.meta.version);
      expect(canonicalizeDatabaseTimestamp(replayed.meta.validFrom)).toBe(
        canonicalizeDatabaseTimestamp(seeded.meta.validFrom),
      );
    });

    it("accepts a validFrom that restates the bound a live row holds", async () => {
      const store = await context.createStore(integrationTestGraph, {});
      const seeded = await seedPerson(store, "vlb-restated");
      const storedValidFrom = requireDefined(seeded.meta.validFrom);

      const updated = await store.nodes.Person.upsertById(
        "vlb-restated",
        { name: "Win", age: 2 },
        { validFrom: storedValidFrom },
      );

      expect(updated.age).toBe(2);
      expect(canonicalizeDatabaseTimestamp(updated.meta.validFrom)).toBe(
        canonicalizeDatabaseTimestamp(storedValidFrom),
      );
    });

    it("supports create-only validFrom through the record-input upsert", async () => {
      const store = await context.createStore(integrationTestGraph, {});
      const id = "vlb-record-preserve";
      const created = await store.nodes.Person.upsertByIdFromRecord(
        id,
        { name: "Win", age: 1 },
        {
          validFrom: REVIVED_VALID_FROM,
          onImmutableLowerBound: "preserve",
        },
      );
      const updated = await store.nodes.Person.upsertByIdFromRecord(
        id,
        { name: "Win", age: 2 },
        {
          validFrom: OTHER_FOREIGN_VALID_FROM,
          onImmutableLowerBound: "preserve",
        },
      );

      expect(updated.age).toBe(2);
      expect(canonicalizeDatabaseTimestamp(updated.meta.validFrom)).toBe(
        canonicalizeDatabaseTimestamp(created.meta.validFrom),
      );
    });

    it("supports create-only validFrom in a bulk node upsert", async () => {
      const store = await context.createStore(integrationTestGraph, {});
      const id = "vlb-bulk-preserve";
      const [created] = await store.nodes.Person.bulkUpsertById([
        {
          id,
          props: { name: "Win", age: 1 },
          validFrom: REVIVED_VALID_FROM,
          onImmutableLowerBound: "preserve",
        },
      ]);
      const [updated] = await store.nodes.Person.bulkUpsertById([
        {
          id,
          props: { name: "Win", age: 2 },
          validFrom: OTHER_FOREIGN_VALID_FROM,
          onImmutableLowerBound: "preserve",
        },
      ]);
      const createdNode = requireDefined(created);
      const updatedNode = requireDefined(updated);

      expect(updatedNode.age).toBe(2);
      expect(canonicalizeDatabaseTimestamp(updatedNode.meta.validFrom)).toBe(
        canonicalizeDatabaseTimestamp(createdNode.meta.validFrom),
      );
    });

    it("still applies validFrom when preserve-mode upsert resurrects a node", async () => {
      const store = await context.createStore(integrationTestGraph, {});
      const id = "vlb-preserve-revived";
      const created = await seedPerson(store, id);
      await store.nodes.Person.delete(created.id);

      const revived = await store.nodes.Person.upsertById(
        id,
        { name: "Win", age: 3 },
        {
          validFrom: REVIVED_VALID_FROM,
          validTo: REVIVED_VALID_TO,
          onImmutableLowerBound: "preserve",
        },
      );

      expect(canonicalizeDatabaseTimestamp(revived.meta.validFrom)).toBe(
        REVIVED_VALID_FROM,
      );
      expect(canonicalizeDatabaseTimestamp(revived.meta.validTo)).toBe(
        REVIVED_VALID_TO,
      );
    });

    it("still applies an explicit validFrom when the upsert RESURRECTS a node", async () => {
      // The resurrection leg rewrites the whole window, so the bound IS stored
      // and no refusal may arise on it — the escape hatch the refusal leaves
      // open (issues #406 / #420).
      const store = await context.createStore(integrationTestGraph, {});
      const created = await seedPerson(store, "vlb-revived");
      await store.nodes.Person.delete(created.id);

      const revived = await store.nodes.Person.upsertById(
        "vlb-revived",
        { name: "Win", age: 3 },
        { validFrom: REVIVED_VALID_FROM, validTo: REVIVED_VALID_TO },
      );

      expect(canonicalizeDatabaseTimestamp(revived.meta.validFrom)).toBe(
        REVIVED_VALID_FROM,
      );
      expect(canonicalizeDatabaseTimestamp(revived.meta.validTo)).toBe(
        REVIVED_VALID_TO,
      );
    });

    it("still applies an explicit validFrom when a BULK upsert resurrects a node", async () => {
      const store = await context.createStore(integrationTestGraph, {});
      const created = await seedPerson(store, "vlb-revived-bulk");
      await store.nodes.Person.delete(created.id);

      const [revived] = await store.nodes.Person.bulkUpsertById([
        {
          id: "vlb-revived-bulk",
          props: { name: "Win", age: 3 },
          validFrom: REVIVED_VALID_FROM,
          validTo: REVIVED_VALID_TO,
        },
      ]);

      expect(
        canonicalizeDatabaseTimestamp(requireDefined(revived).meta.validFrom),
      ).toBe(REVIVED_VALID_FROM);
    });

    describe("a repeated id in one batch", () => {
      // #404 routes a repeated id to the update path against the row the batch
      // just queued. The bound that update is judged against is the one the row
      // ACTUALLY holds when the update runs — creates run before updates, so it
      // is readable by then — which is what keeps this rule identical to the
      // sequential one.
      it("refuses a later copy that differs from the queued create's NAMED bound", async () => {
        const store = await context.createStore(integrationTestGraph, {
          coalesceUnchangedUpserts: true,
        });

        await expectImmutableLowerBoundRefusal(
          store.nodes.Person.bulkUpsertById([
            {
              id: "vlb-queued-named",
              props: { name: "Win", age: 1 },
              validFrom: FOREIGN_VALID_FROM,
            },
            {
              id: "vlb-queued-named",
              props: { name: "Win", age: 2 },
              validFrom: OTHER_FOREIGN_VALID_FROM,
            },
          ]),
        );

        // All or nothing: the create rolls back with the refused update.
        expect(
          await store.nodes.Person.getById(personId("vlb-queued-named")),
        ).toBeUndefined();
      });

      it("accepts a later copy that restates the queued create's NAMED bound", async () => {
        const store = await context.createStore(integrationTestGraph, {
          coalesceUnchangedUpserts: true,
        });

        const results = await store.nodes.Person.bulkUpsertById([
          {
            id: "vlb-queued-restated",
            props: { name: "Win", age: 1 },
            validFrom: FOREIGN_VALID_FROM,
          },
          {
            id: "vlb-queued-restated",
            props: { name: "Win", age: 2 },
            validFrom: FOREIGN_VALID_FROM,
          },
        ]);

        expect(requireDefined(results[1]).age).toBe(2);
        expect(
          canonicalizeDatabaseTimestamp(
            requireDefined(results[1]).meta.validFrom,
          ),
        ).toBe(FOREIGN_VALID_FROM);
      });

      it("refuses a later copy that differs from the bound the BACKEND stamped", async () => {
        // The queued create omitted `validFrom`, so the batch cannot know the
        // bound the row will hold and treats any stated one as a change — it
        // does not guess. The write it therefore performs is what reaches the
        // guard, and the guard judges against the bound the row really holds.
        // A copy naming an instant that is not that bound is refused there,
        // which is why the batch-local "unknowable" rule costs no honesty: the
        // deferral ends at a check that can see the truth. (Its companion —
        // naming the stamped instant EXACTLY, which is accepted and writes —
        // is pinned in the bulk window cases.)
        const store = await context.createStore(integrationTestGraph, {
          coalesceUnchangedUpserts: true,
        });

        await expectImmutableLowerBoundRefusal(
          store.nodes.Person.bulkUpsertById([
            { id: "vlb-queued-stamped", props: { name: "Win", age: 1 } },
            {
              id: "vlb-queued-stamped",
              props: { name: "Win", age: 2 },
              validFrom: FOREIGN_VALID_FROM,
            },
          ]),
        );

        expect(
          await store.nodes.Person.getById(personId("vlb-queued-stamped")),
        ).toBeUndefined();
      });
    });

    describe("interchange import under onConflict update", () => {
      // Import's update legs send the document's `validTo` and never its
      // `validFrom`, so a document stating a bound the target row does not hold
      // is stating one the write will ignore. It is reported PER ROW — one
      // refused row does not abort the import — which is the same shape #406 gave
      // the inverted-window refusal here.
      //
      // Both batch sizes, because batched and sequential are separate update
      // legs: a check on one leg is silently absent from the other, and which
      // leg runs is a function of `batchSize` rather than of the caller's intent.
      // On both backends, because the bound this compares against is read back as
      // the DRIVER rendered it.
      it("reports a node whose document states a bound the live row does not hold", async () => {
        for (const batchSize of IMPORT_BATCH_SIZES) {
          const store = await context.createStore(integrationTestGraph, {});
          const id = `vlb-import-${String(batchSize)}`;
          const seeded = await store.nodes.Person.upsertById(id, {
            name: "Win",
            age: 1,
          });

          const result = await importGraph(
            store,
            payload([
              {
                kind: "Person",
                id,
                properties: { name: "Changed", age: 2 },
                validFrom: FOREIGN_VALID_FROM,
              },
            ]),
            importOptions(batchSize),
          );

          expect(result.errors).toHaveLength(1);
          expect(requireDefined(result.errors[0]).id).toBe(id);
          expect(requireDefined(result.errors[0]).error).toContain(
            IMMUTABLE_VALIDITY_LOWER_BOUND_CODE,
          );
          expect(result.nodes.updated).toBe(0);

          // The refused row keeps its props AND its bound: reporting it is not a
          // partial write.
          const stored = await store.nodes.Person.getById(personId(id));
          expect(stored?.name).toBe("Win");
          expect(canonicalizeDatabaseTimestamp(stored?.meta.validFrom)).toBe(
            canonicalizeDatabaseTimestamp(seeded.meta.validFrom),
          );
        }
      });

      it("accepts a node document that restates the bound the live row holds", async () => {
        for (const batchSize of IMPORT_BATCH_SIZES) {
          const store = await context.createStore(integrationTestGraph, {});
          const id = `vlb-import-ok-${String(batchSize)}`;
          const seeded = await store.nodes.Person.upsertById(id, {
            name: "Win",
            age: 1,
          });

          const result = await importGraph(
            store,
            payload([
              {
                kind: "Person",
                id,
                properties: { name: "Changed", age: 2 },
                validFrom: canonicalizeDatabaseTimestamp(seeded.meta.validFrom),
              },
            ]),
            importOptions(batchSize),
          );

          expect(result.errors).toEqual([]);
          expect(result.nodes.updated).toBe(1);
          const updated = await store.nodes.Person.getById(personId(id));
          expect(updated?.name).toBe("Changed");
        }
      });

      it("reports an edge whose document states a bound the live edge does not hold", async () => {
        for (const batchSize of IMPORT_BATCH_SIZES) {
          const store = await context.createStore(integrationTestGraph, {});
          const suffix = String(batchSize);
          const [alice, bob] = await store.nodes.Person.bulkCreate([
            { props: { name: "A" }, id: `vlb-import-edge-a-${suffix}` },
            { props: { name: "B" }, id: `vlb-import-edge-b-${suffix}` },
          ]);
          const edgeId = `vlb-import-edge-${suffix}`;
          await store.edges.knows.bulkUpsertById([
            {
              id: knowsId(edgeId),
              from: requireDefined(alice),
              to: requireDefined(bob),
              props: { since: "first" },
            },
          ]);

          const result = await importGraph(
            store,
            payload(
              [],
              [
                {
                  kind: "knows",
                  id: edgeId,
                  from: {
                    kind: "Person",
                    id: `vlb-import-edge-a-${suffix}`,
                  },
                  to: { kind: "Person", id: `vlb-import-edge-b-${suffix}` },
                  properties: { since: "second" },
                  validFrom: FOREIGN_VALID_FROM,
                },
              ],
            ),
            importOptions(batchSize),
          );

          expect(result.errors).toHaveLength(1);
          expect(requireDefined(result.errors[0]).error).toContain(
            IMMUTABLE_VALIDITY_LOWER_BOUND_CODE,
          );
          expect(result.edges.updated).toBe(0);
          const storedEdge = await store.edges.knows.getById(knowsId(edgeId));
          expect(storedEdge?.since).toBe("first");
        }
      });
    });
  });

  /**
   * The ABSENT lower bound, which the born-ended contract made an ordinary shape
   * for a live row rather than an interchange-only curiosity. "No bound" is a
   * reading of the row like any other: a write whose verdict depends on it must
   * assert it, and a caller who states one against it is stating one the write
   * will not apply.
   */
  describe("a live row with no lower bound", () => {
    /** Where the concurrent writer puts the bound the update never read. */
    const RECREATED_VALID_FROM = REVIVED_VALID_FROM;

    it("accepts a lone validTo against the absent bound", async () => {
      // Nothing to invert against, so the end is free to move — including into
      // the future, which makes the row open-left AND current.
      const store = await context.createStore(integrationTestGraph, {});
      const id = "vlb-born-ended-accepts";
      await seedBornEndedPerson(store, id);

      const updated = await store.nodes.Person.update(
        personId(id),
        {},
        { validTo: FUTURE_VALID_TO },
      );

      expect(updated.meta.validFrom).toBeUndefined();
      expect(canonicalizeDatabaseTimestamp(updated.meta.validTo)).toBe(
        FUTURE_VALID_TO,
      );
      const current = await store.nodes.Person.getById(personId(id));
      expect(current?.meta.validFrom).toBeUndefined();
    });

    it("refuses a stated validFrom on the live row, because no bound is there to restate", async () => {
      // The row has nothing to match, so every stated bound differs from what it
      // holds. Accepting one and dropping it would be the API lying about a
      // window the caller named — the same refusal a row WITH a bound gets, on
      // the branch where the stored value is absent.
      const store = await context.createStore(integrationTestGraph, {});
      const id = "vlb-born-ended-refuses";
      await seedBornEndedPerson(store, id);

      await expectImmutableLowerBoundRefusal(
        store.nodes.Person.upsertById(
          id,
          { name: "Win", age: 2 },
          { validFrom: FOREIGN_VALID_FROM },
        ),
      );

      // `includeEnded`: the row is live but its window has closed, which is the
      // whole shape under test.
      const stored = await store.nodes.Person.getById(personId(id), {
        temporalMode: "includeEnded",
      });
      expect(stored?.age).toBe(1);
      expect(stored?.meta.validFrom).toBeUndefined();
    });

    it("fences the lone validTo on IS NULL, so a row that gained a bound between the probe and the write is not written over", async () => {
      // The verdict READ "this row has no lower bound" and accepted the end on
      // that basis, so the write must assert it. A peer that deletes and
      // resurrects the row with a real bound between the two statements changes
      // the answer, and the fenced UPDATE has to match nothing rather than
      // persist an end below a start nobody judged it against.
      //
      // Driven deterministically at the operations/backend boundary, on the
      // TRANSACTION target: the write runs against the backend
      // `runInWriteTransaction` yields, not against the outer object. The peer's
      // two statements run on that same target, so they need no second
      // connection and cannot deadlock on any driver in the matrix — and they
      // share this write's fate, so a refusal rolls them back too. That is why
      // the stored-state assertion below is "the row is untouched" rather than
      // "the peer's bound survived": what the fence has to prevent is this
      // caller's `valid_to` landing under a `valid_from` nobody judged it
      // against, and unfenced it commits exactly that.
      const backend = context.getBackend();
      const id = "vlb-born-ended-fenced";
      let interceptions = 0;

      const racingBackend = deriveBackend(backend, {
        transaction: (fn, options) =>
          backend.transaction((transactionTarget) => {
            const racingTarget = deriveBackend(transactionTarget, {
              updateNode: async (params) => {
                if (
                  params.id === id &&
                  params.clearDeleted !== true &&
                  interceptions === 0
                ) {
                  interceptions += 1;
                  await transactionTarget.deleteNode({
                    graphId: params.graphId,
                    kind: params.kind,
                    id: params.id,
                  });
                  await transactionTarget.updateNode({
                    graphId: params.graphId,
                    kind: params.kind,
                    id: params.id,
                    props: { name: "Peer", age: 9 },
                    clearDeleted: true,
                    validFrom: RECREATED_VALID_FROM,
                  });
                }
                return transactionTarget.updateNode(params);
              },
            });
            return fn(racingTarget);
          }, options),
      });

      const store = createStore(integrationTestGraph, racingBackend);
      await seedBornEndedPerson(store, id);

      // `FOREIGN_VALID_FROM` is before the bound the peer installs, so the
      // update the fence forces this caller to re-derive is one the row's real
      // window refuses. Unfenced, it would have committed `valid_to` below
      // `valid_from` — a row readable at no coordinate.
      await expectInvertedWindowRefusal(
        store.nodes.Person.update(
          personId(id),
          {},
          { validTo: FOREIGN_VALID_FROM },
        ),
      );
      expect(interceptions).toBe(1);

      const stored = await store.nodes.Person.getById(personId(id), {
        temporalMode: "includeEnded",
      });
      expect(stored?.meta.validFrom).toBeUndefined();
      expect(canonicalizeDatabaseTimestamp(stored?.meta.validTo)).toBe(
        REVIVED_VALID_TO,
      );
    });
  });
}
