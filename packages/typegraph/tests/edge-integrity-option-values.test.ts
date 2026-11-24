/**
 * `cardinality`, `targetCardinality` and `acyclic` are refused at `defineGraph`
 * when stated outside their domain, and the removed `endpointExistence` is
 * refused whatever value it states.
 *
 * Every reader of these options compares by string or strict boolean and
 * treats an unrecognized value as "undeclared", so an untyped caller's typo
 * would otherwise produce a graph whose declared constraint silently does not
 * hold, and a stored schema the loader's own enum rejects.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../src";
import type { EdgeRegistration } from "../src/core";
import {
  CARDINALITY_VALUES,
  TARGET_CARDINALITY_VALUES,
} from "../src/core/edge-integrity-options";
import { defineGraphExtension } from "../src/graph-extension";
import { serializeSchema } from "../src/schema";
import { parseSerializedSchema } from "../src/schema/manager";
import type { SerializedEdgeDef } from "../src/schema/types";
import type { EdgeIntrospection } from "../src/store/introspect";
import { createTestBackend } from "./test-utils";

const Item = defineNode("Item", { schema: z.object({}) });
const linksTo = defineEdge("linksTo", { schema: z.object({}) });

function graphDeclaring(options: Readonly<Record<string, unknown>>) {
  return defineGraph({
    id: "edge_integrity_option_values",
    nodes: { Item: { type: Item } },
    edges: {
      linksTo: { type: linksTo, from: [Item], to: [Item], ...options } as never,
    },
  });
}

function refusalOf(options: Readonly<Record<string, unknown>>): unknown {
  try {
    graphDeclaring(options);
    return "accepted";
  } catch (error) {
    return error;
  }
}

const INVALID_STATEMENTS = [
  { option: "cardinality", value: "bogus" },
  { option: "cardinality", value: "One" },
  { option: "cardinality", value: 1 },
  // eslint-disable-next-line unicorn/no-null -- an untyped caller can state null
  { option: "cardinality", value: null },
  { option: "targetCardinality", value: "unique" },
  { option: "targetCardinality", value: "bogus" },
  { option: "targetCardinality", value: true },
  { option: "acyclic", value: "yes" },
  { option: "acyclic", value: "true" },
  { option: "acyclic", value: 1 },
  // eslint-disable-next-line unicorn/no-null -- an untyped caller can state null
  { option: "acyclic", value: null },
] as const;

describe("edge integrity option values", () => {
  it.each(INVALID_STATEMENTS)(
    "refuses $option: $value at defineGraph",
    ({ option, value }) => {
      const refusal = refusalOf({ [option]: value });

      expect(refusal).toBeInstanceOf(ConfigurationError);
      expect((refusal as ConfigurationError).details).toMatchObject({
        code: "EDGE_INTEGRITY_OPTION_INVALID",
        edgeKind: "linksTo",
        option,
      });
    },
  );

  // Every value the removed option ever accepted, plus ones it never did: a
  // stated `endpointExistence` is refused, never silently dropped.
  it.each([
    "notDeleted",
    "currentlyValid",
    "ever",
    "bogus",
    false,
    // eslint-disable-next-line unicorn/no-null -- an untyped caller can state null
    null,
  ])("refuses the removed endpointExistence: %s at defineGraph", (value) => {
    const refusal = refusalOf({ endpointExistence: value });

    expect(refusal).toBeInstanceOf(ConfigurationError);
    expect((refusal as ConfigurationError).message).toBe(
      'Edge "linksTo" declares `endpointExistence`, which is no longer an edge option.',
    );
    expect((refusal as ConfigurationError).details).toEqual({
      code: "EDGE_INTEGRITY_OPTION_INVALID",
      edgeKind: "linksTo",
      option: "endpointExistence",
      value,
    });
  });

  it("has no endpointExistence in the registration, serialized or introspected edge types", () => {
    // Declared only as a `never` tombstone, so no value can be stated.
    expectTypeOf<
      NonNullable<EdgeRegistration["endpointExistence"]>
    >().toBeNever();
    expectTypeOf<SerializedEdgeDef>().not.toHaveProperty("endpointExistence");
    expectTypeOf<EdgeIntrospection>().not.toHaveProperty("endpointExistence");

    const registration: EdgeRegistration = {
      type: linksTo,
      from: [Item],
      to: [Item],
      // @ts-expect-error -- the option was removed from EdgeRegistration
      endpointExistence: "ever",
    };
    expect(() =>
      defineGraph({
        id: "edge_integrity_option_values_typed",
        nodes: { Item: { type: Item } },
        edges: { linksTo: registration },
      }),
    ).toThrow(ConfigurationError);
  });

  // Each public entry point that accepts an edge declaration. A generic
  // parameter (`defineGraph`'s `const TEdges`, `defineGraphExtension`'s
  // `const T`) infers the literal it is given, extra keys included, and an
  // inferred argument gets no excess-property check: only assignability to
  // the constraint is checked. So a removed property is refused there only if
  // the declared type itself rules the key out.
  it("refuses endpointExistence at compile time at every entry point that accepts an edge declaration", () => {
    expect(() =>
      defineGraph({
        id: "edge_integrity_option_values_inline",
        nodes: { Item: { type: Item } },
        edges: {
          linksTo: {
            type: linksTo,
            from: [Item],
            to: [Item],
            // @ts-expect-error -- the option was removed from EdgeRegistration
            endpointExistence: "ever",
          },
        },
      }),
    ).toThrow(ConfigurationError);

    const inferredRegistration = {
      type: linksTo,
      from: [Item],
      to: [Item],
      endpointExistence: "currentlyValid",
    } as const;
    expect(() =>
      defineGraph({
        id: "edge_integrity_option_values_inferred",
        nodes: { Item: { type: Item } },
        // @ts-expect-error -- the option was removed from EdgeRegistration
        edges: { linksTo: inferredRegistration },
      }),
    ).toThrow(ConfigurationError);

    expect(() =>
      defineGraphExtension({
        edges: {
          // @ts-expect-error -- an extension edge has no endpointExistence
          linksTo: { from: ["Item"], to: ["Item"], endpointExistence: "ever" },
        },
      }),
    ).toThrow(/endpointExistence/);

    const inferredExtension = {
      edges: {
        linksTo: { from: ["Item"], to: ["Item"], endpointExistence: "ever" },
      },
    } as const;
    function evolveWith(store: Store<ReturnType<typeof graphDeclaring>>) {
      // @ts-expect-error -- an extension edge has no endpointExistence
      return store.evolve(inferredExtension);
    }
    expect(evolveWith).toBeTypeOf("function");
  });

  // `cardinality: undefined` and its siblings state nothing; so does an
  // explicit `endpointExistence: undefined`, and its key must not survive
  // anywhere the graph's registrations are read from.
  it.each([
    { form: "target list", targets: {} },
    { form: "target map", targets: { to: { Item: [Item] } } },
  ])(
    "reads an explicit endpointExistence: undefined as unstated, and drops the key ($form)",
    async ({ targets }) => {
      const graph = graphDeclaring({
        ...targets,
        endpointExistence: undefined,
      });
      const registration = graph.edges.linksTo as Readonly<
        Record<string, unknown>
      >;
      const [store] = await createStoreWithSchema(graph, createTestBackend());
      const introspected = store
        .introspect()
        .edges.find((edge) => edge.name === "linksTo");

      expect(Object.keys(registration)).not.toContain("endpointExistence");
      expect(introspected).toBeDefined();
      expect(Object.keys(introspected ?? {})).not.toContain(
        "endpointExistence",
      );
      expect(serializeSchema(graph, 1).edges).toEqual(
        serializeSchema(graphDeclaring(targets), 1).edges,
      );
    },
  );

  it("reports no endpointExistence in store.introspect() for any edge", async () => {
    for (const statement of [
      {},
      { cardinality: "one" },
      { targetCardinality: "one" },
      { acyclic: true },
    ]) {
      const [store] = await createStoreWithSchema(
        graphDeclaring(statement),
        createTestBackend(),
      );
      const edges = store.introspect().edges;

      expect(edges.map((edge) => edge.name)).toEqual(["linksTo"]);
      for (const edge of edges) {
        expect(Object.keys(edge)).not.toContain("endpointExistence");
      }
    }
  });

  it("serializes the fixed endpointExistence field for every edge, whatever else is declared", () => {
    for (const statement of [{}, { cardinality: "one" }, { acyclic: true }]) {
      const document = serializeSchema(graphDeclaring(statement), 1);

      expect(document.edges["linksTo"]).toHaveProperty(
        "endpointExistence",
        "notDeleted",
      );
    }
  });

  it("accepts every declared value, and the schema it serializes loads again", () => {
    const statements = [
      {},
      ...CARDINALITY_VALUES.map((cardinality) => ({ cardinality })),
      ...TARGET_CARDINALITY_VALUES.map((targetCardinality) => ({
        targetCardinality,
      })),
      { acyclic: true },
      { acyclic: false },
    ];
    const reloadedDeclarations = statements.map((statement) => {
      const document = serializeSchema(graphDeclaring(statement), 1);
      const edge = parseSerializedSchema(JSON.stringify(document)).edges[
        "linksTo"
      ];
      return {
        cardinality: edge?.cardinality,
        targetCardinality: edge?.targetCardinality,
        acyclic: edge?.acyclic ?? false,
      };
    });

    expect(reloadedDeclarations).toEqual(
      statements.map((statement) => ({
        cardinality: "many",
        targetCardinality: "many",
        acyclic: false,
        ...statement,
      })),
    );
  });

  it("never opens a store whose declared acyclicity would go unenforced", async () => {
    const graph = defineGraph({
      id: "edge_integrity_option_values_acyclic",
      nodes: { Item: { type: Item } },
      edges: {
        linksTo: { type: linksTo, from: [Item], to: [Item], acyclic: true },
      },
    });
    const [store] = await createStoreWithSchema(graph, createTestBackend());
    const first = await store.nodes.Item.create({});
    const second = await store.nodes.Item.create({});
    await store.edges.linksTo.create(first, second, {});

    await expect(
      store.edges.linksTo.create(second, first, {}),
    ).rejects.toMatchObject({ name: "EdgeAcyclicityError" });
    expect(refusalOf({ acyclic: "yes" })).toBeInstanceOf(ConfigurationError);
  });
});
