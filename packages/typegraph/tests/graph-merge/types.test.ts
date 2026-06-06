import { defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { canonicalizeProps } from "../../src/graph-merge/canonical-props";
import { MERGE_OPTION_DEFAULTS, normalizeMergeOptions } from "../../src/graph-merge/options";
import type {
  BranchId,
  MergeOptions,
  ResolveConfig,
  ResolvedCluster,
  SimilarityStrategy,
} from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";

// A real 2-kind graph so the merge generics resolve against actual TypeGraph
// type machinery (not a stub) — this is the "generics resolve against a real
// defineGraph" acceptance gate.
const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), birthDate: z.string() }),
});

const Provider = defineNode("Provider", {
  schema: z.object({ organization: z.string() }),
});

const treats = defineEdge("treats", {
  schema: z.object({ since: z.string() }),
  from: [Provider],
  to: [Patient],
});

const graph = defineGraph({
  id: "merge-types-test",
  nodes: { Patient: { type: Patient }, Provider: { type: Provider } },
  edges: { treats: { type: treats, from: [Provider], to: [Patient] } },
});

type G = typeof graph;

describe("sample graph", () => {
  it("constructs a real 2-kind graph the merge generics bind against", () => {
    expect(graph.id).toBe("merge-types-test");
    expect(Object.keys(graph.nodes).sort()).toEqual(["Patient", "Provider"]);
    expect(Object.keys(graph.edges)).toEqual(["treats"]);
  });
});

describe("canonicalizeProps", () => {
  it("is identical for key-shuffled equivalent objects", () => {
    const a = canonicalizeProps({ name: "Anna", birthDate: "1990-01-02" });
    const b = canonicalizeProps({ birthDate: "1990-01-02", name: "Anna" });
    expect(a).toBe(b);
  });

  it("recursively sorts nested object keys", () => {
    const a = canonicalizeProps({
      outer: { z: 1, a: 2 },
      first: { nested: { y: 3, x: 4 } },
    });
    const b = canonicalizeProps({
      first: { nested: { x: 4, y: 3 } },
      outer: { a: 2, z: 1 },
    });
    expect(a).toBe(b);
  });

  it("differs when any value differs", () => {
    const a = canonicalizeProps({ name: "Anna", birthDate: "1990-01-02" });
    const b = canonicalizeProps({ name: "Ana", birthDate: "1990-01-02" });
    expect(a).not.toBe(b);
  });

  it("preserves array order (order is semantically meaningful)", () => {
    const a = canonicalizeProps({ tags: ["x", "y"] });
    const b = canonicalizeProps({ tags: ["y", "x"] });
    expect(a).not.toBe(b);
  });

  it("treats an undefined-valued key as absent", () => {
    const withKey = canonicalizeProps({ name: "Anna", note: undefined });
    const withoutKey = canonicalizeProps({ name: "Anna" });
    expect(withKey).toBe(withoutKey);
  });

  it("operates on the parsed object, not its JSON string form", () => {
    // The contract: callers pass parsed objects. A round-trip through JSON must
    // therefore be a no-op on the canonical output.
    const parsed = { birthDate: "2000-12-31", name: "Bob" };
    const fromParsed = canonicalizeProps(parsed);
    const fromReparsed = canonicalizeProps(
      JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>,
    );
    expect(fromParsed).toBe(fromReparsed);
  });
});

describe("normalizeMergeOptions defaults", () => {
  it("applies every frozen default when given no options", () => {
    const normalized = normalizeMergeOptions<G>();
    expect(normalized.reconcileTypes).toBe(
      MERGE_OPTION_DEFAULTS.reconcileTypes,
    );
    expect(normalized.onPropertyConflict).toBe(
      MERGE_OPTION_DEFAULTS.onPropertyConflict,
    );
    expect(normalized.onDeleteModifyConflict).toBe(
      MERGE_OPTION_DEFAULTS.onDeleteModifyConflict,
    );
    expect(normalized.onComparisonCeiling).toBe(
      MERGE_OPTION_DEFAULTS.onComparisonCeiling,
    );
    expect(normalized.provenance).toBe(MERGE_OPTION_DEFAULTS.provenance);
    expect(normalized.resolve).toEqual({});
    expect(normalized.maxComparisonsPerKind).toBeUndefined();
    expect(normalized.clusterMaxDiameter).toBeUndefined();
    expect(normalized.canonical).toBeUndefined();
    expect(normalized.target).toBeUndefined();
    expect(normalized.branchOrder).toBeUndefined();
  });

  it("preserves explicitly-provided scalar options over defaults", () => {
    const branchOrder: readonly BranchId[] = [
      asBranchId("b3"),
      asBranchId("b1"),
    ];
    const normalized = normalizeMergeOptions<G>({
      reconcileTypes: "ontology",
      onDeleteModifyConflict: "deleteWins",
      onComparisonCeiling: "mergeByIdOnly",
      provenance: false,
      maxComparisonsPerKind: 100,
      clusterMaxDiameter: 0.5,
      branchOrder,
    });
    expect(normalized.reconcileTypes).toBe("ontology");
    expect(normalized.onDeleteModifyConflict).toBe("deleteWins");
    expect(normalized.onComparisonCeiling).toBe("mergeByIdOnly");
    expect(normalized.provenance).toBe(false);
    expect(normalized.maxComparisonsPerKind).toBe(100);
    expect(normalized.clusterMaxDiameter).toBe(0.5);
    expect(normalized.branchOrder).toEqual(branchOrder);
  });

  it("threads a function onPropertyConflict and canonical selector through", () => {
    const canonical = (cluster: ResolvedCluster) => cluster.members[0]!;
    const normalized = normalizeMergeOptions<G>({
      onPropertyConflict: (conflict) => conflict.resolution,
      canonical,
    });
    expect(typeof normalized.onPropertyConflict).toBe("function");
    expect(normalized.canonical).toBe(canonical);
  });
});

