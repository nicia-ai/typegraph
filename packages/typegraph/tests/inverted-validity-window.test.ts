/**
 * The write layer's refusal of INVERTED valid-time windows (issue #398).
 *
 * A window of negative width — `validTo` strictly before the row's effective
 * `validFrom` — describes a row that stopped being true before it started. No
 * `asOf` coordinate can observe it, and no later write repairs it, so accepting
 * one is silent data loss dressed as a successful write. These cases pin where
 * the refusal applies and, just as load-bearing, where it deliberately does not:
 *
 *   1. a stated PAIR must be ordered, on every node and edge write path;
 *   2. an in-place UPDATE's lone `validTo` must not precede the row's stored
 *      `valid_from` — the hole the edge path used to have;
 *   3. ZERO width stays legal, on creates and on updates;
 *   4. "born already ended" — a create carrying a lone historical `validTo` —
 *      stays legal, and stores NO lower bound (issue #407): the row states where
 *      it ended, not where it began, so nothing is stamped after its own end and
 *      it reads back at every `asOf` coordinate before that end. This holds on a
 *      fresh id and on one naming a tombstone, which take different write paths;
 *   5. resurrecting an edge into the ended state stays legal, but the end it
 *      names is held to the bound the row RETAINS across resurrection;
 *   6. import refuses an inverted document per row, carrying the stable code;
 *   7. a node resurrection — which RESETS `valid_from` and so has no stored
 *      bound to measure against — stores the very instant its guard measured
 *      against, instead of a later one the guard never saw.
 *
 * Trusted import carries the same refusal through its own typed stream error;
 * those cases live with the rest of its stream-shape suite in
 * `trusted-import.test.ts`.
 *
 * Every refusal carries {@link INVERTED_VALIDITY_WINDOW_CODE} on its issue, so
 * callers branch on the code rather than on prose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { GraphBackend } from "../src";
import {
  asEdgeId,
  asNodeId,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  INVERTED_VALIDITY_WINDOW_CODE,
  ValidationError,
} from "../src";
import type { GraphData } from "../src/interchange";
import {
  exportGraph,
  FORMAT_VERSION,
  importGraph,
  ImportOptionsSchema,
} from "../src/interchange";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
  from: [Person],
  to: [Company],
});
/** One LIVE job per person, so a resurrect counts against cardinality. */
const oneActiveJob = defineEdge("oneActiveJob", {
  schema: z.object({ role: z.string() }),
  from: [Person],
  to: [Company],
});

const graph = defineGraph({
  id: "inverted-window",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
    oneActiveJob: {
      type: oneActiveJob,
      from: [Person],
      to: [Company],
      cardinality: "oneActive",
    },
  },
});

/**
 * Fixed instants, ordered. Windows are stated explicitly rather than left to the
 * write clock so a case means the same thing on every future test run — the
 * `find-or-create` resurrect case aged into producing an inverted window by
 * hardcoding a date that the wall clock eventually passed.
 */
const EARLIER = "2020-01-01T00:00:00.000Z";
const START = "2021-01-01T00:00:00.000Z";
const LATER = "2022-01-01T00:00:00.000Z";

/**
 * A two-node export whose `person-1` row carries `window` — which REPLACES both
 * endpoints, so passing `validFrom: undefined` states the born-ended shape
 * rather than inheriting the exported creation instant.
 *
 * Every OTHER row is stripped of its exported `validFrom`. An exported bound
 * names the SOURCE store's creation instant, and importing it over a target row
 * created separately states a lower bound the update cannot apply — refused with
 * `IMMUTABLE_VALIDITY_LOWER_BOUND_CODE`. These fixtures isolate the
 * inverted-window refusal, so the rows they are not about must not raise a
 * second, unrelated one.
 */
