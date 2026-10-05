/**
 * FINDING attach-refusal-orphan-part-in-enclosing-tx.
 *
 * The composition changeset promises that a node create naming a dead or
 * missing whole, or losing the whole-side claim, "aborts the node create too,
 * leaving no orphan row". Inside an enclosing `store.transaction` whose caller
 * catches the typed refusal, the part row written before the attachment is
 * still there: a required-existence part with no whole.
 *
 * Correct behavior: a refused create/get-or-create with `partOf` leaves no part
 * row, so `verifyConstraintFences()` reports no `compositionExistence`
 * violation after the caught refusal.
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

const Show = defineNode("Show", { schema: z.object({}) });
const Clip = defineNode("Clip", { schema: z.object({ slug: z.string() }) });
const clipOf = defineEdge("clipOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "audit_attach_orphan",
  nodes: {
    Show: { type: Show },
    Clip: {
      type: Clip,
      unique: [
        { name: "clip_slug", fields: ["slug"], scope: "kind", collation: "binary" },
      ],
    },
  },
  edges: {
    clipOf: { type: clipOf, from: [Clip], to: [Show], cardinality: "oneActive" },
  },
  ontology: [partOf(Clip, Show, { via: clipOf, existence: "required" })],
});

const MISSING_WHOLE = { kind: "Show", id: "does-not-exist" } as const;

type Store = Awaited<ReturnType<typeof createStoreWithSchema<typeof graph>>>[0];

const ENTRY_POINTS: readonly (readonly [string, (tx: Store) => Promise<unknown>])[] = [
  [
    "create",
    (tx) =>
      tx.nodes.Clip.create({ slug: "a" }, {
        partOf: { whole: MISSING_WHOLE, via: "clipOf" },
      } as never),
  ],
  [
    "bulkCreate",
    (tx) =>
      tx.nodes.Clip.bulkCreate([
        { props: { slug: "b" }, partOf: { whole: MISSING_WHOLE, via: "clipOf" } },
      ] as never),
  ],
  [
    "getOrCreateByConstraint",
    (tx) =>
      tx.nodes.Clip.getOrCreateByConstraint("clip_slug", { slug: "c" }, {
        partOf: { whole: MISSING_WHOLE, via: "clipOf" },
      } as never),
  ],
];

describe("attach-refusal-orphan-part-in-enclosing-tx", () => {
  it("leaves no unattached required part after a caught attach refusal", async () => {
    const leaking: string[] = [];
    for (const [name, write] of ENTRY_POINTS) {
      const [store] = await createStoreWithSchema(graph, createTestBackend());
      await store.transaction(async (tx) => {
        await write(tx as never).catch(() => undefined);
      });
      const violations = await store.verifyConstraintFences();
      if (violations.some((violation) => violation.family === "compositionExistence")) {
        leaking.push(name);
      }
    }
    expect(leaking).toEqual([]);
  });
});
