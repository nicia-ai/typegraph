/**
 * Declaration-safe structural view of TypeGraph's collection store.
 *
 * These public types deliberately depend only on the core graph DSL and Zod.
 * Backend, query-builder, transaction, history, and raw SQL types are omitted.
 */
import { type z } from "zod";

import { type GraphDef } from "../core/define-graph";
import {
  type AnyEdgeType,
  type EdgeId,
  type EdgeRegistration,
  type NodeId,
  type NodeType,
} from "../core/types";

/** Creation options shared by node and edge collection writes. */
export type TypedCreateOptions = Readonly<{
  id?: string;
  validFrom?: string;
  validTo?: string;
}>;

/** Temporal and audit metadata returned with a node. */
export type TypedNodeMeta = Readonly<{
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | undefined;
  version: number;
}>;

/** Temporal and audit metadata returned with an edge. */
export type TypedEdgeMeta = Readonly<{
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | undefined;
}>;

/** A schema-derived node returned by the typed store facade. */
export type TypedNode<N extends NodeType> = Readonly<{
  kind: N["kind"];
  id: NodeId<N>;
  meta: TypedNodeMeta;
}> &
  Readonly<z.output<N["schema"]>>;

/** A schema-derived edge returned by the typed store facade. */
export type TypedEdge<
  E extends AnyEdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Readonly<{
  id: EdgeId<E>;
  kind: E["kind"];
  fromKind: From["kind"];
  fromId: NodeId<From>;
  toKind: To["kind"];
  toId: NodeId<To>;
  meta: TypedEdgeMeta;
}> &
  Readonly<z.output<E["schema"]>>;

/** A typed node or explicit node identity accepted as an edge endpoint. */
export type TypedNodeRef<N extends NodeType> =
  TypedNode<N> | Readonly<{ kind: N["kind"]; id: string }>;

/** Pagination supported by the declaration-safe collection facade. */
export type TypedFindOptions = Readonly<{
  limit?: number;
  offset?: number;
}>;

/** Safe CRUD operations for one schema-derived node kind. */
export type TypedNodeCollection<N extends NodeType> = Readonly<{
  create: (
    props: z.input<N["schema"]>,
    options?: TypedCreateOptions,
  ) => Promise<TypedNode<N>>;
  getById: (id: NodeId<N>) => Promise<TypedNode<N> | undefined>;
  getByIds: (
    ids: readonly NodeId<N>[],
  ) => Promise<readonly (TypedNode<N> | undefined)[]>;
  update: (
    id: NodeId<N>,
    props: Partial<z.input<N["schema"]>>,
    options?: Readonly<{ validTo?: string }>,
  ) => Promise<TypedNode<N>>;
  delete: (id: NodeId<N>) => Promise<void>;
  find: (options?: TypedFindOptions) => Promise<TypedNode<N>[]>;
  count: () => Promise<number>;
}>;

/**
 * Arguments after edge endpoints. Properties are optional only when the edge
 * schema accepts an empty object.
 */
/* eslint-disable @typescript-eslint/no-empty-object-type -- {} tests whether the schema accepts an empty object */
export type TypedEdgeCreateArguments<E extends AnyEdgeType> =
  {} extends z.input<E["schema"]> ?
    [props?: z.input<E["schema"]>, options?: TypedCreateOptions]
  : [props: z.input<E["schema"]>, options?: TypedCreateOptions];
/* eslint-enable @typescript-eslint/no-empty-object-type */

/** Safe CRUD operations for one schema-derived edge kind. */
export type TypedEdgeCollection<
  E extends AnyEdgeType,
  From extends NodeType = NodeType,
  To extends NodeType = NodeType,
> = Readonly<{
  create: (
    from: TypedNodeRef<From>,
    to: TypedNodeRef<To>,
    ...args: TypedEdgeCreateArguments<E>
  ) => Promise<TypedEdge<E, From, To>>;
  getById: (id: EdgeId<E>) => Promise<TypedEdge<E, From, To> | undefined>;
  getByIds: (
    ids: readonly EdgeId<E>[],
  ) => Promise<readonly (TypedEdge<E, From, To> | undefined)[]>;
  update: (
    id: EdgeId<E>,
    props: Partial<z.input<E["schema"]>>,
    options?: Readonly<{ validTo?: string }>,
  ) => Promise<TypedEdge<E, From, To>>;
  delete: (id: EdgeId<E>) => Promise<void>;
  findFrom: (from: TypedNodeRef<From>) => Promise<TypedEdge<E, From, To>[]>;
  findTo: (to: TypedNodeRef<To>) => Promise<TypedEdge<E, From, To>[]>;
  find: (
    options?: TypedFindOptions &
      Readonly<{
        from?: TypedNodeRef<From>;
        to?: TypedNodeRef<To>;
      }>,
  ) => Promise<TypedEdge<E, From, To>[]>;
  count: (
    endpoints?: Readonly<{
      from?: TypedNodeRef<From>;
      to?: TypedNodeRef<To>;
    }>,
  ) => Promise<number>;
}>;

/** Schema-derived node collections for a graph. */
export type TypedNodeCollections<G extends GraphDef> = {
  [K in keyof G["nodes"] & string]-?: TypedNodeCollection<
    G["nodes"][K]["type"]
  >;
};

/** Extracts the permitted source node types from an edge registration. */
export type TypedEdgeFromTypes<R extends EdgeRegistration> =
  R["from"] extends readonly (infer N)[] ? N : never;

/** Extracts the permitted target node types from an edge registration. */
export type TypedEdgeToTypes<R extends EdgeRegistration> =
  R["to"] extends readonly (infer N)[] ? N : never;

/** Builds a typed edge collection from a graph edge registration. */
export type TypedEdgeCollectionFor<R extends EdgeRegistration> =
  TypedEdgeCollection<
    R["type"],
    TypedEdgeFromTypes<R> extends NodeType ? TypedEdgeFromTypes<R> : NodeType,
    TypedEdgeToTypes<R> extends NodeType ? TypedEdgeToTypes<R> : NodeType
  >;

/** Schema-derived edge collections for a graph. */
export type TypedEdgeCollections<G extends GraphDef> = {
  [K in keyof G["edges"] & string]-?: TypedEdgeCollectionFor<G["edges"][K]>;
};

/**
 * Narrow structural view of the existing runtime Store.
 *
 * Advanced query, backend, transaction, history, and raw SQL members are
 * intentionally absent so their Drizzle-linked declarations remain outside a
 * strict consumer's TypeScript program.
 */
export type TypedStoreFacade<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  nodes: TypedNodeCollections<G>;
  edges: TypedEdgeCollections<G>;
  close: () => Promise<void>;
}>;
