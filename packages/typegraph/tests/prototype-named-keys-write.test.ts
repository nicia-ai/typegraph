/**
 * The WRITE side of the prototype-key class (issue #441).
 *
 * `hasOwnKey` / `readOwnProperty` closed the READ half: a bag whose keys are
 * data must not answer for `Object.prototype`'s members. The mirror defect is
 * on assignment. `bag[key] = value` into a `{}` literal does not create an
 * entry when `key` is `__proto__` — it invokes `Object.prototype`'s `__proto__`
 * SETTER, which reparents the bag for an object value and does nothing at all
 * for a primitive. Either way the value is dropped, silently, and every later
 * own-key read agrees the writer never wrote it.
 *
 * Reachable without anything exotic: `isValidKindName`
 * (`/^[A-Za-z_][A-Za-z0-9_]*$/`) admits `__proto__` exactly as it admits
 * `toString`, and `JSON.parse` yields `__proto__` as an ordinary own key — so
 * any graph-extension document or persisted schema read off disk or the wire
 * can carry one. These tests pin the single owner of the fix
 * ({@link createDataKeyedBag}) and the two most reachable sites that use it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph } from "../src/core/define-graph";
import { defineNode } from "../src/core/node";
import { validateGraphExtension } from "../src/graph-extension";
import { mergeGraphExtension } from "../src/graph-extension/merge";
import { computeSchemaDiff } from "../src/schema/migration";
import { serializeSchema } from "../src/schema/serializer";
import { type SerializedSchema } from "../src/schema/types";
import { createStoreWithSchema } from "../src/store/store";
import { createDataKeyedBag } from "../src/utils/object";
import { isErr, unwrap } from "../src/utils/result";
import { createTestBackend } from "./test-utils";

const PROTO_KEY = "__proto__";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const baseGraph = defineGraph({
  id: "prototype_named_keys_write",
  nodes: { Person: { type: Person } },
  edges: {},
});

// ============================================================
// The owner
// ============================================================

/** A `{}` literal, built where the linter cannot fold the mutation into it. */
function emptyObjectLiteral(): Record<string, string> {
  return {};
}

/**
 * Built from raw JSON text, not an object literal: `{ __proto__: … }` in source
 * sets the literal's prototype, so only a parsed document (or a computed key)
 * carries `__proto__` as the own key a real document has.
 */
function parseDocument(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * Injects a `__proto__` property into a serialized node schema through raw JSON
 * — the shape a persisted `schema_doc` row parses back as when an earlier
 * version (or a hand-written document) declared such a field.
 */
function withProtoProperty(
  schema: SerializedSchema,
  type: "string" | "number",
): SerializedSchema {
  const text = JSON.stringify(schema).replace(
    `"properties":{"name":`,
    `"properties":{"__proto__":{"type":"${type}"},"name":`,
  );
  return JSON.parse(text) as SerializedSchema;
}

describe("createDataKeyedBag", () => {
  it("stores a `__proto__` entry that a plain object literal silently drops", () => {
    const bag = createDataKeyedBag<string>();
    bag[PROTO_KEY] = "kept";

    expect(Object.hasOwn(bag, PROTO_KEY)).toBe(true);
    expect(bag[PROTO_KEY]).toBe("kept");
    expect(Object.keys(bag)).toEqual([PROTO_KEY]);

    // The defect the helper exists to prevent, stated as executable evidence:
    // the same assignment against a `{}` literal reaches the prototype setter
    // and creates nothing.
    const plain = emptyObjectLiteral();
    plain[PROTO_KEY] = "kept";
    expect(Object.hasOwn(plain, PROTO_KEY)).toBe(false);
    expect(Object.keys(plain)).toEqual([]);
  });

  it("does not answer for inherited members it was never given", () => {
    const bag = createDataKeyedBag<string>();
    expect(Object.hasOwn(bag, "toString")).toBe(false);
    // Naming the key is the point: dot notation reads the inherited method.
    // eslint-disable-next-line @typescript-eslint/dot-notation
    expect(bag["toString"]).toBeUndefined();
  });
});

// ============================================================
// Graph-extension documents
// ============================================================

describe("graph-extension document with a `__proto__` kind name", () => {
  it("carries the kind through validation, merge, and a live store", async () => {
    const document = parseDocument(
      `{"version":1,"nodes":{"__proto__":{"properties":{"label":{"type":"string"}}}}}`,
    );

    const validated = unwrap(validateGraphExtension(document));
    // The document is legal — `__proto__` matches the kind-name pattern — so
    // validation must carry it, not quietly return a document without it.
    expect(Object.keys(validated.nodes ?? {})).toContain(PROTO_KEY);

    const merged = mergeGraphExtension(baseGraph, validated);
    expect(Object.hasOwn(merged.nodes, PROTO_KEY)).toBe(true);

    const [store] = await createStoreWithSchema(merged, createTestBackend());
    expect(store.introspect().kinds.map((kind) => kind.name)).toContain(
      PROTO_KEY,
    );

    // The kind is not in the compile-time graph type (it arrived as a
    // document), so the collection is reached the way every graph-extension
    // kind is: by name, with the runtime shape stated explicitly.
    const collections = store.nodes as unknown as Record<
      string,
      Readonly<{
        create: (props: { label: string }) => Promise<{ kind: string }>;
        find: () => Promise<readonly { label: string }[]>;
      }>
    >;

    const created = await collections[PROTO_KEY]?.create({ label: "x" });
    expect(created?.kind).toBe(PROTO_KEY);

    const found = await collections[PROTO_KEY]?.find();
    expect(found?.map((node) => node.label)).toEqual(["x"]);
  });

  it("refuses a property named `__proto__` rather than declaring a field the schema cannot carry", () => {
    const document = parseDocument(
      `{"version":1,"nodes":{"Tag":{"properties":{"__proto__":{"type":"string"}}}}}`,
    );

    const result = validateGraphExtension(document);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;

    // Zod accepts `__proto__` in a shape but drops it from every parse result —
    // and reports success even when the field is required — so a node written
    // with it would silently lose the value. The declaration is refused.
    expect(
      result.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
      })),
    ).toContainEqual({
      path: "/nodes/Tag/properties/__proto__",
      code: "RESERVED_PROPERTY_NAME",
    });
  });
});

