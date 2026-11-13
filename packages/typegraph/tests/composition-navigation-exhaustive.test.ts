/**
 * The decision between an exhaustive closure and a stated hop bound for
 * `parts()` / `wholes()`, observed on the query AST: the end-to-end behavior
 * (a chain past the old ceiling comes back whole) lives in the shared
 * cross-backend composition-navigation suite.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../src";
import { type VariableLengthSpec } from "../src/query/ast";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Section = defineNode("Section", { schema: z.object({}) });
const parentSection = defineEdge("parentSection", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition_navigation_exhaustive",
  nodes: { Section: { type: Section } },
  edges: {
    parentSection: {
      type: parentSection,
      from: [Section],
      to: [Section],
      cardinality: "one",
    },
  },
  ontology: [
    partOf(Section, Section, { via: parentSection, partSide: "from" }),
  ],
});

type NavigationOptions = Readonly<{
  maxHops?: number;
  depth?: boolean;
  path?: boolean;
}>;

function partsTraversal(options?: NavigationOptions): VariableLengthSpec {
  const store = createStore(graph, createTestBackend());
  const ast = store
    .query()
    .from("Section", "s")
    .parts("x", options)
    .select((ctx) => ctx.x.id)
    .toAst();
  return requireDefined(
    ast.traversals.find((traversal) => traversal.nodeAlias === "x")
      ?.variableLength,
  );
}

function wholesTraversal(options?: NavigationOptions): VariableLengthSpec {
  const store = createStore(graph, createTestBackend());
  const ast = store
    .query()
    .from("Section", "s")
    .wholes("x", options)
    .select((ctx) => ctx.x.id)
    .toAst();
  return requireDefined(
    ast.traversals.find((traversal) => traversal.nodeAlias === "x")
      ?.variableLength,
  );
}

describe.each([
  { name: "parts()", traversal: partsTraversal },
  { name: "wholes()", traversal: wholesTraversal },
])("$name with and without a stated maxHops", ({ traversal }) => {
  it.each([
    { label: "no options", options: undefined },
    { label: "a depth column", options: { depth: true } },
    { label: "a path column", options: { path: true } },
  ])("is exhaustive and states no hop bound with $label", ({ options }) => {
    expect(traversal(options)).toMatchObject({
      exhaustive: true,
      maxDepth: -1,
      cyclePolicy: "prevent",
    });
  });

  it.each([1, 5, 1000])(
    "applies a stated maxHops of %i exactly and is not exhaustive",
    (maxHops) => {
      const spec = traversal({ maxHops, depth: true });

      expect(spec.maxDepth).toBe(maxHops);
      expect(spec.exhaustive).toBeUndefined();
    },
  );
});
// MUTATION CHECK: make `TraversalBuilder#recursive` keep `exhaustive` when a
// `maxHops` is stated (drop the `options?.maxHops === undefined &&` clause) and
// the stated-bound rows fail. Pass no exhaustive state from `navigateComposition`
// and the unbounded rows fail. `recursive()` is the single owner of the decision.
