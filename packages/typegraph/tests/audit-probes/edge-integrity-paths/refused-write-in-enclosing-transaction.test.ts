/**
 * Contract B: after a REFUSED operation the stored graph still satisfies its
 * declared constraints, including when the caller catches the refusal inside
 * an enclosing `store.transaction(...)` and lets that transaction commit.
 *
 * `store.verifyConstraintFences()` is the oracle.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../../src";
import { createTestBackend } from "../../test-utils";

const Section = defineNode("Section", { schema: z.object({}) });
const Leaf = defineNode("Leaf", {
  schema: z.object({ slug: z.string() }),
});
const sectionIn = defineEdge("sectionIn", { schema: z.object({}) });
const leafIn = defineEdge("leafIn", { schema: z.object({}) });
const compositionGraph = defineGraph({
  id: "audit_edge_refusal_composition",
  nodes: {
    Section: { type: Section },
    Leaf: {
      type: Leaf,
      unique: [
        {
          name: "leaf_slug",
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    sectionIn: {
      type: sectionIn,
      from: [Section],
      to: [Section],
      cardinality: "one",
    },
    leafIn: { type: leafIn, from: [Leaf], to: [Section], cardinality: "one" },
  },
  ontology: [
    partOf(Section, Section, { via: sectionIn, partSide: "from" }),
    partOf(Leaf, Section, { via: leafIn, existence: "required" }),
  ],
});

async function refusalOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("refused writes caught inside an enclosing transaction", () => {
  it("composition-batch-attach-acyclicity-refusal-leaves-cycle", async () => {
    const leftBehind: string[] = [];
    for (const variant of ["bulkCreate", "bulkInsert"] as const) {
      const store = createStore(compositionGraph, createTestBackend());
      const items = [
        {
          props: {},
          id: "a",
          partOf: { whole: { kind: "Section", id: "b" } },
        },
        {
          props: {},
          id: "b",
          partOf: { whole: { kind: "Section", id: "a" } },
        },
      ] as const;

      let refusal: unknown;
      await store.transaction(async (tx) => {
        refusal = await refusalOf(async () => {
          if (variant === "bulkCreate") {
            await tx.nodes.Section.bulkCreate(items);
          } else {
            await tx.nodes.Section.bulkInsert(items);
          }
        });
      });

      expect(refusal, `${variant} must be refused`).toBeDefined();
      const violations = await store.verifyConstraintFences();
      if (violations.length > 0) leftBehind.push(variant);
    }
    expect(leftBehind).toEqual([]);
  });

  it("required-part-create-refused-attach-leaves-orphan", async () => {
    const leftBehind: string[] = [];
    const variants = [
      "create",
      "bulkCreate",
      "bulkInsert",
      "getOrCreateByConstraint",
    ] as const;
    for (const variant of variants) {
      const store = createStore(compositionGraph, createTestBackend());
      const deadWhole = await store.nodes.Section.create({});
      await store.nodes.Section.delete(deadWhole.id);
      const whole = { kind: "Section" as const, id: deadWhole.id };

      let refusal: unknown;
      await store.transaction(async (tx) => {
        refusal = await refusalOf(async () => {
          switch (variant) {
            case "create": {
              await tx.nodes.Leaf.create({ slug: "x" }, { partOf: { whole } });
              break;
            }
            case "bulkCreate": {
              await tx.nodes.Leaf.bulkCreate([
                { props: { slug: "x" }, partOf: { whole } },
              ]);
              break;
            }
            case "bulkInsert": {
              await tx.nodes.Leaf.bulkInsert([
                { props: { slug: "x" }, partOf: { whole } },
              ] as never);
              break;
            }
            case "getOrCreateByConstraint": {
              await tx.nodes.Leaf.getOrCreateByConstraint(
                "leaf_slug",
                { slug: "x" },
                { partOf: { whole } },
              );
              break;
            }
          }
        });
      });

      expect(refusal, `${variant} must be refused`).toBeDefined();
      const violations = await store.verifyConstraintFences();
      if (violations.length > 0) leftBehind.push(variant);
    }
    expect(leftBehind).toEqual([]);
  });
});
