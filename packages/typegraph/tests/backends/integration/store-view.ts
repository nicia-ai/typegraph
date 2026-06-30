/**
 * StoreView Integration Tests
 *
 * Exercises the read-only `(mode, asOf)` lens (`store.asOf(T)` /
 * `store.view({ mode, asOf })`) across the full Unit 1 surface matrix on
 * every backend, so the valid-time pin is honored identically on SQLite
 * and Postgres:
 *
 * - every supported read returns the pinned-time image
 *   (`getById` / `getByIds` / `find` / `count`, `query`, `subgraph`,
 *   `reachable` / `canReach` / `shortestPath` / `degree`, edge
 *   `findFrom` / `findTo`);
 * - `search` refuses on a non-`current` pin;
 * - writes are rejected on the view;
 * - a `current` view ≡ the live store.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  ValidationError,
} from "../../../src";
import { TEMPORAL_ANCHORS } from "../../test-utils";
import { type IntegrationStore } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

const { PAST, BEFORE, EDGE_ENDED } = TEMPORAL_ANCHORS;

/**
 * The `asOf` instant the valid-time tests pin to: after `PAST`, before
 * `EDGE_ENDED`, and well before "now". Splits the fixture into two
 * disjoint temporal images so the pin demonstrably changes results.
 */
const AS_OF = BEFORE;

const THEN_KIND = "then";
const CATCH_KIND = "catch";

const ThenNode = defineNode(THEN_KIND, {
  schema: z.object({ name: z.string() }),
});

const CatchEdge = defineEdge(CATCH_KIND, {
  schema: z.object({ label: z.string() }),
});

const interopProbeKindGraph = defineGraph({
  id: "store_view_interop_probe_kind_names",
  nodes: {
    // eslint-disable-next-line unicorn/no-thenable -- regression: a real kind can be named "then".
    [THEN_KIND]: { type: ThenNode },
  },
  edges: {
    [CATCH_KIND]: {
      type: CatchEdge,
      from: [ThenNode],
      to: [ThenNode],
    },
  },
});

type ViewFixture = Readonly<{
  /** Valid `[PAST, ∞)` — visible at `AS_OF` and now. */
  aliceId: string;
  /** Valid `[PAST, EDGE_ENDED)` — visible at `AS_OF`, ended by now. */
  carolId: string;
  /** Valid `[PAST, EDGE_ENDED)` — visible at `AS_OF`, ended by now. */
  erinId: string;
  /** Valid `[EDGE_ENDED, ∞)` — not yet valid at `AS_OF`, visible now. */
  daveId: string;
  /** `alice -> carol` knows edge, valid `[PAST, EDGE_ENDED)`. */
  aliceCarolEdgeId: string;
}>;

/**
 * Seeds two disjoint temporal eras:
 *
 * - At `AS_OF`: people {alice, carol, erin}; alice knows {carol, erin}.
 * - At now:     people {alice, dave};        alice knows {dave}.
 */
async function seedViewFixture(store: IntegrationStore): Promise<ViewFixture> {
  const [alice, carol, erin, dave] = await Promise.all([
    store.nodes.Person.create({ name: "Alice" }, { validFrom: PAST }),
    store.nodes.Person.create(
      { name: "Carol" },
      { validFrom: PAST, validTo: EDGE_ENDED },
    ),
    store.nodes.Person.create(
      { name: "Erin" },
      { validFrom: PAST, validTo: EDGE_ENDED },
    ),
    store.nodes.Person.create({ name: "Dave" }, { validFrom: EDGE_ENDED }),
  ]);

  const [aliceCarol] = await Promise.all([
    store.edges.knows.create(
      alice,
      carol,
      { since: "2020" },
      { validFrom: PAST, validTo: EDGE_ENDED },
    ),
    store.edges.knows.create(
      alice,
      erin,
      { since: "2020" },
      { validFrom: PAST, validTo: EDGE_ENDED },
    ),
    store.edges.knows.create(
      alice,
      dave,
      { since: "2022" },
      { validFrom: EDGE_ENDED },
    ),
  ]);

  return {
    aliceId: alice.id,
    carolId: carol.id,
    erinId: erin.id,
    daveId: dave.id,
    aliceCarolEdgeId: aliceCarol.id,
  };
}

