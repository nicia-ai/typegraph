import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph } from "../../src/core/define-graph";
import { defineEdge, type DefineEdgeOptions } from "../../src/core/edge";
import { defineNode, type DefineNodeOptions } from "../../src/core/node";
import {
  type AnyEdgeType,
  type Cardinality,
  type DeleteBehavior,
  type EndpointExistence,
  type KindAnnotations,
  type TemporalMode,
} from "../../src/core/types";
import {
  defineEdgeIndex,
  defineNodeIndex,
  type IndexDeclaration,
} from "../../src/indexes";
import {
  broader,
  disjointWith,
  equivalentTo,
  hasPart,
  partOf,
  relatedTo,
  subClassOf,
} from "../../src/ontology/core-meta-edges";
import { defineRuntimeExtension } from "../../src/runtime";
import { mergeRuntimeExtension } from "../../src/runtime/merge";
import { sortedReplacer } from "../../src/schema/canonical";
import { deserializeSchema } from "../../src/schema/deserializer";
import {
  computeSchemaHash,
  serializeSchema,
} from "../../src/schema/serializer";
import { serializedSchemaZod } from "../../src/schema/types";

// ============================================================
// Arbitrary Generators
// ============================================================

/**
 * Generate valid TypeScript identifiers for use as type names.
 */
const identifierArb = fc
  .stringMatching(/^[A-Z][a-zA-Z0-9]*$/)
  .filter((s) => s.length >= 2 && s.length <= 30);

/**
 * Generate lowercase identifiers for edge names.
 */
const edgeIdentifierArb = fc
  .stringMatching(/^[a-z][a-zA-Z0-9]*$/)
  .filter((s) => s.length >= 2 && s.length <= 30);

/**
 * Generate graph IDs (snake_case).
 */
const graphIdArb = fc
  .stringMatching(/^[a-z][a-z0-9_]*$/)
  .filter((s) => s.length >= 2 && s.length <= 30);

/**
 * Generate optional descriptions.
 */
const descriptionArb = fc.option(fc.string({ minLength: 1, maxLength: 100 }), {
  nil: undefined,
});

/**
 * Generate optional consumer-owned annotations (KindAnnotations).
 *
 * Uses arbitrary JSON values so the property tests cover deeply nested,
 * heterogeneously-keyed shapes — exactly the kinds of structures consumers
 * embed (UI hints, audit policy, provenance pointers, etc.).
 */
const annotationsKeyArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,7}$/);
// fc.jsonValue() produces values that are valid JSON at runtime, but its
// TypeScript type is wider than our KindAnnotations type. Cast the arbitrary
// so the rest of the test sees the public type.
const annotationsArb = fc.option(
  fc.dictionary(annotationsKeyArb, fc.jsonValue(), {
    minKeys: 0,
    maxKeys: 4,
  }),
  { nil: undefined },
) as fc.Arbitrary<KindAnnotations | undefined>;

/**
 * Generate delete behaviors.
 */
const deleteBehaviorArb: fc.Arbitrary<DeleteBehavior> = fc.constantFrom(
  "restrict",
  "cascade",
  "disconnect",
);

/**
 * Generate temporal modes.
 */
const temporalModeArb: fc.Arbitrary<TemporalMode> = fc.constantFrom(
  "current",
  "asOf",
  "includeEnded",
  "includeTombstones",
);

/**
 * Generate cardinality values.
 */
const cardinalityArb: fc.Arbitrary<Cardinality> = fc.constantFrom(
  "many",
  "one",
  "unique",
  "oneActive",
);

/**
 * Generate endpoint existence modes.
 */
const endpointExistenceArb: fc.Arbitrary<EndpointExistence> = fc.constantFrom(
  "notDeleted",
  "currentlyValid",
  "ever",
);

// Note: UniquenessScope and Collation types are imported but the arbitraries
// are not currently used. They can be added to edge generation if needed.

// Reserved keys that cannot be used as property names
const RESERVED_NODE_KEYS = new Set(["id", "kind", "meta"]);
const RESERVED_EDGE_KEYS = new Set([
  "id",
  "kind",
  "meta",
  "fromKind",
  "fromId",
  "toKind",
  "toId",
]);

/**
 * Generate valid property names (excluding reserved keys).
 */
