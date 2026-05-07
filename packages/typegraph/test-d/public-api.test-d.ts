import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  type BatchableQuery,
  defineEdge,
  defineGraph,
  defineNode,
  type DynamicEdgeCollection,
  type DynamicNodeCollection,
  type Edge,
  type EdgeId,
  getEdgeKinds,
  getNodeKinds,
  type KindAnnotations,
  type NodeId,
  type NodeRef,
  type Store,
} from "..";

const Person = defineNode("Person", {
  schema: z.object({
    email: z.string(),
    name: z.string(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
  }),
});

const Project = defineNode("Project", {
  schema: z.object({
    title: z.string(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

const knows = defineEdge("knows");

const Incident = defineNode("Incident", {
  schema: z.object({
    title: z.string(),
  }),
  annotations: {
    ui: { titleField: "title" },
  },
});

const reportedBy = defineEdge("reportedBy", {
  annotations: {
    ui: { showInTimeline: true },
  },
});

// KindAnnotations rejects non-JSON values at the type level.
expectError(
  defineNode("BadBigInt", {
    schema: z.object({ name: z.string() }),
    annotations: { audit: { version: 1n } },
  }),
);
expectError(
  defineNode("BadFunction", {
    schema: z.object({ name: z.string() }),
    annotations: { onClick: () => undefined },
  }),
);
expectError(
  defineNode("BadSymbol", {
    schema: z.object({ name: z.string() }),
    annotations: { tag: Symbol("x") },
  }),
);
expectError(
  defineNode("BadUndefined", {
    schema: z.object({ name: z.string() }),
    annotations: { value: undefined },
  }),
);
expectError(
  defineNode("BadNested", {
    schema: z.object({ name: z.string() }),
    annotations: { audit: { handler: () => undefined } },
  }),
);
expectError(
  defineEdge("badEdgeBigInt", {
    annotations: { count: 99n },
  }),
);

const graph = defineGraph({
  id: "public_api_test_graph",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "email_unique",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
        {
          name: "name_unique",
          fields: ["name"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Company: { type: Company },
    Project: { type: Project },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
    },
  },
  ontology: [],
});

declare const store: Store<typeof graph>;
declare const worksAtId: EdgeId<typeof worksAt>;
declare const worksAtEdge: Awaited<
  ReturnType<typeof store.edges.worksAt.create>
>;

const nodeKinds = getNodeKinds(graph);
const edgeKinds = getEdgeKinds(graph);

expectType<readonly ("Person" | "Company" | "Project")[]>(nodeKinds);
expectType<readonly ("worksAt" | "knows")[]>(edgeKinds);
expectType<KindAnnotations | undefined>(Incident.annotations);
expectType<KindAnnotations | undefined>(reportedBy.annotations);

expectAssignable<NodeRef>({ kind: "AnyKind", id: "node-id" });
expectAssignable<Parameters<typeof store.edges.worksAt.create>[0]>({
  kind: "Person",
  id: "person-id",
});

expectType<EdgeId<typeof worksAt>>(worksAtEdge.id);
expectType<"Person">(worksAtEdge.fromKind);
expectType<NodeId<typeof Person>>(worksAtEdge.fromId);
expectType<"Company">(worksAtEdge.toKind);
expectType<NodeId<typeof Company>>(worksAtEdge.toId);

void store.edges.worksAt.getById(worksAtId);
expectError(store.edges.knows.getById(worksAtId));

void store.nodes.Person.findByConstraint("email_unique", {
  email: "alice@example.com",
  name: "Alice",
});
void store.nodes.Person.findByConstraint("name_unique", {
  email: "alice@example.com",
  name: "Alice",
});

expectError(
  store.nodes.Person.findByConstraint("missing_constraint", {
    email: "alice@example.com",
    name: "Alice",
  }),
);

expectError(
  store.nodes.Project.findByConstraint("title_unique", {
    title: "Roadmap",
  }),
);

// ============================================================
// Edge batchFind* — published .d.ts surface
// ============================================================

declare const personRef: NodeRef<typeof Person>;
declare const companyRef: NodeRef<typeof Company>;

// batchFindFrom / batchFindTo return BatchableQuery with correct edge type
type WorksAtEdge = Edge<typeof worksAt, typeof Person, typeof Company>;

expectType<BatchableQuery<WorksAtEdge>>(
  store.edges.worksAt.batchFindFrom(personRef),
);
expectType<BatchableQuery<WorksAtEdge>>(
  store.edges.worksAt.batchFindTo(companyRef),
);
expectType<BatchableQuery<WorksAtEdge>>(
  store.edges.worksAt.batchFindByEndpoints(personRef, companyRef),
);

// Endpoint constraints are enforced on batchFind* methods
expectError(store.edges.worksAt.batchFindFrom(companyRef));
expectError(store.edges.worksAt.batchFindTo(personRef));
expectError(store.edges.worksAt.batchFindByEndpoints(companyRef, personRef));

// ============================================================
// Dynamic collection — ID parameters accept plain string
// ============================================================

declare const dynamicNode: DynamicNodeCollection;
declare const dynamicEdge: DynamicEdgeCollection;
declare const plainId: string;

// DynamicNodeCollection accepts plain string for all ID methods
void dynamicNode.getById(plainId);
void dynamicNode.getByIds([plainId]);
void dynamicNode.update(plainId, {});
void dynamicNode.delete(plainId);
void dynamicNode.hardDelete(plainId);
void dynamicNode.bulkDelete([plainId]);

// DynamicEdgeCollection accepts plain string for all ID methods
void dynamicEdge.getById(plainId);
void dynamicEdge.getByIds([plainId]);
void dynamicEdge.update(plainId, {});
void dynamicEdge.delete(plainId);
void dynamicEdge.hardDelete(plainId);
void dynamicEdge.bulkDelete([plainId]);
void dynamicEdge.bulkUpsertById([
  { id: plainId, from: { kind: "X", id: "1" }, to: { kind: "Y", id: "2" } },
]);

// getNodeCollection / getEdgeCollection return the dynamic types
expectAssignable<DynamicNodeCollection | undefined>(
  store.getNodeCollection("Person"),
);
expectAssignable<DynamicEdgeCollection | undefined>(
  store.getEdgeCollection("worksAt"),
);

// ============================================================
// Graph extension — public surface published in 0.25
// ============================================================

import {
  defineGraphExtension,
  defineEdgeIndex,
  defineNodeIndex,
  type EdgeIndexDeclaration,
  type IndexDeclaration,
  type MaterializeIndexesEntry,
  type MaterializeIndexesResult,
  type NodeIndexDeclaration,
  type ExtensionArrayProperty,
  type ExtensionEdgeDef,
  type GraphExtensionIssue,
  type GraphExtensionIssueCode,
  type GraphExtension,
  type ExtensionNodeDef,
  type ExtensionOntologyRelation,
  type ExtensionPropertyType,
  type ExtensionStringProperty,
  type ExtensionUniqueConstraint,
  type IncompatibleChange,
  type StoreRef,
  validateGraphExtension,
  GraphExtensionError,
  GraphExtensionUnresolvedEndpointError,
  GraphExtensionValidationError,
  GraphExtensionVersionUnsupportedError,
  IncompatibleChangeError,
  KindCollisionError,
  KindHasReferentsError,
  KindNotFoundError,
  RemoveCompileTimeKindError,
  TypeGraphError,
} from "..";

// defineGraphExtension accepts a typed GraphExtension.
const extension = defineGraphExtension({
  nodes: {
    Paper: {
      properties: {
        doi: {
          type: "string",
          format: "uri",
        } satisfies ExtensionStringProperty,
        embedding: {
          type: "array",
          items: { type: "number" },
          embedding: { dimensions: 384 },
        } satisfies ExtensionArrayProperty,
      },
    } satisfies ExtensionNodeDef,
  },
});
expectType<GraphExtension>(extension);

// Top-level key typo `node` should be a TypeScript error — the public
// type signature now catches it at the call site instead of letting
// the runtime silently produce an empty extension.
expectError(
  defineGraphExtension({
    node: { Paper: { properties: { doi: { type: "string" } } } },
  }),
);

// validateGraphExtension keeps `unknown` input + Result return for
// callers feeding LLM-authored JSON.
declare const llmJson: unknown;
const validateResult = validateGraphExtension(llmJson, { strict: true });
expectAssignable<
  | { success: true; data: GraphExtension }
  | { success: false; error: GraphExtensionValidationError }
>(validateResult);

// GraphExtensionIssue / IssueCode shapes.
declare const issue: GraphExtensionIssue;
expectType<string>(issue.path);
expectType<string>(issue.message);
expectAssignable<GraphExtensionIssueCode>(issue.code);
expectAssignable<GraphExtensionIssueCode>("UNKNOWN_DOCUMENT_KEY" as const);
expectAssignable<GraphExtensionIssueCode>("UNSUPPORTED_STRING_FORMAT" as const);

// Edge / ontology / unique runtime types.
declare const runtimeEdge: ExtensionEdgeDef;
expectType<readonly string[]>(runtimeEdge.from);
declare const runtimeOntology: ExtensionOntologyRelation;
expectType<string>(runtimeOntology.from);
declare const runtimeUnique: ExtensionUniqueConstraint;
expectType<readonly string[]>(runtimeUnique.fields);
declare const runtimeProperty: ExtensionPropertyType;
expectAssignable<"string" | "number" | "boolean" | "enum" | "array" | "object">(
  runtimeProperty.type,
);

// StoreRef is a plain mutable handle. Compose, then evolve.
declare const evolveStore: Store<typeof graph>;
const ref: StoreRef<typeof evolveStore> = { current: evolveStore };
expectType<typeof evolveStore>(ref.current);

// Materialize-indexes result types.
declare const materializeResult: MaterializeIndexesResult;
expectType<readonly MaterializeIndexesEntry[]>(materializeResult.results);
declare const materializeEntry: MaterializeIndexesEntry;
expectAssignable<"created" | "alreadyMaterialized" | "failed" | "skipped">(
  materializeEntry.status,
);
expectAssignable<"node" | "edge" | "vector">(materializeEntry.entity);

// defineNodeIndex / defineEdgeIndex are the current 1.0 surface — the
// `(Type, { fields: [...] })` config shape, not the legacy
// `(name, fields[])` positional shape.
const nodeIndex: NodeIndexDeclaration = defineNodeIndex(Person, {
  fields: ["name"],
});
expectAssignable<IndexDeclaration>(nodeIndex);
expectType<"node">(nodeIndex.entity);

const edgeIndex: EdgeIndexDeclaration = defineEdgeIndex(worksAt, {
  fields: ["role"],
});
expectAssignable<IndexDeclaration>(edgeIndex);
expectType<"edge">(edgeIndex.entity);

// ============================================================
// Search facade — runtime-kind ergonomics
// ============================================================

// `store.search.{fulltext,vector,hybrid,rebuildFulltext}` accepts
// any string for the kind argument. The hit's `node` type narrows
// to the concrete typed node when the literal is a compile-time
// kind, and widens to the base `Node` for runtime kinds (no cast
// required).

import { type Node } from "..";

declare const personHits: Awaited<
  ReturnType<typeof store.search.fulltext<"Person">>
>;
declare const runtimeHits: Awaited<
  ReturnType<typeof store.search.fulltext<"Paper">>
>;

// Compile-time kind narrows to Node<typeof Person>.
expectAssignable<Node<typeof Person>>(personHits[0]!.node);

// Runtime kind widens to base Node — assignable to Node, not narrowed.
expectAssignable<Node>(runtimeHits[0]!.node);

// vector + hybrid follow the same pattern.
declare const vectorHits: Awaited<
  ReturnType<typeof store.search.vector<"Paper">>
>;
expectAssignable<Node>(vectorHits[0]!.node);

declare const hybridHits: Awaited<
  ReturnType<typeof store.search.hybrid<"Paper">>
>;
expectAssignable<Node>(hybridHits[0]!.node);

// Compile-time hybrid narrows.
declare const compileTimeHybrid: Awaited<
  ReturnType<typeof store.search.hybrid<"Person">>
>;
expectAssignable<Node<typeof Person>>(compileTimeHybrid[0]!.node);

// ============================================================
// Error class hierarchy — every public error is reachable as
// TypeGraphError, and the GraphExtension family is reachable as
// GraphExtensionError. Pinning these guards against an accidental
// inheritance flip during refactors.
// ============================================================

declare const graphExtensionError: GraphExtensionError;
expectAssignable<TypeGraphError>(graphExtensionError);
expectType<string>(graphExtensionError.code);

// Validation error: structured `issues` list with frozen entries.
declare const validationError: GraphExtensionValidationError;
expectAssignable<GraphExtensionError>(validationError);
expectType<readonly GraphExtensionIssue[]>(validationError.issues);
expectType<"GRAPH_EXTENSION_INVALID">(validationError.code);

// Version-unsupported error: persisted/current numeric majors.
declare const versionError: GraphExtensionVersionUnsupportedError;
expectAssignable<GraphExtensionError>(versionError);
expectType<number>(versionError.persistedVersion);
expectType<number>(versionError.currentVersion);
expectType<"GRAPH_EXTENSION_VERSION_UNSUPPORTED">(versionError.code);

// Unresolved endpoint: edge + side + endpoint kind name.
declare const unresolvedEndpointError: GraphExtensionUnresolvedEndpointError;
expectAssignable<GraphExtensionError>(unresolvedEndpointError);
expectType<string>(unresolvedEndpointError.edgeKind);
expectType<"from" | "to">(unresolvedEndpointError.side);
expectType<string>(unresolvedEndpointError.endpoint);
expectType<"GRAPH_EXTENSION_UNRESOLVED_ENDPOINT">(unresolvedEndpointError.code);

// Kind-collision: declared kind name shadows a compile-time kind.
declare const kindCollisionError: KindCollisionError;
expectAssignable<GraphExtensionError>(kindCollisionError);
expectType<string>(kindCollisionError.kindName);
expectType<"node" | "edge">(kindCollisionError.entity);
expectType<"KIND_COLLISION">(kindCollisionError.code);

// Incompatible-change: structured `changes` list (one entry per delta).
declare const incompatibleError: IncompatibleChangeError;
expectAssignable<GraphExtensionError>(incompatibleError);
expectType<readonly IncompatibleChange[]>(incompatibleError.changes);
expectType<"INCOMPATIBLE_CHANGE">(incompatibleError.code);

// Kind-has-referents: removeKinds blocked by a referent declaration.
// Carries the structured `referents` list so a UI can show every
// compile-time edge / ontology declaration that points at the kind.
declare const referentsError: KindHasReferentsError;
expectAssignable<GraphExtensionError>(referentsError);
expectType<string>(referentsError.kindName);
expectType<"KIND_HAS_REFERENTS">(referentsError.code);
expectAssignable<
  readonly Readonly<{
    type: "compile-time-edge" | "compile-time-ontology";
    name: string;
  }>[]
>(referentsError.referents);

// Remove-compile-time-kind: removeKinds attempted against a static kind.
declare const removeCompileTimeError: RemoveCompileTimeKindError;
expectAssignable<GraphExtensionError>(removeCompileTimeError);
expectType<string>(removeCompileTimeError.kindName);
expectType<"node" | "edge">(removeCompileTimeError.entity);
expectType<"REMOVE_COMPILE_TIME_KIND">(removeCompileTimeError.code);

// Kind-not-found is general (not in the GraphExtension hierarchy)
// but carries the same kindName / entity discriminators.
declare const notFoundError: KindNotFoundError;
expectAssignable<TypeGraphError>(notFoundError);
expectType<string>(notFoundError.kindName);
expectType<"node" | "edge">(notFoundError.entity);

// `instanceof` checks narrow to the concrete subclass — the abstract
// base's `code: string` widens to `string`, but each concrete class
// pins its `code` as a literal, so the narrowed branch can branch on
// the field. A consumer can catch the family with one
// `instanceof GraphExtensionError`, then switch on `error.code` for
// per-subclass handling.
function classifyExtensionError(error: GraphExtensionError): string {
  if (error instanceof GraphExtensionValidationError) {
    expectType<"GRAPH_EXTENSION_INVALID">(error.code);
    return error.issues.length.toString();
  }
  if (error instanceof GraphExtensionVersionUnsupportedError) {
    expectType<"GRAPH_EXTENSION_VERSION_UNSUPPORTED">(error.code);
    return `v${error.persistedVersion}`;
  }
  if (error instanceof GraphExtensionUnresolvedEndpointError) {
    expectType<"GRAPH_EXTENSION_UNRESOLVED_ENDPOINT">(error.code);
    return error.edgeKind;
  }
  if (error instanceof KindCollisionError) {
    expectType<"KIND_COLLISION">(error.code);
    return error.kindName;
  }
  if (error instanceof KindHasReferentsError) {
    expectType<"KIND_HAS_REFERENTS">(error.code);
    return `${error.kindName} (${error.referents.length} referents)`;
  }
  if (error instanceof IncompatibleChangeError) {
    expectType<"INCOMPATIBLE_CHANGE">(error.code);
    return error.changes.length.toString();
  }
  if (error instanceof RemoveCompileTimeKindError) {
    expectType<"REMOVE_COMPILE_TIME_KIND">(error.code);
    return error.kindName;
  }
  return "unknown";
}
expectType<(error: GraphExtensionError) => string>(classifyExtensionError);