// ============================================================
// Persisted schema diffing
// ============================================================

describe("schema diff over a property named `__proto__`", () => {
  it("reports the property's type change as a modification", () => {
    const serialized = serializeSchema(baseGraph, 1);
    const before = withProtoProperty(serialized, "string");
    const after = withProtoProperty(serialized, "number");

    // FIXTURE SANITY: the injected key really is an own key on both sides.
    const beforeProperties = (
      before.nodes["Person"] as unknown as {
        properties: { properties: Record<string, unknown> };
      }
    ).properties.properties;
    expect(Object.hasOwn(beforeProperties, PROTO_KEY)).toBe(true);

    const diff = computeSchemaDiff(before, after);

    // Order-normalization walks both schemas into fresh bags before comparing.
    // Built as `{}` those bags lose the `__proto__` subschema from BOTH sides,
    // so the two schemas compare equal and the change migrates as a no-op.
    expect(diff.hasChanges).toBe(true);
    expect(
      diff.nodes.map((change) => ({
        kind: change.kind,
        type: change.type,
      })),
    ).toContainEqual({ kind: "Person", type: "modified" });
  });
});

describe("schema serialization of a kind named `__proto__`", () => {
  it("carries the kind into the serialized nodes and edges records", () => {
    // The graph literal uses a COMPUTED key, which creates an own property;
    // the serializer's accumulators used to be `{}` literals, whose
    // `result["__proto__"] = def` assignment invokes the prototype setter
    // and silently drops the kind from schema_doc, computeSchemaHash, and
    // computeSchemaDiff — so the kind existed in memory but never persisted.
    const ProtoKind = defineNode("__proto__", {
      schema: z.object({ label: z.string() }),
    });
    const graphWithProtoKind = defineGraph({
      id: "proto_kind_serialization",
      nodes: { ["__proto__"]: { type: ProtoKind } },
      edges: {},
    });

    const serialized = serializeSchema(graphWithProtoKind, 1);

    expect(Object.hasOwn(serialized.nodes, "__proto__")).toBe(true);
    const plainGraph = defineGraph({
      id: "proto_kind_serialization",
      nodes: {},
      edges: {},
    });
    // The kind must be visible to the diff, not just the record.
    const diff = computeSchemaDiff(serializeSchema(plainGraph, 1), serialized);
    expect(diff.hasChanges).toBe(true);
  });
});
