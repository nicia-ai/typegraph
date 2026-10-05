/**
 * A StoreView's coordinate is sealed on every read, not only on
 * `view.query().temporal(...)`.
 *
 * The view's option types omit `temporalMode` / `asOf` / `recordedAsOf`, but
 * an untyped caller can still state them. A read that spread the pin over
 * the caller's options answered at the pin and dropped the stated value; each
 * read now refuses instead, on a `current` view and an `asOf` view alike.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows", {
  schema: z.object({ weight: z.number().optional() }),
});
const graph = defineGraph({
  id: "store_view_sealed_coordinate",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const OTHER_INSTANT = "2020-01-01T00:00:00.000Z";

const STATED_COORDINATES = {
  "temporalMode and asOf": { temporalMode: "asOf", asOf: OTHER_INSTANT },
  temporalMode: { temporalMode: "includeEnded" },
  asOf: { asOf: OTHER_INSTANT },
  recordedAsOf: { recordedAsOf: OTHER_INSTANT },
} as const;

async function seededStore() {
  const [store] = await createStoreWithSchema(graph, createTestBackend());
  const alice = await store.nodes.Person.create({ name: "alice" });
  const bob = await store.nodes.Person.create({ name: "bob" });
  await store.edges.knows.create(alice, bob, {});
  return { store, alice, bob };
}

type Seeded = Awaited<ReturnType<typeof seededStore>>;
type View = ReturnType<Seeded["store"]["view"]>;

/** Every view read that takes an options object, called with `stated` merged in. */
function readsStating(
  view: View,
  { alice, bob }: Seeded,
  stated: Readonly<Record<string, unknown>>,
): Readonly<Record<string, () => Promise<unknown>>> {
  const options = { edges: ["knows"], ...stated } as never;
  return {
    subgraph: () => view.subgraph(alice.id, options),
    shortestPath: () => view.shortestPath(alice, bob, options),
    weightedShortestPath: () =>
      view.weightedShortestPath(alice, bob, {
        edges: ["knows"],
        weight: "weight",
        ...stated,
      } as never),
    reachable: () => view.reachable(alice, options),
    canReach: () => view.canReach(alice, bob, options),
    neighbors: () => view.neighbors(alice, options),
    degree: () => view.degree(alice, options),
    labelPropagation: () => view.labelPropagation(options),
    weaklyConnectedComponents: () => view.weaklyConnectedComponents(options),
    pageRank: () => view.pageRank(options),
    personalizedPageRank: () =>
      view.personalizedPageRank({
        edges: ["knows"],
        seeds: [alice],
        ...stated,
      } as never),
    "algorithms.reachable": () => view.algorithms.reachable(alice, options),
    bulkFindEdgesFrom: () =>
      view.bulkFindEdgesFrom(
        { kinds: ["knows"], from: [alice] } as never,
        stated,
      ),
    bulkFindEdgesTo: () =>
      view.bulkFindEdgesTo({ kinds: ["knows"], to: [bob] } as never, stated),
    "edges.bulkFindFrom": () => view.edges.knows.bulkFindFrom([alice], stated),
    "edges.bulkFindTo": () => view.edges.knows.bulkFindTo([bob], stated),
  };
}

async function refusalCodes(
  reads: Readonly<Record<string, () => Promise<unknown>>>,
): Promise<Readonly<Record<string, unknown>>> {
  const codes: Record<string, unknown> = {};
  for (const [name, read] of Object.entries(reads)) {
    codes[name] = await read().then(
      () => "answered",
      (error: unknown) =>
        error instanceof ConfigurationError ? error.details["code"] : error,
    );
  }
  return codes;
}

describe("a StoreView read refuses a caller-stated coordinate", () => {
  describe.each(["current", "asOf"] as const)("on a %s view", (mode) => {
    it.each(Object.entries(STATED_COORDINATES))(
      "refuses every options-taking read that states %s",
      async (_label, stated) => {
        const seeded = await seededStore();
        const view =
          mode === "current" ?
            seeded.store.view({ mode: "current" })
          : seeded.store.asOf(new Date().toISOString());
        const reads = readsStating(view, seeded, stated);

        expect(await refusalCodes(reads)).toEqual(
          Object.fromEntries(
            Object.keys(reads).map((name) => [
              name,
              "STORE_VIEW_SEALED_COORDINATE",
            ]),
          ),
        );
      },
    );
  });

  it("names the read, the stated keys and the pinned coordinate", async () => {
    const seeded = await seededStore();
    const view = seeded.store.asOf(OTHER_INSTANT);

    const refusal = await view
      .subgraph(seeded.alice.id, {
        edges: ["knows"],
        temporalMode: "current",
        asOf: undefined,
      } as never)
      .then(
        () => "answered",
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(ConfigurationError);
    expect((refusal as ConfigurationError).details).toMatchObject({
      code: "STORE_VIEW_SEALED_COORDINATE",
      method: "subgraph",
      stated: ["temporalMode"],
    });
  });

  it("answers at the pin when no coordinate is stated", async () => {
    const seeded = await seededStore();
    const now = seeded.store.view({ mode: "current" });
    const before = seeded.store.asOf(OTHER_INSTANT);

    const names = async (view: View) => {
      const result = await view.subgraph(seeded.alice.id, {
        edges: ["knows"],
      });
      return [...result.nodes.values()].map((node) => node.name).toSorted();
    };

    expect(await names(now)).toEqual(["alice", "bob"]);
    expect(await names(before)).toEqual([]);
    expect(await now.degree(seeded.alice, { edges: ["knows"] })).toBe(1);
    expect(await now.edges.knows.bulkFindFrom([seeded.alice])).toHaveLength(1);
  });
});
