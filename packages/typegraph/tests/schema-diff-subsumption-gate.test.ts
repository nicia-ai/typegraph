/**
 * Gap fix: `computeSchemaDiff` reports an incompatible
 * `subClassOf`/`equivalentTo` hierarchy even when the diff touches NO
 * relation at all — only a node kind's PROPERTY schema, on a kind that
 * already participates in an existing hierarchy.
 *
 * `classifyOntologyChanges` short-circuits before building any registry
 * when no relation changed (`src/schema/ontology-change.ts`), so without
 * this gate a migration that only edits a child kind's properties would
 * pass `getSchemaChanges`/`requiresMigration` and fail only at commit.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, subClassOf } from "../src";
import { ConfigurationError } from "../src/errors";
import { getSchemaChanges, requiresMigration } from "../src/schema";
import { computeSchemaDiff } from "../src/schema/migration";
import { computeSchemaHash, serializeSchema } from "../src/schema/serializer";
import {
  type SerializedOntology,
  type SerializedSchema,
} from "../src/schema/types";
import { createTestBackend, matchingObject } from "./test-utils";

function emptyOntology(
  relations: SerializedOntology["relations"] = [],
): SerializedOntology {
  return {
    metaEdges: {},
    relations,
    closures: {
      subClassAncestors: {},
      subClassDescendants: {},
      broaderClosure: {},
      narrowerClosure: {},
      equivalenceSets: {},
      disjointPairs: [],
      partOfClosure: {},
      hasPartClosure: {},
      iriToKind: {},
      edgeInverses: {},
      edgeImplicationsClosure: {},
      edgeImplyingClosure: {},
    },
  };
}

function schemaWithLooseCode(
  looseHasMinLength: boolean,
  looseMinLength = 5,
): SerializedSchema {
  return {
    graphId: "subsumption_gate_test",
    version: 1,
    generatedAt: "2024-01-01T00:00:00Z",
    nodes: {
      Loose: {
        kind: "Loose",
        properties: {
          type: "object",
          properties: {
            code:
              looseHasMinLength ?
                { type: "string", minLength: looseMinLength }
              : { type: "string" },
          },
          required: ["code"],
          additionalProperties: false,
        },
        uniqueConstraints: [],
        onDelete: "restrict",
        description: undefined,
      },
      Tight: {
        kind: "Tight",
        properties: {
          type: "object",
          properties: { code: { type: "string", minLength: 5 } },
          required: ["code"],
          additionalProperties: false,
        },
        uniqueConstraints: [],
        onDelete: "restrict",
        description: undefined,
      },
    },
    edges: {},
    ontology: emptyOntology([
      { metaEdge: "subClassOf", from: "Loose", to: "Tight" },
    ]),
    defaults: { onNodeDelete: "restrict", temporalMode: "current" },
  };
}

describe("computeSchemaDiff — property-only change against an existing hierarchy", () => {
  it("refuses when a migration relaxes a child's property, breaking an UNCHANGED subClassOf relation", () => {
    const before = schemaWithLooseCode(true);
    const after = { ...schemaWithLooseCode(false), version: 2 };

    // The relation itself is byte-identical on both sides — only Loose's
    // properties changed.
    expect(before.ontology.relations).toEqual(after.ontology.relations);

    expect(() => computeSchemaDiff(before, after)).toThrow(ConfigurationError);
  });

  it("does not throw when the child's property change keeps the hierarchy valid", () => {
    // `after` genuinely changes Loose's `code` property (minLength 5 -> 10,
    // still >= Tight's minLength 5, so the hierarchy stays valid).
    const before = schemaWithLooseCode(true);
    const after = { ...schemaWithLooseCode(true, 10), version: 2 };
    expect(before.nodes["Loose"]).not.toEqual(after.nodes["Loose"]);

    expect(() => computeSchemaDiff(before, after)).not.toThrow();
  });
});

/**
 * The pre-upgrade report: a deployment whose stored document and graph are
 * IDENTICAL, carrying a hierarchy an earlier release accepted and this one
 * refuses. Nothing changed, so no relation-level or property-level trigger
 * fires — the diff must hold the proposed graph to the contract regardless.
 *
 * LOAD-BEARING CHECK: gating the AFTER-side registry build on a changed node
 * kind again makes `computeSchemaDiff` return "No changes" and
 * `getSchemaChanges` resolve, failing all three cases.
 */
describe("an unchanged graph whose existing hierarchy is refused", () => {
  it("is refused by computeSchemaDiff with nothing to diff", () => {
    const stored = schemaWithLooseCode(false);

    expect(() => computeSchemaDiff(stored, { ...stored, version: 2 })).toThrow(
      expect.objectContaining({
        details: matchingObject({
          code: "ONTOLOGY_SUBCLASS_NOT_STRUCTURAL_SUBTYPE",
          childKind: "Loose",
          parentKind: "Tight",
        }),
      }),
    );
  });

  const Tight = defineNode("Tight", {
    schema: z.object({ code: z.string().min(5) }),
  });
  const Loose = defineNode("Loose", { schema: z.object({ code: z.string() }) });
  // The typed `subClassOf` factory refuses this pair at compile time; an
  // earlier release accepted it, so the cast stands in for that release.
  const storedRelation = subClassOf(Loose as unknown as typeof Tight, Tight);

  async function seedUnchangedDeployment() {
    const backend = createTestBackend();
    // Exactly the document the graph serializes to, so the diff has no node
    // change to notice the hierarchy through.
    const stored = serializeSchema(unchangedGraph(), 1);
    await backend.commitSchemaVersion({
      graphId: stored.graphId,
      expected: { kind: "initial" },
      version: stored.version,
      schemaHash: await computeSchemaHash(stored),
      schemaDoc: stored,
    });
    return backend;
  }

  function unchangedGraph() {
    // `defineGraph` validates lazily; only the schema entry points are asked.
    return defineGraph({
      id: "preupgrade",
      nodes: { Loose: { type: Loose }, Tight: { type: Tight } },
      edges: {},
      ontology: [storedRelation],
    });
  }

  it("is reported by getSchemaChanges before the upgrade", async () => {
    const backend = await seedUnchangedDeployment();

    const outcome = await getSchemaChanges(backend, unchangedGraph()).then(
      (diff) => `resolved: ${diff?.summary ?? "no schema"}`,
      (error: unknown) => error,
    );

    console.log("getSchemaChanges on an unchanged refused hierarchy:", outcome);
    expect(outcome).toBeInstanceOf(ConfigurationError);
    expect((outcome as ConfigurationError).details).toMatchObject({
      code: "ONTOLOGY_SUBCLASS_NOT_STRUCTURAL_SUBTYPE",
      childKind: "Loose",
      parentKind: "Tight",
    });
  });

  it("routes requiresMigration to the privileged path", async () => {
    const backend = await seedUnchangedDeployment();

    expect(await requiresMigration(backend, unchangedGraph())).toBe(true);
  });
});