function sortedNames(people: readonly Readonly<{ name: string }>[]): string[] {
  return people.map((person) => person.name).toSorted();
}

async function seedSearchArticle(store: IntegrationStore): Promise<string> {
  const article = await store.nodes.Article.create({
    title: "Climate change drivers",
    body: "Rising global temperatures linked to greenhouse gas emissions.",
    category: "science",
    published: true,
  });
  return article.id;
}

export function registerStoreViewIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("StoreView (read-only as-of lens)", () => {
    describe("valid-time surface matrix", () => {
      it("getById / getByIds return the pinned-time image", async () => {
        const store = context.getStore();
        const { carolId, daveId } = await seedViewFixture(store);
        const past = store.asOf(AS_OF);

        const carolPast = await past.nodes.Person.getById(carolId as never);
        const davePast = await past.nodes.Person.getById(daveId as never);
        expect(carolPast?.name).toBe("Carol");
        expect(davePast).toBeUndefined();

        // The live store reads the current image — the mirror of the pin.
        expect(
          await store.nodes.Person.getById(carolId as never),
        ).toBeUndefined();
        const daveLive = await store.nodes.Person.getById(daveId as never);
        expect(daveLive?.name).toBe("Dave");

        const batch = await past.nodes.Person.getByIds([
          carolId,
          daveId,
        ] as never);
        expect(batch.map((node) => node?.name)).toEqual(["Carol", undefined]);
      });

      it("does not hide real kinds named like JS interop probes", async () => {
        const [store] = await createStoreWithSchema(
          interopProbeKindGraph,
          context.getStore().backend,
        );
        const first = await store.nodes[THEN_KIND].create(
          { name: "First" },
          { validFrom: PAST },
        );
        const second = await store.nodes[THEN_KIND].create(
          { name: "Second" },
          { validFrom: PAST },
        );
        const edge = await store.edges[CATCH_KIND].create(
          first,
          second,
          { label: "probe edge" },
          { validFrom: PAST },
        );
        const past = store.asOf(AS_OF);
        const pinnedFirst = await past.nodes[THEN_KIND].getById(first.id);
        const pinnedEdge = await past.edges[CATCH_KIND].getById(edge.id);

        expect(pinnedFirst?.name).toBe("First");
        expect(pinnedEdge?.label).toBe("probe edge");
        expect(
          (past.nodes as unknown as { toJSON?: unknown }).toJSON,
        ).toBeUndefined();
      });

      it("find / count observe the pinned-time image", async () => {
        const store = context.getStore();
        await seedViewFixture(store);
        const past = store.asOf(AS_OF);

        expect(sortedNames(await past.nodes.Person.find())).toEqual([
          "Alice",
          "Carol",
          "Erin",
        ]);
        expect(await past.nodes.Person.count()).toBe(3);

        // `where` and pagination still route through the pin.
        const carolOnly = await past.nodes.Person.find({
          where: (person) => person.name.eq("Carol"),
        });
        expect(sortedNames(carolOnly)).toEqual(["Carol"]);
        expect(
          await store.nodes.Person.find({
            where: (person) => person.name.eq("Carol"),
          }),
        ).toHaveLength(0);
        expect(await past.nodes.Person.find({ limit: 2 })).toHaveLength(2);

        // Live store sees the current image: {Alice, Dave}.
        expect(sortedNames(await store.nodes.Person.find())).toEqual([
          "Alice",
          "Dave",
        ]);
        expect(await store.nodes.Person.count()).toBe(2);
      });

      it("query() returns a pre-pinned builder", async () => {
        const store = context.getStore();
        await seedViewFixture(store);

        const past = store.asOf(AS_OF);
        const names = await past
          .query()
          .from("Person", "p")
          .select((ctx) => ctx.p.name)
          .execute();
        expect(names.toSorted()).toEqual(["Alice", "Carol", "Erin"]);
      });

      it("subgraph honors the pin", async () => {
        const store = context.getStore();
        const { aliceId } = await seedViewFixture(store);

        const past = await store
          .asOf(AS_OF)
          .subgraph(aliceId as never, { edges: ["knows"] });
        expect([...past.nodes.keys()].length).toBe(3);
        expect(
          [...past.nodes.values()].every((node) => node.kind === "Person"),
        ).toBe(true);
        const pastNames = [...past.nodes.values()]
          .map((node) => (node as { name: string }).name)
          .toSorted();
        expect(pastNames).toEqual(["Alice", "Carol", "Erin"]);

        const current = await store.subgraph(aliceId as never, {
          edges: ["knows"],
        });
        const currentNames = [...current.nodes.values()]
          .map((node) => (node as { name: string }).name)
          .toSorted();
        expect(currentNames).toEqual(["Alice", "Dave"]);
      });

      it("reachable / canReach / shortestPath honor the pin", async () => {
        const store = context.getStore();
        const { aliceId, carolId, erinId, daveId } =
          await seedViewFixture(store);
        const past = store.asOf(AS_OF);

        const reached = await past.reachable(aliceId, { edges: ["knows"] });
        expect(reached.map((node) => node.id).toSorted()).toEqual(
          [aliceId, carolId, erinId].toSorted(),
        );

        expect(
          await past.canReach(aliceId, carolId, { edges: ["knows"] }),
        ).toBe(true);
        expect(
          await store.algorithms.canReach(aliceId, carolId, {
            edges: ["knows"],
          }),
        ).toBe(false);

        const pathToCarol = await past.shortestPath(aliceId, carolId, {
          edges: ["knows"],
        });
        expect(pathToCarol?.depth).toBe(1);
        // dave is unreachable at AS_OF (its edge is not yet valid).
        expect(
          await past.shortestPath(aliceId, daveId, { edges: ["knows"] }),
        ).toBeUndefined();
      });

      it("degree honors the pin", async () => {
        const store = context.getStore();
        const { aliceId } = await seedViewFixture(store);

        expect(
          await store.asOf(AS_OF).degree(aliceId, {
            edges: ["knows"],
            direction: "out",
          }),
        ).toBe(2);
        expect(
          await store.algorithms.degree(aliceId, {
            edges: ["knows"],
            direction: "out",
          }),
        ).toBe(1);
      });

      it("edges.findFrom / findTo honor the pin", async () => {
        const store = context.getStore();
        const { aliceId, carolId } = await seedViewFixture(store);
        const aliceRef = { kind: "Person", id: aliceId } as const;
        const carolRef = { kind: "Person", id: carolId } as const;

        const past = store.asOf(AS_OF);
        const fromAlicePast = await past.edges.knows.findFrom(aliceRef);
        expect(fromAlicePast).toHaveLength(2);

        const toCarolPast = await past.edges.knows.findTo(carolRef);
        expect(toCarolPast).toHaveLength(1);
        expect(toCarolPast[0]?.fromId).toBe(aliceId);

        // Live store reads the current image of the same endpoints.
        expect(await store.edges.knows.findFrom(aliceRef)).toHaveLength(1);
        expect(await store.edges.knows.findTo(carolRef)).toHaveLength(0);
      });

      it("edge getById honors the pin", async () => {
        const store = context.getStore();
        const { aliceCarolEdgeId } = await seedViewFixture(store);

        const past = store.asOf(AS_OF);
        const edgePast = await past.edges.knows.getById(
          aliceCarolEdgeId as never,
        );
        expect(edgePast?.id).toBe(aliceCarolEdgeId);
        expect(
          await store.edges.knows.getById(aliceCarolEdgeId as never),
        ).toBeUndefined();
      });
    });

    describe("includeEnded / includeTombstones modes", () => {
      it("includeTombstones exposes soft-deleted nodes", async () => {
        const store = context.getStore();
        const ghost = await store.nodes.Person.create({ name: "Ghost" });
        await store.nodes.Person.delete(ghost.id);

        const tombstoneView = store.view({ mode: "includeTombstones" });
        const ghostView = await tombstoneView.nodes.Person.getById(ghost.id);
        expect(ghostView?.name).toBe("Ghost");
        expect(await store.nodes.Person.getById(ghost.id)).toBeUndefined();
      });

      it("includeEnded exposes ended edges", async () => {
        const store = context.getStore();
        const { aliceId } = await seedViewFixture(store);
        const aliceRef = { kind: "Person", id: aliceId } as const;

        // All three knows edges exist across history; includeEnded keeps the
        // ended ones (excluding only soft-deletes), so all three return.
        const endedView = store.view({ mode: "includeEnded" });
        expect(await endedView.edges.knows.findFrom(aliceRef)).toHaveLength(3);
      });
    });

    describe("search refusal", () => {
      it("refuses all search on a non-current pin (Promise rejection)", async () => {
        const store = context.getStore();
        await seedViewFixture(store);

        // The refusal is a Promise rejection, matching the async StoreSearch
        // contract — so both `await` and un-awaited `.catch()` observe it.
        const past = store.asOf(AS_OF);
        await expect(
          past.search.fulltext("Article", { query: "anything", limit: 5 }),
        ).rejects.toThrow(ConfigurationError);
        await expect(past.search.rebuildFulltext()).rejects.toThrow(
          ConfigurationError,
        );
        await expect(
          store
            .view({ mode: "includeTombstones" })
            .search.fulltext("Article", { query: "anything", limit: 5 }),
        ).rejects.toThrow(ConfigurationError);
      });

      it("delegates read search but refuses rebuildFulltext on a current pin", async () => {
        const store = context.getStore();
        await seedViewFixture(store);
        const articleId = await seedSearchArticle(store);
        const current = store.view({ mode: "current" });

        // Read methods delegate to the live search (same result), so the
        // view is a usable current-time search surface...
        const viaView = await current.search.fulltext("Article", {
          query: "climate",
          limit: 5,
        });
        const viaLive = await store.search.fulltext("Article", {
          query: "climate",
          limit: 5,
        });
        expect(viaView.map((hit) => hit.node.id)).toContain(articleId);
        expect(viaView.map((hit) => hit.node.id)).toEqual(
          viaLive.map((hit) => hit.node.id),
        );

        // ...but the mutating maintenance op stays off the read-only view.
        await expect(current.search.rebuildFulltext()).rejects.toThrow(
          ConfigurationError,
        );
      });
    });

    describe("proxy robustness", () => {
      it("inherited Object.prototype methods pass through (coercion-safe)", async () => {
        const store = context.getStore();
        await seedViewFixture(store);
        const past = store.asOf(AS_OF);

        // `toString` is inherited, not an own collection method, so it
        // passes through to Object.prototype rather than a throwing refusal
        // stub — string coercion / logging of a pinned collection stays
        // safe. (Exercising base-to-string is the point of this test.)
        /* eslint-disable @typescript-eslint/no-base-to-string */
        expect(() => String(past.nodes.Person)).not.toThrow();
        expect(() => String(past.edges.knows)).not.toThrow();
        /* eslint-enable @typescript-eslint/no-base-to-string */
      });

      it("search facade inherited Object.prototype methods pass through", () => {
        const store = context.getStore();
        const past = store.asOf(AS_OF);
        const current = store.view({ mode: "current" });

        // Non-current search methods refuse by returning async rejection
        // stubs, but inherited coercion hooks must stay inherited so logging
        // and assertion messages do not call a rejection stub.
        /* eslint-disable @typescript-eslint/no-base-to-string */
        expect(() => String(past.search)).not.toThrow();
        expect(() => String(current.search)).not.toThrow();
        /* eslint-enable @typescript-eslint/no-base-to-string */
      });

      it("collection namespaces are not mistaken for thenables", () => {
        const store = context.getStore();
        const past = store.asOf(AS_OF);

        // `then` resolves to undefined so `await past.nodes` (a mistake) is a
        // no-op rather than a thrown KindNotFoundError.
        expect((past.nodes as Record<string, unknown>).then).toBeUndefined();
        expect((past.edges as Record<string, unknown>).then).toBeUndefined();
      });

      it("the `in` operator agrees with property access on a pinned collection", () => {
        const store = context.getStore();
        const person = store.asOf(AS_OF).nodes.Person;

        // A pinned read, a refusing write, and a current-only read all resolve
        // to a function via `get`, so `in` must report them present too...
        expect("getById" in person).toBe(true);
        expect("create" in person).toBe(true);
        expect("findByConstraint" in person).toBe(true);
        // ...an inherited Object.prototype member is present...
        expect("toString" in person).toBe(true);
        // ...and an unknown property is absent (get returns undefined).
        expect("definitelyNotAMethod" in person).toBe(false);
      });

      it("the `in` operator agrees with property access on search facades", () => {
        const store = context.getStore();
        const currentSearch = store.view({ mode: "current" }).search;
        const pastSearch = store.asOf(AS_OF).search;

        expect("fulltext" in currentSearch).toBe(true);
        expect("vector" in currentSearch).toBe(true);
        expect("hybrid" in currentSearch).toBe(true);
        expect("rebuildFulltext" in currentSearch).toBe(true);
        expect("fulltext" in pastSearch).toBe(true);
        expect("then" in pastSearch).toBe(false);
        expect("toString" in pastSearch).toBe(true);
      });

      it("batchFindFrom honors temporal options under store.batch", async () => {
        const store = context.getStore();
        const { aliceId } = await seedViewFixture(store);
        const aliceRef = { kind: "Person", id: aliceId } as const;

        const [pinned, live] = await store.batch(
          store.edges.knows.batchFindFrom(aliceRef, {
            temporalMode: "asOf",
            asOf: AS_OF,
          }),
          store.edges.knows.batchFindFrom(aliceRef),
        );
        expect(pinned).toHaveLength(2); // carol + erin valid at AS_OF
        expect(live).toHaveLength(1); // dave valid now
      });
    });

    describe("read-only enforcement", () => {
      it("rejects node and edge writes", async () => {
        const store = context.getStore();
        const { aliceId, daveId } = await seedViewFixture(store);
        const past = store.asOf(AS_OF);

        const nodeWrites = past.nodes.Person as unknown as Readonly<{
          create: (props: unknown) => unknown;
          delete: (id: string) => unknown;
        }>;
        expect(() => nodeWrites.create({ name: "Mallory" })).toThrow(
          ConfigurationError,
        );
        expect(() => nodeWrites.delete(aliceId)).toThrow(ConfigurationError);

        const edgeWrites = past.edges.knows as unknown as Readonly<{
          create: (from: unknown, to: unknown, props: unknown) => unknown;
        }>;
        expect(() =>
          edgeWrites.create(
            { kind: "Person", id: aliceId },
            { kind: "Person", id: daveId },
            {},
          ),
        ).toThrow(ConfigurationError);
      });

      it("refuses batch endpoint reads as reads, not writes", async () => {
        const store = context.getStore();
        const { aliceId } = await seedViewFixture(store);
        const past = store.asOf(AS_OF);

        // The typed view omits batch reads; a JS caller (or the widened dynamic
        // surface) can still reach them, and they must refuse as a deferred read
        // — never be mislabeled a write.
        const batchReads = past.edges.knows as unknown as Readonly<{
          batchFindFrom: (from: unknown) => unknown;
        }>;
        let thrown: unknown;
        try {
          batchReads.batchFindFrom({ kind: "Person", id: aliceId });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ConfigurationError);
        const message = (thrown as ConfigurationError).message;
        expect(message).toContain("store.batch");
        // The refusal must NOT borrow the write-refusal wording.
        expect(message).not.toContain("perform writes on the live Store");
      });

      it("exposes no transaction surface", () => {
        const store = context.getStore();
        const past = store.asOf(AS_OF) as unknown as Readonly<{
          transaction?: unknown;
        }>;
        expect(past.transaction).toBeUndefined();
      });

      it("prevents mutation of cached read-only collection wrappers", async () => {
        const store = context.getStore();
        await seedViewFixture(store);
        const past = store.asOf(AS_OF);

        const person = past.nodes.Person as unknown as {
          find?: unknown;
          getById: unknown;
          spoofed?: unknown;
        };
        const knows = past.edges.knows as unknown as {
          count?: unknown;
          findFrom: unknown;
        };

        expect(() => {
          person.getById = () => Promise.resolve();
        }).toThrow(TypeError);
        expect(() => {
          Object.defineProperty(person, "spoofed", { value: true });
        }).toThrow(TypeError);
        expect(() => {
          delete person.find;
        }).toThrow(TypeError);
        expect(() => {
          knows.findFrom = () => Promise.resolve([]);
        }).toThrow(TypeError);
        expect(() => {
          delete knows.count;
        }).toThrow(TypeError);

        expect(typeof past.nodes.Person.getById).toBe("function");
        expect(typeof past.edges.knows.findFrom).toBe("function");
      });
    });

    describe("construction", () => {
      it("requires a timestamp for asOf mode", () => {
        const store = context.getStore();
        expect(() =>
          // @ts-expect-error - asOf is required for "asOf" mode at the type level
          store.view({ mode: "asOf" }),
        ).toThrow(ValidationError);
      });

      it("rejects non-canonical asOf timestamps", () => {
        const store = context.getStore();
        // Text temporal filters require canonical fixed-width UTC ISO-8601, so
        // date-only, zoned-offset, and natural-language strings are rejected.
        expect(() => store.asOf("2021-01-01")).toThrow(ValidationError);
        expect(() => store.asOf("2021-01-01T00:00:00+02:00")).toThrow(
          ValidationError,
        );
        expect(() => store.asOf("January 1, 2021")).toThrow(ValidationError);
        // Variable-width / missing milliseconds are rejected too: ".1Z" (=.100)
        // would sort AFTER ".101Z" as text and include future-dated rows.
        expect(() => store.asOf("2021-01-01T00:00:00.1Z")).toThrow(
          ValidationError,
        );
        expect(() => store.asOf("2021-01-01T00:00:00Z")).toThrow(
          ValidationError,
        );
        // A canonical fixed-width UTC ISO-8601 timestamp is accepted.
        expect(() => store.asOf("2021-01-01T00:00:00.000Z")).not.toThrow();
      });

      it("rejects an asOf paired with a non-asOf mode instead of dropping it", () => {
        const store = context.getStore();
        // Pinning an instant is only meaningful in asOf mode; supplying asOf
        // with another mode used to be silently discarded (view.asOf === undefined
        // and the pin ignored). It is now both a compile error (the coordinate is
        // a discriminated union) and — for untyped JS callers — a runtime
        // ValidationError. The @ts-expect-error asserts the former; toThrow the
        // latter.
        expect(() =>
          // @ts-expect-error - asOf is rejected for non-asOf modes at the type level
          store.view({ mode: "current", asOf: AS_OF }),
        ).toThrow(ValidationError);
        expect(() =>
          // @ts-expect-error - asOf is rejected for non-asOf modes at the type level
          store.view({ mode: "includeEnded", asOf: AS_OF }),
        ).toThrow(ValidationError);
        expect(() =>
          // @ts-expect-error - asOf is rejected for non-asOf modes at the type level
          store.view({ mode: "includeTombstones", asOf: AS_OF }),
        ).toThrow(ValidationError);
      });

      it("exposes the pinned coordinate", () => {
        const store = context.getStore();
        const past = store.asOf(AS_OF);
        expect(past.mode).toBe("asOf");
        expect(past.asOf).toBe(AS_OF);

        const current = store.view({ mode: "current" });
        expect(current.mode).toBe("current");
        expect(current.asOf).toBeUndefined();
      });
    });

    describe("current-mode equivalence with the live store", () => {
      it("matches the live store across every read surface", async () => {
        const store = context.getStore();
        const { aliceId, carolId } = await seedViewFixture(store);
        const current = store.view({ mode: "current" });
        const aliceRef = { kind: "Person", id: aliceId } as const;

        expect(sortedNames(await current.nodes.Person.find())).toEqual(
          sortedNames(await store.nodes.Person.find()),
        );
        expect(await current.nodes.Person.count()).toBe(
          await store.nodes.Person.count(),
        );

        const viewQueryNames = await current
          .query()
          .from("Person", "p")
          .select((ctx) => ctx.p.name)
          .execute();
        const liveQueryNames = await store
          .query()
          .from("Person", "p")
          .select((ctx) => ctx.p.name)
          .execute();
        expect(viewQueryNames.toSorted()).toEqual(liveQueryNames.toSorted());

        const viewEdges = await current.edges.knows.findFrom(aliceRef);
        const liveEdges = await store.edges.knows.findFrom(aliceRef);
        expect(viewEdges.length).toBe(liveEdges.length);

        expect(
          await current.degree(aliceId, { edges: ["knows"], direction: "out" }),
        ).toBe(
          await store.algorithms.degree(aliceId, {
            edges: ["knows"],
            direction: "out",
          }),
        );

        expect(
          await current.canReach(aliceId, carolId, { edges: ["knows"] }),
        ).toBe(
          await store.algorithms.canReach(aliceId, carolId, {
            edges: ["knows"],
          }),
        );
      });
    });

    describe("sealed query + current-only reads", () => {
      it("seals the temporal axis on view.query()", async () => {
        const store = context.getStore();
        await seedViewFixture(store);
        const past = store.asOf(AS_OF);

        // The pinned query builder refuses to be re-coordinated — the view
        // owns the temporal axis (a capability-safe pinned read context).
        expect(() =>
          (
            past.query() as unknown as {
              temporal: (mode: string) => unknown;
            }
          ).temporal("includeEnded"),
        ).toThrow(ConfigurationError);
        // The seal is in builder config (threaded through every clone), so it
        // survives the fluent chain, not just the first hop.
        expect(() =>
          (
            past.query().from("Person", "p") as unknown as {
              temporal: (mode: string) => unknown;
            }
          ).temporal("current"),
        ).toThrow(ConfigurationError);
      });

      it("refuses node current-only reads on a temporal pin", async () => {
        const store = context.getStore();
        await seedViewFixture(store);
        const past = store.asOf(AS_OF);

        // Constraint / index lookups have no temporal axis, so a temporal view
        // refuses them (Promise rejection) rather than silently returning
        // current data while every sibling read is pinned.
        await expect(
          past.nodes.Person.bulkFindByIndex("any", [
            { props: { name: "Alice" } },
          ]),
        ).rejects.toThrow(ConfigurationError);
      });

      it("edges.findByEndpoints honors the pin (temporal parity)", async () => {
        const store = context.getStore();
        const { aliceId, carolId } = await seedViewFixture(store);
        const aliceRef = { kind: "Person", id: aliceId } as const;
        const carolRef = { kind: "Person", id: carolId } as const;

        // The alice→carol edge is valid [PAST, EDGE_ENDED); AS_OF sits inside
        // that window, so a pinned view finds it...
        const past = store.asOf(AS_OF);
        const atPast = await past.edges.knows.findByEndpoints(
          aliceRef,
          carolRef,
        );
        expect(atPast?.fromId).toBe(aliceId);

        // ...while the live store (default "current" mode) excludes it now
        // that it has ended — findByEndpoints honors the temporal model like
        // findFrom / findTo.
        expect(
          await store.edges.knows.findByEndpoints(aliceRef, carolRef),
        ).toBeUndefined();
        // Recover the old "any non-deleted edge" behavior explicitly.
        expect(
          await store.edges.knows.findByEndpoints(
            aliceRef,
            carolRef,
            undefined,
            {
              temporalMode: "includeEnded",
            },
          ),
        ).toBeDefined();
      });

      it("findByEndpoints surfaces a soft-deleted edge only under includeTombstones", async () => {
        const store = context.getStore();
        const { aliceId, carolId, aliceCarolEdgeId } =
          await seedViewFixture(store);
        const aliceRef = { kind: "Person", id: aliceId } as const;
        const carolRef = { kind: "Person", id: carolId } as const;

        await store.edges.knows.delete(aliceCarolEdgeId as never);

        // includeEnded still excludes soft-deletes, so the lookup misses it...
        expect(
          await store.edges.knows.findByEndpoints(
            aliceRef,
            carolRef,
            undefined,
            {
              temporalMode: "includeEnded",
            },
          ),
        ).toBeUndefined();
        // ...but includeTombstones (excludeDeleted = false) surfaces the
        // tombstone, matching findFrom / findTo under the same mode.
        const tombstone = await store.edges.knows.findByEndpoints(
          aliceRef,
          carolRef,
          undefined,
          { temporalMode: "includeTombstones" },
        );
        expect(tombstone?.id).toBe(aliceCarolEdgeId);
      });
    });
  });
}
