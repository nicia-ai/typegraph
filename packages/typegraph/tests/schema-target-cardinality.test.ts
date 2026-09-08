/**
 * Schema serialization, hashing, introspection and diffing for
 * `targetCardinality` (issue #610, §6).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import {
  computeSchemaDiff,
  computeSchemaHash,
  deserializeSchema,
  serializeSchema,
} from "../src/schema";
import { parseSerializedSchema } from "../src/schema/manager";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Person = defineNode("SchemaTcPerson", { schema: z.object({}) });
const knows = defineEdge("schemaTcKnows", { schema: z.object({}) });

function buildGraph(targetCardinality?: "many" | "one" | "oneActive") {
  return defineGraph({
    id: "schema_target_cardinality",
    nodes: { SchemaTcPerson: { type: Person } },
    edges: {
      schemaTcKnows: {
        type: knows,
        from: [Person],
        to: [Person],
        ...(targetCardinality === undefined ? {} : { targetCardinality }),
      },
    },
  });
}

describe("targetCardinality serialization", () => {
  it("serializes the declared value", () => {
    const serialized = serializeSchema(buildGraph("one"), 1);
    expect(serialized.edges["schemaTcKnows"]?.targetCardinality).toBe("one");
  });

  it("defaults to many when undeclared", () => {
    const serialized = serializeSchema(buildGraph(), 1);
    expect(serialized.edges["schemaTcKnows"]?.targetCardinality).toBe("many");
  });

  it("round-trips through deserializeSchema", () => {
    const serialized = serializeSchema(buildGraph("oneActive"), 1);
    const deserialized = deserializeSchema(serialized);
    const edge = deserialized.getEdge("schemaTcKnows");
    expect(edge?.targetCardinality).toBe("oneActive");
  });

  it("loads a document stored before this option existed as many", () => {
    // Simulates a pre-D.1 stored document: no `targetCardinality` key at
    // all, parsed through the SAME zod schema a read from the database
    // goes through — `.default("many")` is what makes the loose record
    // resolve the absent key instead of dropping it silently.
    const serialized = serializeSchema(buildGraph(), 1) as Record<
      string,
      unknown
    >;
    const edges = serialized["edges"] as Record<
      string,
      Record<string, unknown>
    >;
    delete requireDefined(edges["schemaTcKnows"])["targetCardinality"];
    const parsed = parseSerializedSchema(JSON.stringify(serialized));
    const deserialized = deserializeSchema(parsed);
    expect(deserialized.getEdge("schemaTcKnows")?.targetCardinality).toBe(
      "many",
    );
  });
  // MUTATION CHECK (verified): remove `.default("many")` from the
  // `targetCardinality` line in `serializedSchemaZod` (`src/schema/types.ts`).
  // This test fails with `targetCardinality` reading `undefined`.
});

describe("targetCardinality and the schema hash", () => {
  it("hashes differently when only targetCardinality differs", async () => {
    const hashMany = await computeSchemaHash(serializeSchema(buildGraph(), 1));
    const hashOne = await computeSchemaHash(
      serializeSchema(buildGraph("one"), 1),
    );
    expect(hashOne).not.toBe(hashMany);
  });

  it("hashes identically for two schemas with the same targetCardinality", async () => {
    const first = await computeSchemaHash(
      serializeSchema(buildGraph("one"), 1),
    );
    const second = await computeSchemaHash(
      serializeSchema(buildGraph("one"), 1),
    );
    expect(first).toBe(second);
  });
  // MUTATION CHECK (verified): drop `targetCardinality` from
  // `serializeEdgeDef` (`src/schema/serializer.ts`). Both hash tests above
  // fail — the "differs" test because the two hashes become equal.
});

describe("targetCardinality introspection", () => {
  it("reports the declared value", async () => {
    const [store] = await createStoreWithSchema(
      buildGraph("one"),
      createTestBackend(),
    );
    const edge = store
      .introspect()
      .edges.find((candidate) => candidate.name === "schemaTcKnows");
    expect(edge?.targetCardinality).toBe("one");
  });

  it("reports many when undeclared", async () => {
    const [store] = await createStoreWithSchema(
      buildGraph(),
      createTestBackend(),
    );
    const edge = store
      .introspect()
      .edges.find((candidate) => candidate.name === "schemaTcKnows");
    expect(edge?.targetCardinality).toBe("many");
  });
  // MUTATION CHECK (verified): drop the `targetCardinality: reg
  // .targetCardinality ?? "many"` line from `introspectSchema`
  // (`src/store/introspect.ts`). Both tests above fail with
  // `edge?.targetCardinality` reading `undefined`.
});

describe("targetCardinality diffing", () => {
  it("classifies a targetCardinality change as a modified/warning edge change", () => {
    const before = serializeSchema(buildGraph(), 1);
    const after = serializeSchema(buildGraph("one"), 2);
    const diff = computeSchemaDiff(before, after);
    const change = diff.edges.find(
      (candidate) => candidate.kind === "schemaTcKnows",
    );
    expect(change).toBeDefined();
    expect(change?.type).toBe("modified");
    expect(change?.severity).toBe("warning");
    expect(change?.details).toContain("Target cardinality");
  });

  it("reports no edge change when targetCardinality is unchanged", () => {
    const before = serializeSchema(buildGraph("one"), 1);
    const after = serializeSchema(buildGraph("one"), 2);
    const diff = computeSchemaDiff(before, after);
    expect(
      diff.edges.some((candidate) => candidate.kind === "schemaTcKnows"),
    ).toBe(false);
  });
  // MUTATION CHECK (verified): remove the `targetCardinality` sibling block
  // from `diffEdgeDef` (`src/schema/migration.ts`). The first test above
  // fails (`change` is `undefined`).
});
