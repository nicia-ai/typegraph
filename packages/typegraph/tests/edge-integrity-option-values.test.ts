/**
 * `cardinality`, `targetCardinality` and `acyclic` are refused at
 * `defineGraph` when stated outside their domain.
 *
 * Every reader of these options compares by string or strict boolean and
 * treats an unrecognized value as "undeclared", so an untyped caller's typo
 * would otherwise produce a graph whose declared constraint silently does not
 * hold, and a stored schema the loader's own enum rejects.
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
import {
  CARDINALITY_VALUES,
  TARGET_CARDINALITY_VALUES,
} from "../src/core/edge-integrity-options";
import { serializeSchema } from "../src/schema";
import { parseSerializedSchema } from "../src/schema/manager";
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
