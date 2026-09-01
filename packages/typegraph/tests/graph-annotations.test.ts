import { describe, expect, it } from "vitest";

import { defineGraph } from "../src/core/define-graph";
import { type GraphAnnotations } from "../src/core/types";
import { defineGraphExtension } from "../src/graph-extension";
import { mergeGraphExtension } from "../src/graph-extension/merge";
import {
  instantiateGraphTemplate,
  registerGraphTemplate,
} from "../src/schema/graph-templates";
import { parseSerializedSchema } from "../src/schema/manager";
import { computeSchemaDiff } from "../src/schema/migration";
import { computeSchemaHash, serializeSchema } from "../src/schema/serializer";
import {
  createAdapterStoreWithSchema,
  createStoreWithSchema,
} from "../src/store/store";
import { createTestBackend } from "./test-utils";

function graph(annotations?: GraphAnnotations) {
  return defineGraph({
    id: "graph_annotations",
    ...(annotations === undefined ? {} : { annotations }),
    nodes: {},
    edges: {},
  });
}

describe("graph-scoped annotations", () => {
  it("serializes and introspects graph metadata while preserving legacy hashes for empty annotations", async () => {
    const legacy = graph();
    const empty = graph({});
    const annotated = graph({
      displayName: "Research graph",
      capabilities: { search: true },
    });

    expect(serializeSchema(legacy, 1)).not.toHaveProperty("annotations");
    expect(serializeSchema(empty, 1)).not.toHaveProperty("annotations");
    await expect(computeSchemaHash(serializeSchema(empty, 1))).resolves.toBe(
      await computeSchemaHash(serializeSchema(legacy, 1)),
    );

    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(annotated, backend);
    expect(store.introspect().annotations).toEqual({
      displayName: "Research graph",
      capabilities: { search: true },
    });
  });

  it("classifies a graph-annotation-only change as safe", () => {
    const before = serializeSchema(graph({ displayName: "Before" }), 1);
    const after = serializeSchema(graph({ displayName: "After" }), 2);

    expect(computeSchemaDiff(before, after)).toMatchObject({
      annotations: { type: "modified", severity: "safe" },
      hasChanges: true,
      hasBreakingChanges: false,
      isBackwardsCompatible: true,
    });
  });

  it("shallow-merges extension annotations and replaces complete values", () => {
    const base = graph({
      displayName: "Base",
      capabilities: { search: true, audit: true },
    });
    const first = mergeGraphExtension(
      base,
      defineGraphExtension({
        annotations: {
          displayName: "Runtime",
          capabilities: { search: false },
        },
      }),
    );
    const second = mergeGraphExtension(
      first,
      defineGraphExtension({ annotations: { description: "Queryable" } }),
    );

    expect(second.annotations).toEqual({
      displayName: "Runtime",
      description: "Queryable",
      capabilities: { search: false },
    });
    expect(second.extension?.annotations).toEqual({
      displayName: "Runtime",
      description: "Queryable",
      capabilities: { search: false },
    });
  });

  it("owns an immutable annotation snapshot independent of caller mutation", async () => {
    const capabilities = { search: true, modes: ["semantic"] };
    const annotations = { displayName: "Original", capabilities };
    const defined = graph(annotations);
    const beforeHash = await computeSchemaHash(serializeSchema(defined, 1));

    annotations.displayName = "Mutated";
    capabilities.search = false;
    capabilities.modes.push("keyword");

    expect(defined.annotations).toEqual({
      displayName: "Original",
      capabilities: { search: true, modes: ["semantic"] },
    });
    expect(Object.isFrozen(defined.annotations)).toBe(true);
    expect(Object.isFrozen(defined.annotations?.["capabilities"])).toBe(true);
    await expect(computeSchemaHash(serializeSchema(defined, 1))).resolves.toBe(
      beforeHash,
    );
  });

  it("clones and deep-freezes extension annotations before merge", async () => {
    const capabilities = { search: true, modes: ["semantic"] };
    const authored = { displayName: "Runtime", capabilities };
    const extension = defineGraphExtension({ annotations: authored });
    const merged = mergeGraphExtension(graph(), extension);
    const beforeHash = await computeSchemaHash(serializeSchema(merged, 1));

    authored.displayName = "Mutated";
    capabilities.search = false;
    capabilities.modes.push("keyword");

    expect(extension.annotations).toEqual({
      displayName: "Runtime",
      capabilities: { search: true, modes: ["semantic"] },
    });
    expect(merged.annotations).toEqual(extension.annotations);
    expect(Object.isFrozen(merged.annotations?.["capabilities"])).toBe(true);
    await expect(computeSchemaHash(serializeSchema(merged, 1))).resolves.toBe(
      beforeHash,
    );
  });

  it("persists evolved annotations across a fresh Store restart", async () => {
    const backend = createTestBackend();
    const base = graph({ displayName: "Base", owner: "schema" });
    const [store] = await createStoreWithSchema(base, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        annotations: { displayName: "Evolved", capabilities: ["search"] },
      }),
    );

    expect(evolved.introspect().annotations).toEqual({
      displayName: "Evolved",
      owner: "schema",
      capabilities: ["search"],
    });

    const [restored, result] = await createStoreWithSchema(base, backend);
    expect(result.status).toBe("unchanged");
    expect(restored.introspect().annotations).toEqual(
      evolved.introspect().annotations,
    );
  });

  it("retains graph annotations when instantiating a graph template", async () => {
    const backend = createTestBackend();
    const [source] = await createAdapterStoreWithSchema(
      graph({ displayName: "Template graph", capabilities: { search: true } }),
      backend,
    );
    const template = await registerGraphTemplate(backend, {
      templateId: "annotated-template",
      reconciled: source.reconciledSchema,
    });
    const target = await instantiateGraphTemplate(backend, {
      template,
      graphId: "annotated-template-instance",
    });

    expect(parseSerializedSchema(target.schema.schema_doc).annotations).toEqual(
      { displayName: "Template graph", capabilities: { search: true } },
    );
    expect(target.reconciled.graph.annotations).toEqual(
      source.introspect().annotations,
    );
  });

  it("reports path-specific authoring errors", () => {
    expect(() =>
      defineGraph({
        id: "invalid_graph_annotations",
        annotations: { capabilities: { refreshedAt: new Date() } } as never,
        nodes: {},
        edges: {},
      }),
    ).toThrow(/annotations\.capabilities\.refreshedAt/);

    expect(() =>
      defineGraphExtension({
        annotations: { capabilities: { refreshedAt: new Date() } } as never,
      }),
    ).toThrow(/\/annotations\/capabilities\/refreshedAt/);
  });
});
