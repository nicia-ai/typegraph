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
import { defineEdge } from "../src/core/edge";
import { defineNode } from "../src/core/node";
import { ConfigurationError } from "../src/errors";
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

  it("refuses a NESTED object field named `__proto__` on the same grounds", () => {
    // The nested `object.properties` map compiles through the same
    // `z.object(...)` as the top-level one (`buildObjectSchema`), so a name Zod
    // cannot carry at the top level it cannot carry one level down either.
    // Refusing only the top level let a document declare a nested field that
    // validated clean and then vanished at parse — the same unstorable field,
    // accepted instead of refused because the enumeration stopped at depth 0.
    const document = parseDocument(
      `{"version":1,"nodes":{"Tag":{"properties":{"payload":{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"string"}}}}}}}`,
    );

    const result = validateGraphExtension(document);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;

    expect(
      result.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
      })),
    ).toContainEqual({
      path: "/nodes/Tag/properties/payload/properties/__proto__",
      code: "RESERVED_PROPERTY_NAME",
    });
  });

  it("still accepts a nested object whose fields are ordinary names", () => {
    // The refusal must be the `__proto__` name, not nested objects at large.
    const document = parseDocument(
      `{"version":1,"nodes":{"Tag":{"properties":{"payload":{"type":"object","properties":{"ok":{"type":"string"}}}}}}}`,
    );

    expect(isErr(validateGraphExtension(document))).toBe(false);
  });
});

// ============================================================
// `defineNode` / `defineEdge` — the OTHER authoring path
// ============================================================

