/**
 * TypeGraph: Type-Driven Embedded Knowledge Graph for TypeScript
 *
 * The package root is the application surface: the graph and ontology DSL,
 * the store factories, the everyday query helpers, and the errors an
 * application catches. Everything else is reachable from a subpath:
 *
 * - `@nicia-ai/typegraph/store`: store option, result and surface types
 * - `@nicia-ai/typegraph/query`: query-builder, fragment and relation types
 * - `@nicia-ai/typegraph/errors`: the complete error catalogue
 * - `@nicia-ai/typegraph/identity`: the identity-ledger surface
 * - `@nicia-ai/typegraph/core`: graph-definition and ontology declaration types
 * - `@nicia-ai/typegraph/schema`, `/indexes`, `/graph-extension`, ...
 *
 * @example
 * ```typescript
 * import * as tg from "@nicia-ai/typegraph";
 * import { z } from "zod";
 *
 * const Person = tg.defineNode("Person", {
 *   schema: z.object({
 *     fullName: z.string(),
 *     email: z.string().email().optional(),
 *   }),
 * });
 *
 * const Company = tg.defineNode("Company", {
 *   schema: z.object({
 *     name: z.string(),
 *     industry: z.string(),
 *   }),
 * });
 *
 * const worksAt = tg.defineEdge("worksAt", {
 *   schema: z.object({
 *     role: z.string(),
 *   }),
 * });
 *
 * const graph = tg.defineGraph({
 *   id: "my_graph",
 *   nodes: {
 *     Person: { type: Person },
 *     Company: { type: Company },
 *   },
 *   edges: {
 *     worksAt: {
 *       type: worksAt,
 *       from: [Person],
 *       to: [Company],
 *     },
 *   },
 *   ontology: [tg.disjointWith(Person, Company)],
 * });
 * ```
 */

// ============================================================
// Graph DSL
// ============================================================

export {
  asEdgeId,
  asNodeId,
  createExternalRef,
  defineEdge,
  defineGraph,
  defineNode,
  type EdgeId,
  type EdgeKinds,
  type EdgeProps,
  type EdgeType,
  embedding,
  externalRef,
  type GraphDef,
  type NodeId,
  type NodeKinds,
  type NodeProps,
  type NodeType,
  searchable,
} from "./core";

// Types a defineNode/defineEdge/defineGraph/ontology result is spelled with.
// They are owned by `/core` and `/graph-extension`; the root re-exports
// them, type-only, so a consumer that emits declarations for an exported
// graph can name its inferred type without importing another entrypoint
// (TypeScript only names a type through a module the program already
// imports).
export type {
  DeleteBehavior,
  EmbeddingSchema,
  EmbeddingValue,
  GraphAnnotations,
  KindAnnotations,
  SearchableSchema,
  TemporalMode,
  TypedOntologyRelation,
} from "./core";
export type {
  ExtensionEdgeDef,
  ExtensionIndex,
  ExtensionNodeDef,
  ExtensionOntologyRelation,
  GraphExtensionVersion,
} from "./graph-extension/extension-types";

// ============================================================
// Ontology DSL
// ============================================================

export {
  broader,
  disjointWith,
  equivalentTo,
  hasPart,
  implies,
  inverseOf,
  narrower,
  partOf,
  relatedTo,
  subClassOf,
} from "./ontology";

// ============================================================
// Store
// ============================================================

export type { GraphBackend } from "./backend/types";
export {
  createAdapterStore,
  createAdapterStoreWithSchema,
  createStore,
  createStoreWithSchema,
  type Store,
} from "./store";
export type { ReadSetScope } from "./store/read-set";
export type {
  Edge,
  EdgeCollection,
  EdgeInGraph,
  Node,
  NodeCollection,
  NodeRef,
  StoreOptions,
  TransactionContext,
} from "./store/types";

// ============================================================
// Query
// ============================================================

export {
  avg,
  count,
  countDistinct,
  exists,
  field,
  having,
  havingEq,
  havingGt,
  havingGte,
  havingLt,
  havingLte,
  inSubquery,
  max,
  min,
  notExists,
  notInSubquery,
  type PaginatedResult,
  param,
  type Predicate,
  sum,
} from "./query";
export { expr } from "./query/expressions";
// The class behind `store.query()...select(...)`, type-only: naming an
// exported query in emitted declarations needs it, constructing one does not.
export type { ExecutableQuery } from "./query";

// ============================================================
// Errors
// ============================================================

export {
  CardinalityError,
  CompositionError,
  CompositionExistenceError,
  ConfigurationError,
  DisjointError,
  EdgeNotFoundError,
  EndpointError,
  EndpointNotFoundError,
  type ErrorCategory,
  isConstraintError,
  isSystemError,
  isTypeGraphError,
  isUserRecoverable,
  KindNotFoundError,
  MigrationError,
  NodeNotFoundError,
  ReadSetChangedError,
  ReadSetUnverifiableError,
  RestrictedDeleteError,
  SchemaMismatchError,
  StaleVersionError,
  StoreNotInitializedError,
  TransactionConflictError,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
  TypeGraphError,
  UniquenessError,
  ValidationError,
} from "./errors";
