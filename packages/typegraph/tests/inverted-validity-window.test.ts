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
 *   4. "born already ended" — an INSERT carrying a lone historical `validTo` —
 *      stays legal: the stamped `valid_from` is a storage convention, not a
 *      caller assertion, and the row is read back through `includeEnded`;
 *   5. resurrecting an EDGE straight into the ended state stays legal, because
 *      an edge retains its stored lower bound (a node's resurrection resets it,
 *      which is why the node path refuses the same shape);
 *   6. import refuses an inverted document per row, carrying the stable code.
 *
 * Trusted import carries the same refusal through its own typed stream error;
 * those cases live with the rest of its stream-shape suite in
 * `trusted-import.test.ts`.
 *
 * Every refusal carries {@link INVERTED_VALIDITY_WINDOW_CODE} on its issue, so
 * callers branch on the code rather than on prose.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { GraphBackend } from "../src";
import {
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
      node.id === "person-1" ? { ...node, ...window } : node,
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
    it("accepts a lone historical validTo on node and edge create", async () => {
      const store = createStore(graph, backend);
      // No validFrom: the backend stamps the write instant. The row is
      // deliberately not current, and `includeEnded` is how it is read back —
      // an established idiom across the temporal, search and provenance suites.
      const person = await store.nodes.Person.create(
        { name: "Former" },
        { validTo: START },
      );
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(
        person,
        acme,
        { role: "Former Employee" },
        { validTo: START },
      );

      expect(person.meta.validTo).toBe(START);
      expect(edge.meta.validTo).toBe(START);
    });

    it("accepts resurrecting an edge straight into the ended state", async () => {
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const bigCo = await store.nodes.Company.create({ name: "BigCo" });

      // An ended employment, revived by endpoint identity with only its end
      // stated. An edge RETAINS its stored lower bound across resurrection, so
      // the lone validTo is a statement about the revived row's end, not a claim
      // about its start — `getOrCreateByEndpoints` counts it against cardinality
      // as an inactive row. The node path refuses this same shape because a
      // node's resurrection resets `valid_from` to the write instant.
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
      expect(revived.edge.meta.validTo).toBe(LATER);
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
});
