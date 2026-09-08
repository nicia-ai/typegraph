/**
 * C.2/R2 gap fix: `computeSchemaDiff` reports an incompatible
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

import { ConfigurationError } from "../src/errors";
import { computeSchemaDiff } from "../src/schema/migration";
import {
  type SerializedOntology,
  type SerializedSchema,
} from "../src/schema/types";

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
    // still >= Tight's minLength 5, so the hierarchy stays valid) —
    // byte-identical `before`/`after` node definitions would make
    // `nodePropertyChangeMayAffectExistingSubsumption` see `changedKinds.size
    // === 0` and never build the registry at all, certifying nothing.
    const before = schemaWithLooseCode(true);
    const after = { ...schemaWithLooseCode(true, 10), version: 2 };
    expect(before.nodes["Loose"]).not.toEqual(after.nodes["Loose"]);

    expect(() => computeSchemaDiff(before, after)).not.toThrow();
  });
});
