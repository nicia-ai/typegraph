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
  type EdgeId,
  IMMUTABLE_VALIDITY_LOWER_BOUND_CODE,
  type Node,
  type NodeId,
  type Store,
} from "../../../src";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  type ImportOptions,
} from "../../../src/interchange";
import { canonicalizeDatabaseTimestamp } from "../../../src/utils/date";
import { requireDefined } from "../../../src/utils/presence";
import { expectImmutableLowerBoundRefusal } from "../../test-utils";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

/** A bound no row under test can hold: the store stamps creation instants. */
const FOREIGN_VALID_FROM = "2000-01-01T00:00:00.000Z";
const OTHER_FOREIGN_VALID_FROM = "2001-01-01T00:00:00.000Z";
/** A past window for the resurrection cases, ordered and permanently so. */
const REVIVED_VALID_FROM = "2023-01-01T00:00:00.000Z";
const REVIVED_VALID_TO = "2024-12-31T23:59:59.999Z";

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
}