async function documentWithWindow(
  window: Readonly<{
    validFrom: string | undefined;
    validTo: string | undefined;
  }>,
): Promise<GraphData> {
  const source = createStore(graph, createTestBackend());
  await source.nodes.Person.create({ name: "Alice" }, { id: "person-1" });
  await source.nodes.Person.create({ name: "Bob" }, { id: "person-2" });
  const exported = await exportGraph(source, { includeTemporal: true });
  return {
    ...exported,
    nodes: exported.nodes.map((node) =>
      node.id === "person-1" ?
        { ...node, ...window }
      : { ...node, validFrom: undefined },
    ),
  };
}

/**
 * Asserts a rejection is the inverted-window refusal, identified by its stable
 * issue code rather than by message text.
 */
async function expectInvertedWindowRefusal(
  operation: Promise<unknown>,
): Promise<void> {
  await expect(operation).rejects.toThrow(ValidationError);
  const error = await operation.catch((error_: unknown) => error_);
  expect(
    (error as ValidationError).details.issues.map((issue) => issue.code),
  ).toContain(INVERTED_VALIDITY_WINDOW_CODE);
}

/**
 * THE canonical statement of the born-ended contract (issue #407).
 *
 * A create naming only a `validTo` at or before its own write instant states
 * "this ended at T"; it does not state where it started. Stamping the write
 * instant as `valid_from` would answer a question nobody asked, and answer it
 * with a window no `asOf` coordinate can observe — a successful write that
 * stores an unreadable row. So no bound is stored at all, and the row means
 * what it says: ended at T, start unknown.
 *
 * The assertion is the STORED shape and the READ, not just the accepted
 * call: `meta.validTo` alone passed before the fix and after it.
 */
async function assertBornEndedNodeShape(
  backend: GraphBackend,
  store: ReturnType<typeof createStore<typeof graph>>,
  id: string,
): Promise<void> {
  const raw = requireDefined(await backend.getNode(graph.id, "Person", id));
  expect(raw.valid_from).toBeUndefined();
  expect(raw.valid_to).toBe(START);

  // Readable at every coordinate before its end, at none from its end on —
  // the upper bound is half-open, so the end instant itself is outside.
  const nodeId = asNodeId<typeof Person>(id);
  await expect(
    store.nodes.Person.getById(nodeId, {
      temporalMode: "asOf",
      asOf: EARLIER,
    }),
  ).resolves.toBeDefined();
  for (const at of [START, LATER]) {
    await expect(
      store.nodes.Person.getById(nodeId, {
        temporalMode: "asOf",
        asOf: at,
      }),
    ).resolves.toBeUndefined();
  }
}

