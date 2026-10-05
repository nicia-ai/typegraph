/**
 * FINDING composition-claimless-cross-kind-two-wholes.
 *
 * A custom backend that declares no claim support "keeps the per-graph lock as
 * its only fence". For ordinary cardinality that is sound (the probe counts the
 * same edge kind the lock serializes), but "one whole per part" is a
 * relation-wide invariant across every realizing edge kind, and the portable
 * probe is per edge kind. With no claim row to collide on, a part attaches to a
 * second whole through the other realizing edge kind and nothing refuses it.
 *
 * Correct behavior: the second attach is refused (typed error), or the store
 * refuses the composition declaration up front on such a backend. Either way
 * the stored graph must hold no part with two wholes.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../../src";
import { createTestBackend } from "../../test-utils";
import { withoutClaimSupport } from "./harness";

const WholeA = defineNode("WholeA", { schema: z.object({}) });
const WholeB = defineNode("WholeB", { schema: z.object({}) });
const Part = defineNode("Part", { schema: z.object({}) });
const inWholeA = defineEdge("inWholeA", { schema: z.object({}) });
const inWholeB = defineEdge("inWholeB", { schema: z.object({}) });

const graph = defineGraph({
  id: "audit_claimless_cross_kind",
  nodes: {
    WholeA: { type: WholeA },
    WholeB: { type: WholeB },
    Part: { type: Part },
  },
  edges: {
    inWholeA: { type: inWholeA, from: [Part], to: [WholeA], cardinality: "one" },
    inWholeB: { type: inWholeB, from: [Part], to: [WholeB], cardinality: "one" },
  },
  ontology: [
    partOf(Part, WholeA, { via: inWholeA }),
    partOf(Part, WholeB, { via: inWholeB }),
  ],
});

describe("composition-claimless-cross-kind-two-wholes", () => {
  it("never leaves a part holding two wholes on a backend without claim support", async () => {
    const [store] = await createStoreWithSchema(
      graph,
      withoutClaimSupport(createTestBackend()),
    );
    const wholeA = await store.nodes.WholeA.create({});
    const wholeB = await store.nodes.WholeB.create({});
    const part = await store.nodes.Part.create({});
    await store.edges.inWholeA.create(part, wholeA, {});

    await store.edges.inWholeB.create(part, wholeB, {}).catch(() => undefined);

    const violations = await store.verifyConstraintFences();
    expect(
      violations.filter((violation) => violation.family === "composition"),
    ).toEqual([]);
  });
});
