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
} from "../src";
import type { EdgeRegistration } from "../src/core";
import {
  CARDINALITY_VALUES,
  TARGET_CARDINALITY_VALUES,
} from "../src/core/edge-integrity-options";
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
    expectTypeOf<EdgeRegistration>().not.toHaveProperty("endpointExistence");
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
