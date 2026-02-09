import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph } from "../../src/core/define-graph";
import { defineEdge } from "../../src/core/edge";
import { defineNode } from "../../src/core/node";
import {
  type Cardinality,
  type DeleteBehavior,
  type EndpointExistence,
  type TemporalMode,
} from "../../src/core/types";
import {
  broader,
  disjointWith,
  equivalentTo,
  hasPart,
  partOf,
  relatedTo,
  subClassOf,
} from "../../src/ontology/core-meta-edges";
import { deserializeSchema } from "../../src/schema/deserializer";
import {
  computeSchemaHash,
  serializeSchema,
} from "../../src/schema/serializer";

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
  })
  .map(({ name, schema, description }) =>
    defineNode(name, description ? { schema, description } : { schema }),
  );

/**
 * Generate an edge type with optional schema.
 */
const edgeTypeArb = fc
  .record({
    name: edgeIdentifierArb,
    schema: fc.option(simpleZodSchemaArb, { nil: undefined }),
    description: descriptionArb,
  })
  .map(({ name, schema, description }) => {
    if (schema && description) return defineEdge(name, { schema, description });
    if (schema) return defineEdge(name, { schema });
    if (description) return defineEdge(name, { description });
    return defineEdge(name, {});
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
      if (seen.has(n.name)) return false;
      seen.add(n.name);
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
      if (seen.has(edge.name)) return false;
      seen.add(edge.name);
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
          key: node.name,
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
              key: edge.name,
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
                : relation.from.name;
              const toName =
                typeof relation.to === "string" ?
                  relation.to
                : relation.to.name;
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

          // Check metadata
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
            expect(node!.name).toBe(name);
          }

          // Check edge names
          const expectedEdgeNames = Object.keys(graph.edges).toSorted();
          const actualEdgeNames = [...deserialized.getEdgeNames()].toSorted();
          expect(actualEdgeNames).toEqual(expectedEdgeNames);

          // Check each edge
          for (const name of expectedEdgeNames) {
            const edge = deserialized.getEdge(name);
            expect(edge).toBeDefined();
            expect(edge!.name).toBe(name);
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