describe("normalizeMergeOptions validation", () => {
  it("rejects a per-kind threshold above 1", () => {
    expect(() =>
      normalizeMergeOptions<G>({
        resolve: {
          Patient: {
            similarity: { kind: "fulltext", fields: ["name"] },
            threshold: 1.5,
          },
        },
      }),
    ).toThrow(/threshold/);
  });

  it("rejects a per-kind threshold below 0", () => {
    expect(() =>
      normalizeMergeOptions<G>({
        resolve: {
          Patient: {
            similarity: { kind: "fulltext", fields: ["name"] },
            threshold: -0.1,
          },
        },
      }),
    ).toThrow(/threshold/);
  });

  it("accepts threshold boundaries 0 and 1", () => {
    expect(() =>
      normalizeMergeOptions<G>({
        resolve: {
          Patient: {
            similarity: { kind: "fulltext", fields: ["name"] },
            threshold: 0,
          },
          Provider: {
            similarity: { kind: "fulltext", fields: ["organization"] },
            threshold: 1,
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects a negative maxComparisonsPerKind", () => {
    expect(() =>
      normalizeMergeOptions<G>({ maxComparisonsPerKind: -1 }),
    ).toThrow(/maxComparisonsPerKind/);
  });

  it("rejects a non-integer maxComparisonsPerKind", () => {
    expect(() =>
      normalizeMergeOptions<G>({ maxComparisonsPerKind: 2.5 }),
    ).toThrow(/maxComparisonsPerKind/);
  });

  it("rejects a non-positive clusterMaxDiameter", () => {
    expect(() => normalizeMergeOptions<G>({ clusterMaxDiameter: 0 })).toThrow(
      /clusterMaxDiameter/,
    );
  });

  it("keeps the validated resolve map intact", () => {
    const normalized = normalizeMergeOptions<G>({
      resolve: {
        Patient: {
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 0.85,
        },
      },
    });
    expect(normalized.resolve.Patient?.threshold).toBe(0.85);
    expect(normalized.resolve.Patient?.similarity.kind).toBe("fulltext");
  });
});

describe("strategy + option types resolve against a real defineGraph", () => {
  it("typechecks a custom score strategy bound to the Patient kind", () => {
    // The custom score function receives Node<Patient> instances; accessing
    // schema fields proves the generic binding is real, not erased.
    const custom: SimilarityStrategy<G, typeof Patient> = {
      kind: "custom",
      score: (a, b) =>
        a.name === b.name && a.birthDate === b.birthDate ? 1 : 0,
    };
    expect(custom.kind).toBe("custom");
    if (custom.kind === "custom") {
      const left = {
        kind: "Patient" as const,
        id: "n1",
        name: "Anna",
        birthDate: "1990-01-02",
        meta: {},
      } as unknown as Parameters<typeof custom.score>[0];
      const right = {
        kind: "Patient" as const,
        id: "n2",
        name: "Anna",
        birthDate: "1990-01-02",
        meta: {},
      } as unknown as Parameters<typeof custom.score>[1];
      expect(custom.score(left, right)).toBe(1);
    }
  });

  it("typechecks a fulltext strategy in a ResolveConfig", () => {
    const config: ResolveConfig<G, typeof Patient> = {
      block: (node) => node.birthDate,
      similarity: { kind: "fulltext", fields: ["name"] },
      threshold: 0.85,
    };
    expect(config.similarity.kind).toBe("fulltext");
    expect(config.threshold).toBe(0.85);
  });

  it("accepts a fulltext + custom resolve map as MergeOptions", () => {
    const options: MergeOptions<G> = {
      resolve: {
        Patient: {
          similarity: { kind: "fulltext", fields: ["name", "birthDate"] },
          threshold: 0.85,
        },
        Provider: {
          similarity: {
            kind: "custom",
            score: (a, b) => (a.organization === b.organization ? 1 : 0),
          },
          threshold: 0.9,
        },
      },
      reconcileTypes: "ontology",
      onPropertyConflict: "flag",
    };
    const normalized = normalizeMergeOptions(options);
    expect(Object.keys(normalized.resolve).sort()).toEqual([
      "Patient",
      "Provider",
    ]);
  });
});
