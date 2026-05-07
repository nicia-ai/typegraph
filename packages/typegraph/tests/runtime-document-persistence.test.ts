/**
 * Restart parity, cross-process visibility, and startup-conflict tests
 * for the persisted runtime extension document.
 *
 * Simulates "an earlier process persisted a runtime extension" by
 * composing `mergeRuntimeExtension(...)` + `serializeSchema(...)` +
 * `backend.commitSchemaVersion(...)` directly, then verifies that a
 * fresh `createStoreWithSchema(graph, backend)` reconstructs an
 * identical `Store` — same kinds, same query behavior.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph } from "../src/core/define-graph";
import { defineNode } from "../src/core/node";
import { ConfigurationError } from "../src/errors";
import { defineRuntimeExtension } from "../src/runtime";
import { mergeRuntimeExtension } from "../src/runtime/merge";
import { ensureSchema } from "../src/schema/manager";
import { computeSchemaHash, serializeSchema } from "../src/schema/serializer";
import { createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const baseGraph = defineGraph({
  id: "runtime_doc_persistence",
  nodes: { Person: { type: Person } },
  edges: {},
});

async function persistEvolvedSchema(
  backend: ReturnType<typeof createTestBackend>,
  document: Parameters<typeof mergeRuntimeExtension>[1],
): Promise<void> {
  // Bring the backend to a baseline at version 1 with the unmerged
  // graph, then commit a v2 carrying the merged runtime document.
  const [, initial] = await createStoreWithSchema(baseGraph, backend);
  expect(initial.status).toBe("initialized");

  const merged = mergeRuntimeExtension(baseGraph, document);
  const evolvedSchema = serializeSchema(merged, 2);
  const evolvedHash = await computeSchemaHash(evolvedSchema);
  await backend.commitSchemaVersion({
    graphId: baseGraph.id,
    expected: { kind: "active", version: 1 },
    version: 2,
    schemaHash: evolvedHash,
    schemaDoc: evolvedSchema,
  });
}

describe("runtime document persistence — loader rewire", () => {
  it("restart parity: a fresh Store sees runtime kinds persisted by an earlier process", async () => {
    const backend = createTestBackend();
    const tagExtension = defineRuntimeExtension({
      nodes: {
        Tag: { properties: { name: { type: "string" } } },
      },
    });
    await persistEvolvedSchema(backend, tagExtension);

    // "Process B" boots against the same backend with the original
    // compile-time graph; the loader must read the persisted
    // runtimeDocument and merge it before constructing the Store.
    const [restoredStore, restoredResult] = await createStoreWithSchema(
      baseGraph,
      backend,
    );
    expect(restoredResult.status).toBe("unchanged");

    const registry = restoredStore.registry;
    expect(registry.hasNodeType("Person")).toBe(true);
    expect(registry.hasNodeType("Tag")).toBe(true);
    const tagType = registry.getNodeType("Tag");
    expect(tagType?.schema.shape.name).toBeDefined();
  });

  it("re-serializing the merged graph reproduces the same canonical hash", async () => {
    const backend = createTestBackend();
    const extension = defineRuntimeExtension({
      nodes: {
        Tag: { properties: { name: { type: "string" } } },
      },
    });
    await persistEvolvedSchema(backend, extension);

    const persistedRow = await backend.getActiveSchema(baseGraph.id);
    expect(persistedRow).toBeDefined();

    // The merged graph the loader reconstructs must serialize to the
    // same hash that was persisted — this is what makes ensureSchema's
    // hash-equality check return "unchanged" rather than triggering a
    // spurious migration on every boot.
    const merged = mergeRuntimeExtension(baseGraph, extension);
    const reSerialized = serializeSchema(merged, persistedRow!.version);
    const reHash = await computeSchemaHash(reSerialized);
    expect(reHash).toBe(persistedRow!.schema_hash);
  });

  it("runtime edges referencing host kinds expose resolved endpoints through the registry", async () => {
    const backend = createTestBackend();
    const extension = defineRuntimeExtension({
      nodes: {
        Tag: { properties: { name: { type: "string" } } },
      },
      edges: {
        appliesTo: {
          from: ["Tag"],
          to: ["Person"],
          properties: {},
        },
      },
    });
    await persistEvolvedSchema(backend, extension);

    const [restored] = await createStoreWithSchema(baseGraph, backend);
    const edgeType = restored.registry.getEdgeType("appliesTo");
    expect(edgeType).toBeDefined();
    expect(edgeType?.from?.map((node) => node.kind)).toEqual(["Tag"]);
    expect(edgeType?.to?.map((node) => node.kind)).toEqual(["Person"]);
  });

  it("startup conflict: missing compile-time kind referenced by an edge endpoint fails store construction", async () => {
    const backend = createTestBackend();

    // Persist an extension whose runtime edge points at a host kind
    // that DOES exist at extension time — succeeds.
    const extension = defineRuntimeExtension({
      nodes: {
        Tag: { properties: { name: { type: "string" } } },
      },
      edges: {
        appliesTo: {
          from: ["Tag"],
          to: ["Person"],
          properties: {},
        },
      },
    });
    await persistEvolvedSchema(backend, extension);

    // Now "Process C" boots with a graph that no longer declares Person
    // — the runtime extension's edge endpoint is unresolvable. Store
    // construction must fail with a clear error rather than silently
    // dropping the reference.
    const Other = defineNode("Other", {
      schema: z.object({ value: z.number() }),
    });
    const conflictingGraph = defineGraph({
      id: baseGraph.id,
      nodes: { Other: { type: Other } },
      edges: {},
    });

    await expect(
      createStoreWithSchema(conflictingGraph, backend),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("ensureSchema's preloaded option is respected even when activeRow is undefined", async () => {
    // Regression: an explicit `preloaded: { activeRow: undefined }`
    // means "the loader checked and saw no schema yet". The legacy
    // `??` coalesce treated that as "preloaded not supplied" and
    // refetched, opening a race window where a concurrent commit could
    // surface to ensureSchema as a misleading MigrationError. With the
    // sentinel check, ensureSchema now follows the initialize path and
    // any race surfaces as a clean StaleVersionError from
    // commitSchemaVersion.
    const backend = createTestBackend();
    // Pre-seed the backend with a *different* v1 schema (simulates the
    // racing committer that landed something between the loader's
    // read and ensureSchema's would-be refetch).
    const Other = defineNode("Other", {
      schema: z.object({ value: z.number() }),
    });
    const racingGraph = defineGraph({
      id: baseGraph.id,
      nodes: { Other: { type: Other } },
      edges: {},
    });
    const seed = serializeSchema(racingGraph, 1);
    const seedHash = await computeSchemaHash(seed);
    await backend.commitSchemaVersion({
      graphId: baseGraph.id,
      expected: { kind: "initial" },
      version: 1,
      schemaHash: seedHash,
      schemaDoc: seed,
    });

    // Call ensureSchema with the loader's empty snapshot. With the
    // sentinel honored, the function heads straight into
    // initializeSchema, which conflicts at the commit boundary with
    // the racing v1 — a precise concurrent-commit signal rather than
    // a phantom MigrationError. Without the sentinel, the `??` would
    // refetch, parse the racing schema, and diff it against the
    // baseGraph (which lacks `Other`), classifying the missing kind
    // as a breaking removal and throwing MigrationError instead.
    await expect(
      ensureSchema(backend, baseGraph, {
        preloaded: { activeRow: undefined, storedSchema: undefined },
      }),
    ).rejects.toThrow();
  });

  it("legacy graphs (no runtimeDocument persisted) load without invoking the merge path", async () => {
    const backend = createTestBackend();
    const [, initial] = await createStoreWithSchema(baseGraph, backend);
    expect(initial.status).toBe("initialized");

    // Re-boot — no runtime extension was ever persisted, so the loader's
    // fast path should return the original graph reference unchanged.
    const [restored, restoredResult] = await createStoreWithSchema(
      baseGraph,
      backend,
    );
    expect(restoredResult.status).toBe("unchanged");
    expect(restored.registry.hasNodeType("Person")).toBe(true);
  });

  it("loads a persisted runtimeDocument that was committed before the version field existed", async () => {
    // Back-compat regression: a runtimeDocument committed by an older
    // library version has no `version` field. The loader must treat
    // it as version 1 (the current major) and reconstruct the merged
    // graph without throwing.
    const backend = createTestBackend();
    const [, initial] = await createStoreWithSchema(baseGraph, backend);
    expect(initial.status).toBe("initialized");

    const merged = mergeRuntimeExtension(
      baseGraph,
      defineRuntimeExtension({
        nodes: { Tag: { properties: { name: { type: "string" } } } },
      }),
    );
    // Strip `version` from the runtimeDocument to simulate a pre-versioning
    // stored document.
    const evolvedSchema = serializeSchema(merged, 2);
    const { version: _stripVersion, ...legacyRuntimeDocument } =
      evolvedSchema.runtimeDocument!;
    const legacyEvolvedSchema = {
      ...evolvedSchema,
      runtimeDocument: legacyRuntimeDocument,
    };
    const legacyHash = await computeSchemaHash(legacyEvolvedSchema);
    await backend.commitSchemaVersion({
      graphId: baseGraph.id,
      expected: { kind: "active", version: 1 },
      version: 2,
      schemaHash: legacyHash,
      schemaDoc: legacyEvolvedSchema,
    });

    // Loader must accept the version-less document.
    const [restored, restoredResult] = await createStoreWithSchema(
      baseGraph,
      backend,
    );
    expect(restoredResult.status).toBe("unchanged");
    expect(restored.registry.hasNodeType("Tag")).toBe(true);
  });
});