describe("compile-time schema declaring a property named `__proto__`", () => {
  it("refuses the node definition, as the document path already did", () => {
    // Zod accepts `__proto__` in a shape and reports parse SUCCESS while
    // dropping the field from the result — even when it is required. A kind
    // authored as a JSON document has been refused this declaration since the
    // read-side fix; `defineNode` accepted the identical unstorable field and
    // lost writes to it silently. Two authoring paths, one field, one verdict.
    expect(() =>
      defineNode("ProtoProp", {
        // A COMPUTED key: written literally, `__proto__:` sets the shape
        // object's prototype instead of declaring a field.
        schema: z.object({ [PROTO_KEY]: z.string(), name: z.string() }),
      }),
    ).toThrow(/__proto__/);
  });

  it("refuses the edge definition on the same grounds", () => {
    expect(() =>
      defineEdge("protoPropEdge", {
        schema: z.object({ [PROTO_KEY]: z.string() }),
      }),
    ).toThrow(/__proto__/);
  });

  it("refuses a NESTED object field, not just a top-level one", () => {
    // The depth-0 control above passed while THIS declaration was accepted, and
    // the nested write was dropped at parse in exactly the same way — the
    // refusal was checking `Object.keys(schema.shape)` and nothing below it.
    // The document authoring path had already been made recursive; this is the
    // Zod path catching up, so the two agree at every depth rather than only at
    // the first.
    expect(() =>
      defineNode("NestedProtoProp", {
        schema: z.object({
          payload: z.object({ [PROTO_KEY]: z.string(), ok: z.string() }),
        }),
      }),
    ).toThrow(/payload\.__proto__/);
  });

  it("refuses a nested field on an EDGE schema too", () => {
    expect(() =>
      defineEdge("nestedProtoPropEdge", {
        schema: z.object({
          payload: z.object({ [PROTO_KEY]: z.string() }),
        }),
      }),
    ).toThrow(/payload\.__proto__/);
  });

  it.each([
    [
      "optional",
      z.object({ payload: z.object({ [PROTO_KEY]: z.string() }).optional() }),
    ],
    [
      "nullable",
      z.object({ payload: z.object({ [PROTO_KEY]: z.string() }).nullable() }),
    ],
    [
      "array element",
      z.object({ items: z.array(z.object({ [PROTO_KEY]: z.string() })) }),
    ],
    [
      "record value",
      z.object({
        bag: z.record(z.string(), z.object({ [PROTO_KEY]: z.number() })),
      }),
    ],
    [
      "union member",
      z.object({
        either: z.union([z.string(), z.object({ [PROTO_KEY]: z.string() })]),
      }),
    ],
    [
      "default + array, two levels down",
      z.object({
        outer: z
          .object({ inner: z.array(z.object({ [PROTO_KEY]: z.string() })) })
          .default({ inner: [] }),
      }),
    ],
  ])(
    "refuses an unstorable field behind a %s wrapper",
    (_label, schema: z.ZodObject<z.ZodRawShape>) => {
      // Wrappers name nothing, so they contribute no path segment — but they
      // must not hide what they wrap. Enumerating them one by one is how this
      // stays true for the composites the DSL actually produces.
      expect(() => defineNode("WrappedProtoProp", { schema })).toThrow(
        /__proto__/,
      );
    },
  );

  it("accepts a nested schema with no unstorable name", () => {
    // The walk must not cost the schemas it is not about: nesting, arrays,
    // wrappers and prototype-NAMED-but-storable fields all still define.
    expect(() =>
      defineNode("CleanNested", {
        schema: z.object({
          payload: z.object({ ok: z.string(), toString: z.string() }),
          items: z.array(z.object({ id: z.number() })).optional(),
        }),
      }),
    ).not.toThrow();
  });

  it("terminates on a self-referential schema", () => {
    // `z.lazy` hides its inner schema behind a getter rather than a `def` value,
    // so it is unwrapped explicitly; a recursive schema would then walk forever
    // without the visited set.
    interface Tree {
      readonly label: string;
      readonly children: readonly Tree[];
    }
    const Tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({ label: z.string(), children: z.array(Tree) }),
    );
    expect(() =>
      defineNode("RecursiveClean", { schema: z.object({ tree: Tree }) }),
    ).not.toThrow();

    const Poisoned: z.ZodType = z.lazy(() =>
      z.object({ [PROTO_KEY]: z.string(), next: z.array(Poisoned) }),
    );
    expect(() =>
      defineNode("RecursivePoisoned", { schema: z.object({ tree: Poisoned }) }),
    ).toThrow(/tree\.__proto__/);
  });

  it("REFUSES a `z.lazy` whose getter cannot run yet", () => {
    // Unwrapping a `z.lazy` RUNS its getter, and a mutually recursive pair
    // declared AROUND a `defineNode` call leaves the second schema in its
    // temporal dead zone when the first one's getter fires. Skipping the
    // subtree there was a fail-OPEN: a definition is validated exactly once, so
    // the branch was never judged later either — see the next case for what got
    // through. The refusal names the kind and the path so the fix (reorder the
    // declarations) is obvious from the message alone.
    const First: z.ZodType = z.lazy(() => z.object({ next: Second }));
    expect(() =>
      defineNode("MutuallyRecursive", { schema: z.object({ first: First }) }),
    ).toThrow(/z\.lazy\(\)/);
    expect(() =>
      defineNode("MutuallyRecursive", { schema: z.object({ first: First }) }),
    ).toThrow(/first/);
    const Second: z.ZodType = z.lazy(() => z.object({ back: First }));
    // Declared after the `defineNode` above on purpose — that ordering is the
    // whole fixture, and the reference keeps it from reading as dead code.
    expect(Second).toBeDefined();
  });

  it("refuses the POISONED mutually recursive pair instead of dropping its writes", () => {
    // The defect this closes, end to end. `Second` carries an unstorable
    // `__proto__`, and it is in its temporal dead zone when `First`'s getter
    // runs — so the walk used to return nothing for that subtree and the
    // definition was ACCEPTED. By the time anything parsed against it, `Second`
    // had initialized and the field was live: every write to it succeeded and
    // was silently dropped, which is precisely the outcome this validation
    // exists to make impossible. A subtree that cannot be judged is refused.
    const First: z.ZodType = z.lazy(() => z.object({ next: Second }));
    expect(() =>
      defineNode("PoisonedMutuallyRecursive", {
        schema: z.object({ first: First }),
      }),
    ).toThrow(ConfigurationError);
    const Second: z.ZodType = z.lazy(() =>
      z.object({ [PROTO_KEY]: z.string(), back: First.optional() }),
    );
    // The premise: once `Second` initializes the poisoned field is real, and
    // Zod reports SUCCESS while dropping it — nothing downstream would notice.
    const parsed = Second.safeParse(parseDocument(`{"__proto__":"lost"}`));
    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data as object)).not.toContain(
      PROTO_KEY,
    );
  });

  it("reaches the unstorable name when the recursive pair is declared FIRST", () => {
    // The refusal above is about a getter that cannot run, not about recursion:
    // declaring both consts before the definition — the ordering the error
    // message asks for — makes every getter resolve, and the walk then reports
    // the real conflict at its full nested path. Without this case the fix
    // would be indistinguishable from banning mutual recursion outright.
    const A: z.ZodType = z.lazy(() => z.object({ toB: B }));
    const B: z.ZodType = z.lazy(() =>
      z.object({ [PROTO_KEY]: z.string(), toA: A }),
    );
    expect(() =>
      defineNode("OrderedMutuallyRecursive", { schema: z.object({ a: A }) }),
    ).toThrow(/a\.toB\.__proto__/);
  });

  it("states the nested fixture's premise: Zod drops the nested field too", () => {
    const schema = z.object({
      payload: z.object({ [PROTO_KEY]: z.string(), ok: z.string() }),
    });
    const parsed = schema.safeParse(
      parseDocument(`{"payload":{"__proto__":"lost","ok":"kept"}}`),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data.payload)).toEqual(["ok"]);
  });

  it("states the fixture's premise: Zod really does drop the field", () => {
    // If this ever stops holding, the refusal above is no longer warranted and
    // should be revisited rather than kept out of habit.
    const schema = z.object({ [PROTO_KEY]: z.string(), name: z.string() });
    expect(Object.keys(schema.shape)).toContain(PROTO_KEY);

    const parsed = schema.safeParse(
      parseDocument(`{"__proto__":"lost","name":"kept"}`),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data)).toEqual(["name"]);
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

// ============================================================
// Edge kinds — `defineGraph`'s own accumulator
// ============================================================

describe("compile-time graph with an edge kind named `__proto__`", () => {
  it("carries the edge through defineGraph, serialization, and a live store", async () => {
    // `normalizeEdges` rebuilds `config.edges` into a fresh accumulator (nodes
    // are passed through by reference and so were never at risk). Built as a
    // `{}` literal, `result["__proto__"] = registration` reaches
    // `Object.prototype`'s `__proto__` setter, reparents the accumulator, and
    // leaves `graph.edges` with NO own keys — the declared edge vanishes
    // before anything downstream can see it.
    const protoEdge = defineEdge(PROTO_KEY, {
      schema: z.object({ since: z.string() }),
      from: [Person],
      to: [Person],
    });
    const graph = defineGraph({
      id: "proto_edge_kind",
      nodes: { Person: { type: Person } },
      // A COMPUTED key: `{ __proto__: … }` written literally would set the
      // config object's prototype instead of creating the entry.
      edges: { [PROTO_KEY]: { type: protoEdge, from: [Person], to: [Person] } },
    });

    // 1. defineGraph carries it as an OWN key.
    expect(Object.hasOwn(graph.edges, PROTO_KEY)).toBe(true);
    expect(Object.keys(graph.edges)).toEqual([PROTO_KEY]);

    // 2. It survives serialization into the persisted schema document, and is
    //    visible to the diff (not merely present on the record).
    const serialized = serializeSchema(graph, 1);
    expect(Object.hasOwn(serialized.edges, PROTO_KEY)).toBe(true);
    const withoutEdge = defineGraph({
      id: "proto_edge_kind",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const diff = computeSchemaDiff(serializeSchema(withoutEdge, 1), serialized);
    expect(diff.edges.map((change) => change.kind)).toContain(PROTO_KEY);

    // 3. A live store can create and read an edge of that kind end-to-end.
    const [store] = await createStoreWithSchema(graph, createTestBackend());
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    const edges = store.edges as unknown as Record<
      string,
      Readonly<{
        create: (
          from: typeof alice,
          to: typeof bob,
          props: { since: string },
        ) => Promise<{ kind: string }>;
        find: () => Promise<readonly { since: string }[]>;
      }>
    >;

    const created = await edges[PROTO_KEY]?.create(alice, bob, {
      since: "2024",
    });
    expect(created?.kind).toBe(PROTO_KEY);

    const found = await edges[PROTO_KEY]?.find();
    expect(found?.map((edge) => edge.since)).toEqual(["2024"]);
  });
});