const propertyNameArb = fc
  .stringMatching(/^[a-z][a-zA-Z0-9]*$/)
  .filter(
    (name) => !RESERVED_NODE_KEYS.has(name) && !RESERVED_EDGE_KEYS.has(name),
  );

/**
 * Generate simple Zod schemas for properties.
 * Covers common types: string, number, boolean, and optional variants.
 */
const simpleZodSchemaArb = fc
  .record({
    stringFields: fc.array(propertyNameArb, {
      minLength: 0,
      maxLength: 3,
    }),
    numberFields: fc.array(propertyNameArb, {
      minLength: 0,
      maxLength: 3,
    }),
    booleanFields: fc.array(propertyNameArb, {
      minLength: 0,
      maxLength: 3,
    }),
    optionalStringFields: fc.array(propertyNameArb, {
      minLength: 0,
      maxLength: 2,
    }),
  })
  .map(
    ({ stringFields, numberFields, booleanFields, optionalStringFields }) => {
      // Filter to ensure unique field names
      const allFields = new Set<string>();
      const shape: Record<string, z.ZodType> = {};

      for (const field of stringFields) {
        if (!allFields.has(field)) {
          allFields.add(field);
          shape[field] = z.string();
        }
      }
      for (const field of numberFields) {
        if (!allFields.has(field)) {
          allFields.add(field);
          shape[field] = z.number();
        }
      }
      for (const field of booleanFields) {
        if (!allFields.has(field)) {
          allFields.add(field);
          shape[field] = z.boolean();
        }
      }
      for (const field of optionalStringFields) {
        if (!allFields.has(field)) {
          allFields.add(field);
          shape[field] = z.string().optional();
        }
      }

      return z.object(shape);
    },
  );

/**
 * Generate a node type with schema.
 */
const nodeTypeArb = fc
  .record({
    name: identifierArb,
    schema: simpleZodSchemaArb,
    description: descriptionArb,
    annotations: annotationsArb,
  })
  .map(({ name, schema, description, annotations }) =>
    defineNode(name, {
      schema,
      ...(description === undefined ? {} : { description }),
      ...(annotations === undefined ? {} : { annotations }),
    }),
  );

/**
 * Generate an edge type with optional schema.
 *
 * Conditional spreads (instead of explicit `field: undefined`) keep us
 * compatible with `exactOptionalPropertyTypes: true`.
 */
const edgeTypeArb = fc
  .record({
    name: edgeIdentifierArb,
    schema: fc.option(simpleZodSchemaArb, { nil: undefined }),
    description: descriptionArb,
    annotations: annotationsArb,
  })
  .map(({ name, schema, description, annotations }) => {
    const annotationsPart = annotations === undefined ? {} : { annotations };
    if (schema && description) {
      return defineEdge(name, { schema, description, ...annotationsPart });
    }
    if (schema) return defineEdge(name, { schema, ...annotationsPart });
    if (description)
      return defineEdge(name, { description, ...annotationsPart });
    return defineEdge(name, annotationsPart);
  });

/**
 * Generate a unique set of node types.
 */
const uniqueNodeTypesArb = fc
  .array(nodeTypeArb, { minLength: 1, maxLength: 5 })
  .map((nodes) => {
    // Deduplicate by name
    const seen = new Set<string>();
    return nodes.filter((n) => {
      if (seen.has(n.kind)) return false;
      seen.add(n.kind);
      return true;
    });
  })
  .filter((nodes) => nodes.length > 0);

/**
 * Generate a unique set of edge types.
 */
const uniqueEdgeTypesArb = fc
  .array(edgeTypeArb, { minLength: 0, maxLength: 3 })
  .map((edges) => {
    // Deduplicate by name
    const seen = new Set<string>();
    return edges.filter((edge) => {
      if (seen.has(edge.kind)) return false;
      seen.add(edge.kind);
      return true;
    });
  });

/**
 * Generate a complete graph definition.
 */
