/**
 * Step 3 contract: the `baseUnique` candidate source (design §6.2) — the first
 * NEW-vs-BASE source.
 *
 * Against a committed base store, for each declared unique constraint, it batch-looks
 * up the staged new nodes via `bulkFindByConstraint` and, per hit, emits:
 *
 *   - a FORCED edge between the staged node and the committed base node
 *     (definitional — a shared unique value is the same entity), and
 *   - a BASE MEMBER built from the returned committed node (props stripped of the
 *     system fields, origin "base"), with no second fetch.
 *
 * Misses emit nothing; a base node matched by several staged nodes yields ONE
 * deduped base member. Runs on BOTH backends (new-vs-base semantics parity).
 */

import type { GraphBackend, Node, NodeType } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { idOf, type MergeKey } from "../../src/graph-merge/node-key";
import { FORCED_MATCH_SCORE } from "../../src/graph-merge/scoring";
import type {
  BaseLookupStore,
  SourceScope,
} from "../../src/graph-merge/sources";
import { baseUniqueSource } from "../../src/graph-merge/sources";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), mrn: z.string() }),
});

const careGraph = defineGraph({
  id: "base-unique-care",
  nodes: {
    Patient: {
      type: Patient,
      unique: [
        {
          name: "mrn_unique",
          fields: ["mrn"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

/** A staged NEW node in its spread runtime shape (props at the top level). */
function stagedPatient(id: string, name: string, mrn: string): Node<NodeType> {
  return { kind: "Patient", id, name, mrn } as unknown as Node<NodeType>;
}

/**
 * Sorts bare `a|b` edge keys for stable comparison. `idOf` projects a composite
 * `(kind, id)` endpoint to its bare id and is a no-op on a plain id, so this accepts
 * both the produced forced edges and the bare-id expectation literals below.
 */
function edgeKeys(
  edges: readonly Readonly<{ a: string; b: string }>[],
): string[] {
  return edges
    .map((edge) => `${idOf(edge.a as MergeKey)}|${idOf(edge.b as MergeKey)}`)
    .sort();
}

describe.each(backendMatrix())("baseUnique source [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  afterEach(async () => {
    for (const cleanup of cleanups ?? []) {
      await cleanup();
    }
    cleanups = [];
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  async function scopeOver(
    nodes: readonly Node<NodeType>[],
  ): Promise<SourceScope> {
    const [base] = await createStoreWithSchema(careGraph, await makeBackend());
    // The committed base: two distinct patients keyed by mrn.
    await base.nodes.Patient.bulkCreate([
      { id: "base-anna", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      { id: "base-bob", props: { name: "Bob Lee", mrn: "MRN-2" } },
    ]);
    const introspection = base.introspect();
    const uniqueConstraints =
      introspection.kinds.find((kind) => kind.name === "Patient")?.unique ?? [];
    return {
      kind: "Patient",
      blocks: new Map(),
      nodes,
      uniqueConstraints,
      store: base as unknown as BaseLookupStore,
    };
  }

  it("emits a forced edge + a base member for each unique-constraint hit", async () => {
    cleanups = [];
    const newAna = stagedPatient("new-ana", "Ana Rivera", "MRN-1"); // hits base-anna
    const newBob = stagedPatient("new-bobby", "Bobby L.", "MRN-2"); // hits base-bob
    const newCarol = stagedPatient("new-carol", "Carol King", "MRN-9"); // miss

    const scope = await scopeOver([newAna, newBob, newCarol]);
    const produced = await baseUniqueSource.generate(scope);

    console.info(
      `[${entry.name}] forced:`,
      produced.forcedEdges.map((e) => `${idOf(e.a)}|${idOf(e.b)}@${e.score}`),
    );
    console.info(
      `[${entry.name}] baseMembers:`,
      produced.baseMembers.map(
        (m) => `${m.id}:${m.origin}:${JSON.stringify(m.props)}`,
      ),
    );

    // One forced edge per hit (Carol misses), endpoints id-ordered.
    expect(edgeKeys(produced.forcedEdges)).toEqual(
      edgeKeys([
        { a: "base-anna", b: "new-ana" },
        { a: "base-bob", b: "new-bobby" },
      ]),
    );
    expect(
      produced.forcedEdges.every((e) => e.score === FORCED_MATCH_SCORE),
    ).toBe(true);
    expect(produced.pairs).toEqual([]);

    // One base member per matched committed node, origin "base", props stripped
    // of system fields (id/kind/meta) — proving no leak from the spread Node shape.
    const membersById = new Map(
      produced.baseMembers.map((m) => [m.id as string, m]),
    );
    expect([...membersById.keys()].sort()).toEqual(["base-anna", "base-bob"]);
    const anna = membersById.get("base-anna")!;
    expect(anna.origin).toBe("base");
    expect(anna.kind).toBe("Patient");
    expect(Object.keys(anna.props).sort()).toEqual(["mrn", "name"]);
    expect(anna.props).toEqual({ name: "Anna Rivera", mrn: "MRN-1" });
  });

  it("dedups a base node matched by several staged nodes into one base member", async () => {
    cleanups = [];
    // Two staged nodes share MRN-1 → both match base-anna.
    const dupA = stagedPatient("new-1", "Ana Rivera", "MRN-1");
    const dupB = stagedPatient("new-2", "A. Rivera", "MRN-1");

    const scope = await scopeOver([dupA, dupB]);
    const produced = await baseUniqueSource.generate(scope);

    // Two forced edges (each staged node ↔ base-anna), one deduped base member.
    expect(edgeKeys(produced.forcedEdges)).toEqual(
      edgeKeys([
        { a: "base-anna", b: "new-1" },
        { a: "base-anna", b: "new-2" },
      ]),
    );
    expect(produced.baseMembers).toHaveLength(1);
    expect(`${produced.baseMembers[0]?.id}`).toBe("base-anna");
  });

  it("emits nothing when no staged node matches a committed unique value", async () => {
    cleanups = [];
    const miss = stagedPatient("new-x", "Zoe Adams", "MRN-404");
    const scope = await scopeOver([miss]);
    const produced = await baseUniqueSource.generate(scope);
    expect(produced.forcedEdges).toEqual([]);
    expect(produced.baseMembers).toEqual([]);
  });

  it("throws if driven without the base-query scope inputs", async () => {
    cleanups = [];
    await expect(
      baseUniqueSource.generate({ kind: "Patient", blocks: new Map() }),
    ).rejects.toThrow(/requires nodes, uniqueConstraints, and store/);
  });
});