describe("inverted valid-time windows", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  describe("a stated pair must be ordered", () => {
    it("refuses an inverted window on node create", async () => {
      const store = createStore(graph, backend);

      await expectInvertedWindowRefusal(
        store.nodes.Person.create(
          { name: "Alice" },
          { validFrom: LATER, validTo: START },
        ),
      );
    });

    it("refuses an inverted window on edge create", async () => {
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      await expectInvertedWindowRefusal(
        store.edges.worksAt.create(
          alice,
          acme,
          { role: "Engineer" },
          { validFrom: LATER, validTo: START },
        ),
      );
    });

    it("refuses an inverted window on node upsertById", async () => {
      const store = createStore(graph, backend);
      await store.nodes.Person.create({ name: "Alice" }, { id: "person-1" });

      await expectInvertedWindowRefusal(
        store.nodes.Person.upsertByIdFromRecord(
          "person-1",
          { name: "Alice II" },
          { validFrom: LATER, validTo: START },
        ),
      );
    });

    it("refuses an inverted window on edge bulkUpsertById", async () => {
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });

      await expectInvertedWindowRefusal(
        store.edges.worksAt.bulkUpsertById([
          {
            id: edge.id,
            from: alice,
            to: acme,
            props: { role: "Manager" },
            validFrom: LATER,
            validTo: START,
          },
        ]),
      );
    });

    it("refuses an inverted window on getOrCreateByEndpoints even when the edge already exists", async () => {
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      // The edge already exists, so this call resolves to the no-write "found"
      // leg. The window is still judged: whether a call is valid must not depend
      // on whether its endpoint identity happens to exist yet.
      await store.edges.worksAt.create(alice, acme, { role: "Engineer" });

      await expectInvertedWindowRefusal(
        store.edges.worksAt.getOrCreateByEndpoints(
          alice,
          acme,
          { role: "Engineer" },
          { validFrom: LATER, validTo: START },
        ),
      );
    });

    it("refuses an inverted window on bulkGetOrCreateByEndpoints", async () => {
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      await expectInvertedWindowRefusal(
        store.edges.worksAt.bulkGetOrCreateByEndpoints([
          { from: alice, to: acme, props: { role: "Engineer" } },
          {
            from: alice,
            to: acme,
            props: { role: "Manager" },
            validFrom: LATER,
            validTo: START,
          },
        ]),
      );
    });
  });

  describe("an update's lone validTo must not precede the stored start", () => {
    it("refuses an end before the stored validFrom on a node", async () => {
      const store = createStore(graph, backend);
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { validFrom: START },
      );

      await expectInvertedWindowRefusal(
        store.nodes.Person.update(person.id, {}, { validTo: EARLIER }),
      );
    });

    it("refuses an end before the stored validFrom on an edge", async () => {
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: START },
      );

      await expectInvertedWindowRefusal(
        store.edges.worksAt.update(edge.id, {}, { validTo: EARLIER }),
      );
    });

    it("leaves the stored window untouched when the update is refused", async () => {
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: START },
      );

      await expectInvertedWindowRefusal(
        store.edges.worksAt.update(
          edge.id,
          { role: "Manager" },
          {
            validTo: EARLIER,
          },
        ),
      );

      // The refusal precedes the write, so neither the window nor the props of
      // the same statement landed.
      const stored = requireDefined(await store.edges.worksAt.getById(edge.id));
      expect(stored.meta.validFrom).toBe(START);
      expect(stored.meta.validTo).toBeUndefined();
      expect(stored.role).toBe("Engineer");
    });
  });

  describe("zero width stays legal", () => {
    it("accepts validTo === validFrom on node and edge create", async () => {
      const store = createStore(graph, backend);
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { validFrom: START, validTo: START },
      );
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(
        person,
        acme,
        { role: "Engineer" },
        { validFrom: START, validTo: START },
      );

      expect(person.meta.validFrom).toBe(START);
      expect(person.meta.validTo).toBe(START);
      expect(edge.meta.validFrom).toBe(START);
      expect(edge.meta.validTo).toBe(START);
    });

    it("accepts an end exactly at the stored validFrom on update", async () => {
      const store = createStore(graph, backend);
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { validFrom: START },
      );
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(
        person,
        acme,
        { role: "Engineer" },
        { validFrom: START },
      );

      const endedNode = await store.nodes.Person.update(
        person.id,
        {},
        { validTo: START },
      );
      const endedEdge = await store.edges.worksAt.update(
        edge.id,
        {},
        { validTo: START },
      );

      expect(endedNode.meta.validTo).toBe(START);
      expect(endedEdge.meta.validTo).toBe(START);
    });
  });

  describe("born already ended stays legal", () => {
    it("stores no lower bound for a lone historical validTo on node and edge create", async () => {
      const store = createStore(graph, backend);
      const person = await store.nodes.Person.create(
        { name: "Former" },
        { id: "born-ended-fresh", validTo: START },
      );
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(
        person,
        acme,
        { role: "Former Employee" },
        { validTo: START },
      );

      expect(person.meta.validTo).toBe(START);
      expect(person.meta.validFrom).toBeUndefined();
      expect(edge.meta.validTo).toBe(START);
      expect(edge.meta.validFrom).toBeUndefined();

      await assertBornEndedNodeShape(backend, store, "born-ended-fresh");

      // Edges take the same route through the same insert builders, so the same
      // shape has to reach the edges relation — asserted on the row, not
      // inferred from the node's.
      const rawEdge = requireDefined(await backend.getEdge(graph.id, edge.id));
      expect(rawEdge.valid_from).toBeUndefined();
      expect(rawEdge.valid_to).toBe(START);
      const beforeEnd = await store.edges.worksAt.getById(edge.id, {
        temporalMode: "asOf",
        asOf: EARLIER,
      });
      expect(beforeEnd?.id).toBe(edge.id);
    });

    it("stores the same shape when the create lands on a tombstoned id", async () => {
      // A create whose id names an existing tombstone RESURRECTS it, reaching
      // `buildUpdateNode`'s window-reset leg instead of an insert builder — a
      // second write path for one user-visible operation. It stamps its bound
      // through the same owner, so one stated window has one outcome whichever
      // path it takes (invariant I12's create legs).
      const store = createStore(graph, backend);
      const person = await store.nodes.Person.create(
        { name: "First" },
        { id: "born-ended-tombstone" },
      );
      await store.nodes.Person.delete(person.id);

      const revived = await store.nodes.Person.create(
        { name: "Former" },
        { id: "born-ended-tombstone", validTo: START },
      );

      expect(revived.meta.validTo).toBe(START);
      expect(revived.meta.validFrom).toBeUndefined();
      await assertBornEndedNodeShape(backend, store, "born-ended-tombstone");
    });

    it("accepts resurrecting an edge straight into the ended state", async () => {
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const bigCo = await store.nodes.Company.create({ name: "BigCo" });

      // An ended employment, revived by endpoint identity with only its end
      // stated. An edge RETAINS its stored lower bound across resurrection, so
      // the lone validTo lands the row in the inactive state with its original
      // start intact — `getOrCreateByEndpoints` counts it against cardinality as
      // inactive. The end still has to sit at or after that start; see the case
      // below.
      const ended = await store.edges.oneActiveJob.create(
        alice,
        acme,
        { role: "Intern" },
        { validFrom: START },
      );
      await store.edges.oneActiveJob.delete(ended.id);
      await store.edges.oneActiveJob.create(alice, bigCo, { role: "Engineer" });

      const revived = await store.edges.oneActiveJob.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Intern" },
        { validTo: LATER },
      );

      expect(revived.action).toBe("resurrected");
      expect(revived.edge.id).toBe(ended.id);
      expect(revived.edge.meta.validFrom).toBe(START);
      expect(revived.edge.meta.validTo).toBe(LATER);
    });
  });

  describe("a resurrection is held to the bound it retains", () => {
    it("refuses a resurrecting upsertById whose lone validTo precedes the stored start", async () => {
      // An edge resurrection retains `valid_from`, so a lone earlier `validTo`
      // is measured against it exactly as an in-place update's is. `upsertById`
      // carries no resurrect-as-ended semantics of its own, so there is nothing
      // here to exempt.
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: LATER },
      );
      await store.edges.worksAt.delete(edge.id);

      await expectInvertedWindowRefusal(
        store.edges.worksAt.bulkUpsertById([
          {
            id: edge.id,
            from: alice,
            to: acme,
            props: { role: "Revived" },
            validTo: START,
          },
        ]),
      );
    });

    it("refuses a resurrecting getOrCreateByEndpoints whose lone validTo precedes the stored start", async () => {
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: LATER },
      );
      await store.edges.worksAt.delete(edge.id);

      await expectInvertedWindowRefusal(
        store.edges.worksAt.getOrCreateByEndpoints(
          alice,
          acme,
          { role: "Engineer" },
          { validTo: START },
        ),
      );

      // Refused before the write: the tombstone is untouched, so no inverted row
      // was persisted and then hidden behind `deleted_at`.
      const raw = requireDefined(await backend.getEdge(graph.id, edge.id));
      expect(raw.valid_to).toBeUndefined();
      expect(raw.deleted_at).toBeDefined();
    });

    it("accepts a resurrection that restates the whole historical window", async () => {
      // The sanctioned way to revive a row into a window that closed before the
      // row originally began: name both endpoints, and the resurrection rewrites
      // them together.
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: LATER },
      );
      await store.edges.worksAt.delete(edge.id);

      const revived = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: EARLIER, validTo: START },
      );

      expect(revived.action).toBe("resurrected");
      expect(revived.edge.meta.validFrom).toBe(EARLIER);
      expect(revived.edge.meta.validTo).toBe(START);
    });

    it("accepts a bulk resurrection that restates the whole historical window", async () => {
      // The bulk companion. Both resurrect legs must FORWARD a stated
      // `validFrom` — dropping it silently ignored the caller's lower bound and
      // left the guard unsatisfiable, since the retained bound was the only one
      // the write could be measured against.
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: LATER },
      );
      await store.edges.worksAt.delete(edge.id);

      const [revived] = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
        {
          from: alice,
          to: acme,
          props: { role: "Engineer" },
          validFrom: EARLIER,
          validTo: START,
        },
      ]);

      expect(requireDefined(revived).action).toBe("resurrected");
      expect(requireDefined(revived).edge.id).toBe(edge.id);
      expect(requireDefined(revived).edge.meta.validFrom).toBe(EARLIER);
      expect(requireDefined(revived).edge.meta.validTo).toBe(START);
    });
  });

  describe("import", () => {
    it("refuses an inverted node window per row, carrying the stable code", async () => {
      const document = await documentWithWindow({
        validFrom: LATER,
        validTo: START,
      });
      const target = createStore(graph, backend);

      const result = await importGraph(
        target,
        document,
        ImportOptionsSchema.parse({ onConflict: "skip" }),
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(requireDefined(result.errors[0]).id).toBe("person-1");
      expect(requireDefined(result.errors[0]).error).toContain(
        INVERTED_VALIDITY_WINDOW_CODE,
      );
      // One bad row does not abort the import: the sound row still lands.
      expect(result.nodes.created).toBe(1);
      expect(
        await target.nodes.Person.getById(asNodeId<typeof Person>("person-2")),
      ).toBeDefined();
      expect(
        await target.nodes.Person.getById(asNodeId<typeof Person>("person-1")),
      ).toBeUndefined();
    });

    it("refuses an end before the existing row's start under onConflict update", async () => {
      // `onConflict: "update"` sends the document's validTo to an IN-PLACE
      // update of a live row whose stored validFrom stays put, so the document
      // is held to that bound exactly as a direct `update` call would be. The
      // insert-shaped pair check cannot see this: the document states no
      // validFrom at all.
      const target = createStore(graph, backend);
      await target.nodes.Person.create(
        { name: "Alice" },
        { id: "person-1", validFrom: LATER },
      );
      await target.nodes.Person.create({ name: "Bob" }, { id: "person-2" });

      const result = await importGraph(
        target,
        await documentWithWindow({ validFrom: undefined, validTo: START }),
        ImportOptionsSchema.parse({ onConflict: "update" }),
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(requireDefined(result.errors[0]).id).toBe("person-1");
      expect(requireDefined(result.errors[0]).error).toContain(
        INVERTED_VALIDITY_WINDOW_CODE,
      );

      // The refused row keeps its window and its props.
      const stored = requireDefined(
        await target.nodes.Person.getById(asNodeId<typeof Person>("person-1")),
      );
      expect(stored.meta.validFrom).toBe(LATER);
      expect(stored.meta.validTo).toBeUndefined();
      expect(stored.name).toBe("Alice");
    });

    it("refuses on the duplicate-id leg as well as the batched one", async () => {
      // A repeated id is deferred past the batch flush and re-run through the
      // sequential row path, which is a second update leg with its own copy of
      // the check. Both occurrences must refuse, or the guard covers only the
      // leg the batch size happened to pick.
      const target = createStore(graph, backend);
      await target.nodes.Person.create(
        { name: "Alice" },
        { id: "person-1", validFrom: LATER },
      );
      await target.nodes.Person.create({ name: "Bob" }, { id: "person-2" });

      const document = await documentWithWindow({
        validFrom: undefined,
        validTo: START,
      });
      const withDuplicate: GraphData = {
        ...document,
        nodes: [
          ...document.nodes,
          requireDefined(document.nodes.find((node) => node.id === "person-1")),
        ],
      };

      const result = await importGraph(
        target,
        withDuplicate,
        ImportOptionsSchema.parse({ onConflict: "update" }),
      );

      expect(result.errors).toHaveLength(2);
      for (const error of result.errors) {
        expect(error.id).toBe("person-1");
        expect(error.error).toContain(INVERTED_VALIDITY_WINDOW_CODE);
      }
    });

    it("refuses an edge end before the existing edge's start under onConflict update", async () => {
      const target = createStore(graph, backend);
      const alice = await target.nodes.Person.create(
        { name: "Alice" },
        { id: "person-1" },
      );
      const acme = await target.nodes.Company.create(
        { name: "Acme" },
        { id: "company-1" },
      );
      await target.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { id: "edge-1", validFrom: LATER },
      );

      const result = await importGraph(
        target,
        {
          formatVersion: FORMAT_VERSION,
          exportedAt: START,
          source: { type: "external", description: "inverted window test" },
          nodes: [],
          edges: [
            {
              kind: "worksAt",
              id: "edge-1",
              from: { kind: "Person", id: "person-1" },
              to: { kind: "Company", id: "company-1" },
              properties: { role: "Manager" },
              validTo: START,
            },
          ],
        },
        ImportOptionsSchema.parse({ onConflict: "update" }),
      );

      expect(result.errors).toHaveLength(1);
      expect(requireDefined(result.errors[0]).error).toContain(
        INVERTED_VALIDITY_WINDOW_CODE,
      );

      const stored = requireDefined(
        await target.edges.worksAt.getById(asEdgeId<typeof worksAt>("edge-1")),
      );
      expect(stored.meta.validFrom).toBe(LATER);
      expect(stored.meta.validTo).toBeUndefined();
      expect(stored.role).toBe("Engineer");
    });

    it("accepts a zero-width and a born-ended window", async () => {
      const zeroWidth = await documentWithWindow({
        validFrom: START,
        validTo: START,
      });
      const bornEnded = await documentWithWindow({
        validFrom: undefined,
        validTo: START,
      });

      for (const document of [zeroWidth, bornEnded]) {
        const target = createStore(graph, createTestBackend());
        const result = await importGraph(
          target,
          document,
          ImportOptionsSchema.parse({ onConflict: "skip" }),
        );
        expect(result.errors).toEqual([]);
        expect(result.success).toBe(true);
        expect(result.nodes.created).toBe(2);
      }
    });
  });

  describe("a node resurrection stores the bound it was measured against", () => {
    /**
     * A node resurrection REWRITES `valid_from`, so its guard has no stored bound
     * to measure against and uses the write instant instead. The operations layer
     * and the backend read the same clock at two different moments, so the bound
     * the guard approved was not the bound the write stored: a `validTo` at the
     * guard's instant passed as zero-width and landed as NEGATIVE width once the
     * backend's later sample became `valid_from` (issue #413).
     *
     * The fix makes the guard's instant the stored one by passing it to the
     * backend explicitly. These cases step the clock at the operations/backend
     * boundary — the real ordering, made deterministic — so the gap is one
     * millisecond every run instead of whatever the machine happened to produce.
     */
    const GUARD_INSTANT = "2031-01-01T00:00:00.000Z";
    const BACKEND_INSTANT = "2031-01-01T00:00:00.001Z";

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * A backend whose resurrecting node UPDATE observes a clock one millisecond
     * ahead of the one the operations layer sampled. Interception has to happen
     * on the TRANSACTION target: the write runs against the backend
     * `runInWriteTransaction` yields, not against the outer object.
     */
    function clockSteppingBackend(): GraphBackend {
      const base = createTestBackend();
      return {
        ...base,
        transaction: (fn, options) =>
          base.transaction((transactionTarget) => {
            const steppingTarget = new Proxy(transactionTarget, {
              get(source, property, receiver) {
                const value: unknown = Reflect.get(source, property, receiver);
                if (property !== "updateNode" || typeof value !== "function") {
                  return value;
                }
                const updateNode = value as (
                  params: Parameters<GraphBackend["updateNode"]>[0],
                ) => ReturnType<GraphBackend["updateNode"]>;
                return async (
                  params: Parameters<GraphBackend["updateNode"]>[0],
                ) => {
                  if (params.clearDeleted === true) {
                    vi.setSystemTime(new Date(BACKEND_INSTANT));
                  }
                  return updateNode.call(source, params);
                };
              },
            });
            return fn(steppingTarget);
          }, options),
      } satisfies GraphBackend;
    }

    it("stores zero width when a resurrecting upsertById ends at the guard's own instant", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(GUARD_INSTANT));
      const stepping = clockSteppingBackend();
      const store = createStore(graph, stepping);

      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "resurrect-now" },
      );
      await store.nodes.Person.delete(person.id);

      // `validTo` at the instant the guard samples: zero width, so the guard
      // admits it. Pre-fix the backend then stamped BACKEND_INSTANT as
      // `valid_from` and the committed row was one millisecond wide backwards.
      const revived = await store.nodes.Person.upsertById(
        person.id,
        { name: "Alice" },
        { validTo: GUARD_INSTANT },
      );

      expect(revived.meta.validFrom).toBe(GUARD_INSTANT);
      expect(revived.meta.validTo).toBe(GUARD_INSTANT);

      const raw = requireDefined(
        await stepping.getNode(graph.id, "Person", person.id),
      );
      expect(raw.deleted_at).toBeUndefined();
      expect(
        requireDefined(raw.valid_from) <= requireDefined(raw.valid_to),
      ).toBe(true);
      expect(raw.valid_from).toBe(GUARD_INSTANT);
      expect(raw.valid_to).toBe(GUARD_INSTANT);
    });

    it("stores zero width when a resurrecting bulkUpsertById ends at the guard's own instant", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(GUARD_INSTANT));
      const stepping = clockSteppingBackend();
      const store = createStore(graph, stepping);

      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "resurrect-now-bulk" },
      );
      await store.nodes.Person.delete(person.id);

      await store.nodes.Person.bulkUpsertById([
        { id: person.id, props: { name: "Alice" }, validTo: GUARD_INSTANT },
      ]);

      const raw = requireDefined(
        await stepping.getNode(graph.id, "Person", person.id),
      );
      expect(
        requireDefined(raw.valid_from) <= requireDefined(raw.valid_to),
      ).toBe(true);
      expect(raw.valid_from).toBe(GUARD_INSTANT);
      expect(raw.valid_to).toBe(GUARD_INSTANT);
    });

    it("leaves an explicitly stated resurrection window untouched", async () => {
      // The stated-pair path is unaffected: an explicit validFrom still wins
      // over the sampled instant, so restating the whole historical window
      // behaves exactly as before.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(GUARD_INSTANT));
      const stepping = clockSteppingBackend();
      const store = createStore(graph, stepping);

      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "resurrect-stated" },
      );
      await store.nodes.Person.delete(person.id);

      const revived = await store.nodes.Person.upsertById(
        person.id,
        { name: "Alice" },
        { validFrom: EARLIER, validTo: START },
      );

      expect(revived.meta.validFrom).toBe(EARLIER);
      expect(revived.meta.validTo).toBe(START);
    });
  });
});