const graphDefArb = fc
  .record({
    id: graphIdArb,
    nodeTypes: uniqueNodeTypesArb,
    edgeTypes: uniqueEdgeTypesArb,
    onNodeDelete: deleteBehaviorArb,
    temporalMode: temporalModeArb,
  })
  .chain(({ id, nodeTypes, edgeTypes, onNodeDelete, temporalMode }) => {
    // Generate node registrations
    const nodeEntries = nodeTypes.map((node) =>
      fc
        .record({
          onDelete: fc.option(deleteBehaviorArb, { nil: undefined }),
        })
        .map(({ onDelete }) => ({
          key: node.kind,
          value: { type: node, onDelete },
        })),
    );

    // Generate edge registrations (need at least 1 node type for from/to)
    const edgeEntries =
      edgeTypes.length > 0 && nodeTypes.length > 0 ?
        edgeTypes.map((edge) =>
          fc
            .record({
              fromIndex: fc.integer({ min: 0, max: nodeTypes.length - 1 }),
              toIndex: fc.integer({ min: 0, max: nodeTypes.length - 1 }),
              cardinality: fc.option(cardinalityArb, { nil: undefined }),
              endpointExistence: fc.option(endpointExistenceArb, {
                nil: undefined,
              }),
            })
            .map(({ fromIndex, toIndex, cardinality, endpointExistence }) => ({
              key: edge.kind,
              value: {
                type: edge,
                from: [nodeTypes[fromIndex]!],
                to: [nodeTypes[toIndex]!],
                cardinality,
                endpointExistence,
              },
            })),
        )
      : [];

    // Generate ontology relations (optional)
    const ontologyArb =
      nodeTypes.length >= 2 ?
        fc
          .array(
            fc.integer({ min: 0, max: 5 }).chain((relationType) => {
              // Pick two distinct nodes
              return fc
                .record({
                  fromIndex: fc.integer({ min: 0, max: nodeTypes.length - 1 }),
                  toIndex: fc.integer({ min: 0, max: nodeTypes.length - 1 }),
                })
                .filter(({ fromIndex, toIndex }) => fromIndex !== toIndex)
                .map(({ fromIndex, toIndex }) => {
                  const from = nodeTypes[fromIndex]!;
                  const to = nodeTypes[toIndex]!;
                  switch (relationType) {
                    case 0: {
                      return subClassOf(from, to);
                    }
                    case 1: {
                      return disjointWith(from, to);
                    }
                    case 2: {
                      return broader(from, to);
                    }
                    case 3: {
                      return relatedTo(from, to);
                    }
                    case 4: {
                      return partOf(from, to);
                    }
                    case 5: {
                      return hasPart(from, to);
                    }
                    default: {
                      return equivalentTo(from, to);
                    }
                  }
                });
            }),
            { minLength: 0, maxLength: 3 },
          )
          .map((relations) => {
            // Deduplicate relations
            const seen = new Set<string>();
            return relations.filter((relation) => {
              const fromName =
                typeof relation.from === "string" ?
                  relation.from
                : relation.from.kind;
              const toName =
                typeof relation.to === "string" ?
                  relation.to
                : relation.to.kind;
              const key = `${relation.metaEdge.name}:${fromName}:${toName}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          })
      : fc.constant([]);

    return fc
      .tuple(fc.tuple(...nodeEntries), fc.tuple(...edgeEntries), ontologyArb)
      .map(([nodeResults, edgeResults, ontology]) => {
        const nodes: Record<string, { type: ReturnType<typeof defineNode> }> =
          {};
        for (const { key, value } of nodeResults) {
          nodes[key] = value;
        }

        const edges: Record<
          string,
          {
            type: ReturnType<typeof defineEdge>;
            from: ReturnType<typeof defineNode>[];
            to: ReturnType<typeof defineNode>[];
          }
        > = {};
        for (const { key, value } of edgeResults) {
          edges[key] = value;
        }

        return defineGraph({
          id,
          nodes,
          edges,
          ontology,
          defaults: { onNodeDelete, temporalMode },
        });
      });
  });

/**
 * Generate a version number.
 */
const versionArb = fc.integer({ min: 1, max: 1000 });

// ============================================================
// Property Tests
// ============================================================

describe("Schema Serialization Properties", () => {
  describe("round-trip properties", () => {
    it("serialize -> deserialize preserves graph structure", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);
          const deserialized = deserializeSchema(serialized);

          // Check annotations
          expect(deserialized.graphId).toBe(graph.id);
          expect(deserialized.version).toBe(version);

          // Check node names
          const expectedNodeNames = Object.keys(graph.nodes).toSorted();
          const actualNodeNames = [...deserialized.getNodeNames()].toSorted();
          expect(actualNodeNames).toEqual(expectedNodeNames);

          // Check each node
          for (const name of expectedNodeNames) {
            const node = deserialized.getNode(name);
            expect(node).toBeDefined();
            expect(node!.kind).toBe(name);
          }

          // Check edge names
          const expectedEdgeNames = Object.keys(graph.edges).toSorted();
          const actualEdgeNames = [...deserialized.getEdgeNames()].toSorted();
          expect(actualEdgeNames).toEqual(expectedEdgeNames);

          // Check each edge
          for (const name of expectedEdgeNames) {
            const edge = deserialized.getEdge(name);
            expect(edge).toBeDefined();
            expect(edge!.kind).toBe(name);
          }

          // Check defaults
          const defaults = deserialized.getDefaults();
          expect(defaults.onNodeDelete).toBe(graph.defaults.onNodeDelete);
          expect(defaults.temporalMode).toBe(graph.defaults.temporalMode);
        }),
        { numRuns: 50 },
      );
    });

    it("getRaw returns equivalent serialized schema", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);
          const deserialized = deserializeSchema(serialized);
          const raw = deserialized.getRaw();

          // Raw should match original serialized (by value)
          expect(raw.graphId).toBe(serialized.graphId);
          expect(raw.version).toBe(serialized.version);
          expect(Object.keys(raw.nodes).toSorted()).toEqual(
            Object.keys(serialized.nodes).toSorted(),
          );
          expect(Object.keys(raw.edges).toSorted()).toEqual(
            Object.keys(serialized.edges).toSorted(),
          );
        }),
        { numRuns: 50 },
      );
    });

    it("serialize -> JSON -> Zod parse -> JSON is byte-identical", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);

          const canonicalBefore = JSON.stringify(serialized, sortedReplacer);
          const reparsed = serializedSchemaZod.parse(
            JSON.parse(canonicalBefore),
          );
          const canonicalAfter = JSON.stringify(reparsed, sortedReplacer);

          expect(canonicalAfter).toBe(canonicalBefore);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("hash properties", () => {
    it("hash is deterministic (same input produces same hash)", async () => {
      await fc.assert(
        fc.asyncProperty(graphDefArb, versionArb, async (graph, version) => {
          const serialized1 = serializeSchema(graph, version);
          const serialized2 = serializeSchema(graph, version);

          const hash1 = await computeSchemaHash(serialized1);
          const hash2 = await computeSchemaHash(serialized2);

          expect(hash1).toBe(hash2);
        }),
        { numRuns: 50 },
      );
    });

    it("hash ignores version (only structure matters)", async () => {
      await fc.assert(
        fc.asyncProperty(
          graphDefArb,
          versionArb,
          versionArb,
          async (graph, version1, version2) => {
            fc.pre(version1 !== version2);

            const serialized1 = serializeSchema(graph, version1);
            const serialized2 = serializeSchema(graph, version2);

            const hash1 = await computeSchemaHash(serialized1);
            const hash2 = await computeSchemaHash(serialized2);

            expect(hash1).toBe(hash2);
          },
        ),
        { numRuns: 30 },
      );
    });

    it("hash changes when nodes are added", async () => {
      await fc.assert(
        fc.asyncProperty(
          graphDefArb,
          identifierArb,
          versionArb,
          async (graph, newNodeName, version) => {
            // Ensure new node name doesn't exist
            fc.pre(!Object.keys(graph.nodes).includes(newNodeName));

            const serialized1 = serializeSchema(graph, version);

            // Create a new graph with an additional node
            const NewNode = defineNode(newNodeName, {
              schema: z.object({ value: z.string() }),
            });
            const extendedGraph = defineGraph({
              id: graph.id,
              nodes: {
                ...graph.nodes,
                [newNodeName]: { type: NewNode },
              },
              edges: graph.edges,
              ontology: graph.ontology,
              defaults: graph.defaults,
            });

            const serialized2 = serializeSchema(extendedGraph, version);

            const hash1 = await computeSchemaHash(serialized1);
            const hash2 = await computeSchemaHash(serialized2);

            expect(hash1).not.toBe(hash2);
          },
        ),
        { numRuns: 30 },
      );
    });

    it("hash is a 16-character hex string", async () => {
      await fc.assert(
        fc.asyncProperty(graphDefArb, versionArb, async (graph, version) => {
          const serialized = serializeSchema(graph, version);
          const hash = await computeSchemaHash(serialized);

          expect(hash).toMatch(/^[a-f0-9]{16}$/);
        }),
        { numRuns: 50 },
      );
    });

    // Pins the omit-when-empty invariant for annotations. Mirrors the
    // same rule applied to `indexes`: absent, explicit-undefined, AND
    // explicit-empty `{}` all hash byte-identically. The unified rule
    // means no consumer ever pays a hash penalty for declaring
    // `annotations: {}` (a common output of spread-based builders or
    // codegen).
    //
    // The "explicit-undefined" case uses a runtime cast to bypass
    // exactOptionalPropertyTypes — that path can only originate from
    // untyped JS callers or spread merges, but consumers can still hit it.
    it("hash is invariant for absent / explicit-undefined / empty {} node annotations", async () => {
      const baseSchema = z.object({ name: z.string() });
      const withoutAnnotations = defineNode("Item", { schema: baseSchema });
      const withUndefinedAnnotations = defineNode("Item", {
        schema: baseSchema,
        annotations: undefined,
      } as unknown as DefineNodeOptions<typeof baseSchema>);
      const withEmptyAnnotations = defineNode("Item", {
        schema: baseSchema,
        annotations: {},
      });

      const buildGraph = (node: typeof withoutAnnotations) =>
        defineGraph({
          id: "annotations_invariant_node",
          nodes: { Item: { type: node } },
          edges: {},
        });

      const hashAbsent = await computeSchemaHash(
        serializeSchema(buildGraph(withoutAnnotations), 1),
      );
      const hashUndefined = await computeSchemaHash(
        serializeSchema(buildGraph(withUndefinedAnnotations), 1),
      );
      const hashEmpty = await computeSchemaHash(
        serializeSchema(buildGraph(withEmptyAnnotations), 1),
      );

      expect(hashUndefined).toBe(hashAbsent);
      expect(hashEmpty).toBe(hashAbsent);
    });

    it("hash is invariant for absent / explicit-undefined / empty {} edge annotations", async () => {
      const Source = defineNode("Source", {
        schema: z.object({ name: z.string() }),
      });
      const Target = defineNode("Target", {
        schema: z.object({ name: z.string() }),
      });

      const withoutAnnotations = defineEdge("links");
      const withUndefinedAnnotations = defineEdge("links", {
        annotations: undefined,
      } as unknown as DefineEdgeOptions<z.ZodObject<z.ZodRawShape>>);
      const withEmptyAnnotations = defineEdge("links", { annotations: {} });

      const buildGraph = (edge: AnyEdgeType) =>
        defineGraph({
          id: "annotations_invariant_edge",
          nodes: {
            Source: { type: Source },
            Target: { type: Target },
          },
          edges: {
            links: { type: edge, from: [Source], to: [Target] },
          },
        });

      const hashAbsent = await computeSchemaHash(
        serializeSchema(buildGraph(withoutAnnotations), 1),
      );
      const hashUndefined = await computeSchemaHash(
        serializeSchema(buildGraph(withUndefinedAnnotations), 1),
      );
      const hashEmpty = await computeSchemaHash(
        serializeSchema(buildGraph(withEmptyAnnotations), 1),
      );

      expect(hashUndefined).toBe(hashAbsent);
      expect(hashEmpty).toBe(hashAbsent);
    });

    it("hash differs for absent vs non-empty annotations", async () => {
      const baseSchema = z.object({ name: z.string() });
      const withoutAnnotations = defineNode("Item", { schema: baseSchema });
      const withAnnotations = defineNode("Item", {
        schema: baseSchema,
        annotations: { ui: "hidden" },
      });

      const buildGraph = (node: typeof withoutAnnotations) =>
        defineGraph({
          id: "annotations_nonempty_diff",
          nodes: { Item: { type: node } },
          edges: {},
        });

      const hashAbsent = await computeSchemaHash(
        serializeSchema(buildGraph(withoutAnnotations), 1),
      );
      const hashSet = await computeSchemaHash(
        serializeSchema(buildGraph(withAnnotations), 1),
      );

      expect(hashSet).not.toBe(hashAbsent);
    });

    // Hash compatibility for any deployment that existed before this field
    // was added depends on the serialized schema_doc omitting `annotations`
    // entirely when none are set — present-as-undefined would still appear
    // in the canonical JSON and bump the hash.
    it("graphs without annotations omit the field from canonical serialization", () => {
      const Person = defineNode("Person", {
        schema: z.object({ name: z.string() }),
      });
      const knows = defineEdge("knows", {
        schema: z.object({ since: z.string() }),
      });

      const graph = defineGraph({
        id: "compat_test",
        nodes: { Person: { type: Person } },
        edges: {
          knows: { type: knows, from: [Person], to: [Person] },
        },
      });

      const serialized = serializeSchema(graph, 1);

      for (const node of Object.values(serialized.nodes)) {
        expect("annotations" in node).toBe(false);
      }
      for (const edge of Object.values(serialized.edges)) {
        expect("annotations" in edge).toBe(false);
      }

      const canonical = JSON.stringify(serialized, sortedReplacer);
      expect(canonical).not.toContain('"annotations"');
    });

    // Indexes are an unordered set keyed by name; an empty list carries
    // no semantic meaning that an absent slice doesn't. Hash and diff
    // both treat `undefined` and `[]` as the canonical "no indexes" form
    // so they can never disagree.
    it("hash collapses absent and empty indexes; differs for non-empty", async () => {
      const Item = defineNode("Item", {
        schema: z.object({ name: z.string() }),
      });

      const buildGraphAbsent = () =>
        defineGraph({
          id: "indexes_invariant",
          nodes: { Item: { type: Item } },
          edges: {},
        });

      const buildGraphEmpty = () =>
        defineGraph({
          id: "indexes_invariant",
          nodes: { Item: { type: Item } },
          edges: {},
          indexes: [],
        });

      const itemNameIndex = defineNodeIndex(Item, { fields: ["name"] });
      const buildGraphWithIndex = () =>
        defineGraph({
          id: "indexes_invariant",
          nodes: { Item: { type: Item } },
          edges: {},
          indexes: [itemNameIndex],
        });

      const hashAbsent = await computeSchemaHash(
        serializeSchema(buildGraphAbsent(), 1),
      );
      const hashEmpty = await computeSchemaHash(
        serializeSchema(buildGraphEmpty(), 1),
      );
      const hashWithIndex = await computeSchemaHash(
        serializeSchema(buildGraphWithIndex(), 1),
      );

      expect(hashEmpty).toBe(hashAbsent);
      expect(hashWithIndex).not.toBe(hashAbsent);
    });

    it("hash is invariant under index ordering", async () => {
      const Item = defineNode("Item", {
        schema: z.object({ name: z.string(), city: z.string() }),
      });

      const nameIndex = defineNodeIndex(Item, { fields: ["name"] });
      const cityIndex = defineNodeIndex(Item, { fields: ["city"] });

      const graphAB = defineGraph({
        id: "indexes_order_invariant",
        nodes: { Item: { type: Item } },
        edges: {},
        indexes: [nameIndex, cityIndex],
      });
      const graphBA = defineGraph({
        id: "indexes_order_invariant",
        nodes: { Item: { type: Item } },
        edges: {},
        indexes: [cityIndex, nameIndex],
      });

      const hashAB = await computeSchemaHash(serializeSchema(graphAB, 1));
      const hashBA = await computeSchemaHash(serializeSchema(graphBA, 1));

      expect(hashAB).toBe(hashBA);
    });

    // The persisted runtime extension document is the durable source the
    // loader uses to rebuild runtime Zod validators. Graphs that have
    // never been runtime-extended must omit the slice entirely so legacy
    // schemas hash byte-identically.
    it("graphs without runtimeDocument omit the field from canonical serialization", () => {
      const Person = defineNode("Person", {
        schema: z.object({ name: z.string() }),
      });

      const graph = defineGraph({
        id: "runtime_doc_omit_compat",
        nodes: { Person: { type: Person } },
        edges: {},
      });

      const serialized = serializeSchema(graph, 1);
      expect("runtimeDocument" in serialized).toBe(false);

      const canonical = JSON.stringify(serialized, sortedReplacer);
      expect(canonical).not.toContain('"runtimeDocument"');
    });

    it("hash differs when a runtimeDocument is present", async () => {
      const Person = defineNode("Person", {
        schema: z.object({ name: z.string() }),
      });

      const baseGraph = defineGraph({
        id: "runtime_doc_hash",
        nodes: { Person: { type: Person } },
        edges: {},
      });

      const baseHash = await computeSchemaHash(serializeSchema(baseGraph, 1));

      const extension = defineRuntimeExtension({
        nodes: {
          Tag: { properties: { name: { type: "string" } } },
        },
      });
      const extendedGraph = mergeRuntimeExtension(baseGraph, extension);
      const extendedHash = await computeSchemaHash(
        serializeSchema(extendedGraph, 1),
      );

      expect(extendedHash).not.toBe(baseHash);
    });

    it("graphs without indexes omit the field from canonical serialization", () => {
      const Person = defineNode("Person", {
        schema: z.object({ name: z.string() }),
      });

      const graph = defineGraph({
        id: "indexes_omit_compat",
        nodes: { Person: { type: Person } },
        edges: {},
      });

      const serialized = serializeSchema(graph, 1);
      expect("indexes" in serialized).toBe(false);

      const canonical = JSON.stringify(serialized, sortedReplacer);
      expect(canonical).not.toContain('"indexes"');
    });

    // `origin: "compile-time"` is the default. The serializer must omit
    // it from the document so only runtime-origin indexes ever cause an
    // `origin` field to appear in the canonical form.
    it("compile-time indexes omit `origin` from canonical serialization", () => {
      const Person = defineNode("Person", {
        schema: z.object({ email: z.string() }),
      });
      const personEmail = defineNodeIndex(Person, { fields: ["email"] });

      const graph = defineGraph({
        id: "compile_origin_omit",
        nodes: { Person: { type: Person } },
        edges: {},
        indexes: [personEmail],
      });

      const serialized = serializeSchema(graph, 1);
      expect(serialized.indexes).toBeDefined();
      for (const index of serialized.indexes ?? []) {
        expect("origin" in index).toBe(false);
      }

      const canonical = JSON.stringify(serialized, sortedReplacer);
      expect(canonical).not.toContain('"origin"');
    });

    // Conversely, `origin: "runtime"` is emitted explicitly so the
    // restart loader can route it through the runtime compiler.
    it('runtime indexes emit `origin: "runtime"` in canonical serialization', () => {
      const Person = defineNode("Person", {
        schema: z.object({ email: z.string() }),
      });
      const compiled = defineNodeIndex(Person, { fields: ["email"] });

      const runtimeIndex: IndexDeclaration = {
        ...compiled,
        origin: "runtime",
      };

      const graph = defineGraph({
        id: "runtime_origin_emit",
        nodes: { Person: { type: Person } },
        edges: {},
        indexes: [runtimeIndex],
      });

      const serialized = serializeSchema(graph, 1);
      expect(serialized.indexes).toBeDefined();
      expect(serialized.indexes?.[0]?.origin).toBe("runtime");

      const canonical = JSON.stringify(serialized, sortedReplacer);
      expect(canonical).toContain('"origin":"runtime"');
    });

    // Round-trip: a serialized schema with indexes survives JSON
    // serialization and zod parsing without canonical-form drift.
    it("round-trips a graph with indexes through JSON and serializedSchemaZod", () => {
      const Person = defineNode("Person", {
        schema: z.object({ email: z.string(), name: z.string() }),
      });
      const Activity = defineEdge("performed", {
        schema: z.object({ at: z.string() }),
      });
      const personEmail = defineNodeIndex(Person, {
        fields: ["email"],
        unique: true,
      });
      const performedAt = defineEdgeIndex(Activity, {
        fields: ["at"],
        direction: "out",
      });

      const graph = defineGraph({
        id: "roundtrip_indexes",
        nodes: { Person: { type: Person } },
        edges: {
          performed: { type: Activity, from: [Person], to: [Person] },
        },
        indexes: [personEmail, performedAt],
      });

      const serialized = serializeSchema(graph, 1);
      const json = JSON.stringify(serialized, sortedReplacer);
      const parsed = serializedSchemaZod.parse(JSON.parse(json));
      const reSerialized = JSON.stringify(parsed, sortedReplacer);

      expect(reSerialized).toBe(json);
    });
  });

  describe("serialization properties", () => {
    it("all node names are preserved in serialization", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);

          const originalNames = Object.keys(graph.nodes).toSorted();
          const serializedNames = Object.keys(serialized.nodes).toSorted();

          expect(serializedNames).toEqual(originalNames);
        }),
        { numRuns: 50 },
      );
    });

    it("all edge names are preserved in serialization", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);

          const originalNames = Object.keys(graph.edges).toSorted();
          const serializedNames = Object.keys(serialized.edges).toSorted();

          expect(serializedNames).toEqual(originalNames);
        }),
        { numRuns: 50 },
      );
    });

    it("edge fromKinds and toKinds reference valid node names", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);
          const nodeNames = new Set(Object.keys(serialized.nodes));

          for (const edgeDef of Object.values(serialized.edges)) {
            for (const fromKind of edgeDef.fromKinds) {
              expect(nodeNames.has(fromKind)).toBe(true);
            }
            for (const toKind of edgeDef.toKinds) {
              expect(nodeNames.has(toKind)).toBe(true);
            }
          }
        }),
        { numRuns: 50 },
      );
    });

    it("ontology relations reference valid node names or external IRIs", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);
          const nodeNames = new Set(Object.keys(serialized.nodes));

          for (const relation of serialized.ontology.relations) {
            // from/to should be node names (or could be IRIs for external refs)
            const isFromValid =
              nodeNames.has(relation.from) || relation.from.includes("://");
            const isToValid =
              nodeNames.has(relation.to) || relation.to.includes("://");

            expect(isFromValid).toBe(true);
            expect(isToValid).toBe(true);
          }
        }),
        { numRuns: 50 },
      );
    });

    it("node properties are valid JSON Schema objects", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);

          for (const nodeDef of Object.values(serialized.nodes)) {
            expect(nodeDef.properties).toBeDefined();
            expect(typeof nodeDef.properties).toBe("object");
            // Zod objects serialize to JSON Schema with type: "object"
            expect(nodeDef.properties.type).toBe("object");
          }
        }),
        { numRuns: 50 },
      );
    });

    it("generatedAt is a valid ISO timestamp", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);

          // Should be parseable as a date
          const date = new Date(serialized.generatedAt);
          expect(Number.isNaN(date.getTime())).toBe(false);

          // Should be recent (within last minute)
          const now = Date.now();
          const timestamp = date.getTime();
          expect(timestamp).toBeLessThanOrEqual(now + 1000);
          expect(timestamp).toBeGreaterThan(now - 60_000);
        }),
        { numRuns: 20 },
      );
    });
  });

  describe("closure properties", () => {
    it("subClassAncestors contains transitive closure", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);
          const closures = serialized.ontology.closures;

          // If A -> B in ancestors and B -> C in ancestors
          // then A should have C in its ancestors
          for (const [_kind, ancestors] of Object.entries(
            closures.subClassAncestors,
          )) {
            for (const ancestor of ancestors) {
              const ancestorAncestors =
                closures.subClassAncestors[ancestor] ?? [];
              for (const grandAncestor of ancestorAncestors) {
                expect(ancestors).toContain(grandAncestor);
              }
            }
          }
        }),
        { numRuns: 30 },
      );
    });

    it("subClassDescendants is inverse of subClassAncestors", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);
          const closures = serialized.ontology.closures;

          // If A has ancestor B, then B should have descendant A
          for (const [kind, ancestors] of Object.entries(
            closures.subClassAncestors,
          )) {
            for (const ancestor of ancestors) {
              const descendants = closures.subClassDescendants[ancestor] ?? [];
              expect(descendants).toContain(kind);
            }
          }

          // If B has descendant A, then A should have ancestor B
          for (const [kind, descendants] of Object.entries(
            closures.subClassDescendants,
          )) {
            for (const descendant of descendants) {
              const ancestors = closures.subClassAncestors[descendant] ?? [];
              expect(ancestors).toContain(kind);
            }
          }
        }),
        { numRuns: 30 },
      );
    });
  });

  describe("registry building", () => {
    it("buildRegistry produces valid KindRegistry", () => {
      fc.assert(
        fc.property(graphDefArb, versionArb, (graph, version) => {
          const serialized = serializeSchema(graph, version);
          const deserialized = deserializeSchema(serialized);

          // Should not throw
          const registry = deserialized.buildRegistry();

          // Registry should exist
          expect(registry).toBeDefined();
        }),
        { numRuns: 30 },
      );
    });
  });
});
