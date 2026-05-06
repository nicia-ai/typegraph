/**
 * One-way compiler from a validated `RuntimeGraphDocument` to Zod-bearing
 * `NodeType` / `EdgeType` / `OntologyRelation` values.
 *
 * The output is structurally indistinguishable from equivalent
 * compile-time `defineNode` / `defineEdge` declarations: `searchable()`
 * and `embedding()` wrappers are reapplied so introspection helpers see
 * the same metadata, optional properties use the standard `.optional()`
 * chain, and unique-constraint `where` callbacks return the predicate
 * shape `serializeWherePredicate` consumes.
 */
import { z, type ZodObject, type ZodRawShape, type ZodType } from "zod";

import { defineEdge } from "../core/edge";
import { embedding } from "../core/embedding";
import { defineNode } from "../core/node";
import { searchable } from "../core/searchable";
import {
  type EdgeType,
  type NodeType,
  type UniqueConstraint,
} from "../core/types";
import { ALL_META_EDGE_NAMES, type MetaEdgeName } from "../ontology/constants";
import { core as coreOntology } from "../ontology/core-meta-edges";
import { type MetaEdge, type OntologyRelation } from "../ontology/types";
import {
  type RuntimeArrayItemType,
  type RuntimeArrayProperty,
  type RuntimeEdgeDocument,
  type RuntimeEnumProperty,
  type RuntimeGraphDocument,
  type RuntimeNodeDocument,
  type RuntimeNumberProperty,
  type RuntimeObjectProperty,
  type RuntimeOntologyRelation,
  type RuntimePropertyType,
  type RuntimeStringProperty,
  type RuntimeUniqueConstraint,
} from "./document-types";
import { compactUndefined } from "./internal";

// ============================================================
// Public types
// ============================================================

/**
 * Compiled output of a runtime extension document, ready to merge into a
 * host `GraphDef`. Each `OntologyRelation`'s `from` / `to` is a `NodeType`
 * when the document name matches a declared kind, or the raw string
 * (treated as an external IRI by downstream code) otherwise.
 */
export type CompiledExtension = Readonly<{
  nodes: readonly CompiledNode[];
  edges: readonly CompiledEdge[];
  ontology: readonly OntologyRelation[];
}>;

export type CompiledNode = Readonly<{
  type: NodeType;
  unique: readonly UniqueConstraint[];
}>;

/**
 * `from` / `to` carry one entry per endpoint name from the document — a
 * `NodeType` when the name resolves to a kind declared in this same
 * extension, or the raw string otherwise. Unresolved strings are
 * preserved (not dropped) so the host-graph merge step can resolve them
 * against compile-time kinds or treat them as external IRIs.
 *
 * The `type: EdgeType` is built with only the resolved `NodeType`
 * references; merge-time reconstructs it once the full endpoint set is
 * known.
 */
export type CompiledEdge = Readonly<{
  type: EdgeType;
  from: readonly (NodeType | string)[];
  to: readonly (NodeType | string)[];
}>;

// ============================================================
// Compilation entry point
// ============================================================

/**
 * Compiles a validated runtime extension document into Zod-bearing kinds.
 *
 * Pure function with no I/O. Assumes the input has already passed
 * `validateRuntimeExtension(...)` — invariant violations (e.g. unknown
 * meta-edge name) are programming bugs and surface as plain `Error`s.
 */
export function compileRuntimeExtension(
  document: RuntimeGraphDocument,
): CompiledExtension {
  const nodes: CompiledNode[] = [];
  const nodeTypeByName = new Map<string, NodeType>();

  for (const [kindName, nodeDocument] of Object.entries(document.nodes ?? {})) {
    const compiled = compileNode(kindName, nodeDocument);
    nodes.push(compiled);
    nodeTypeByName.set(kindName, compiled.type);
  }

  const edges: CompiledEdge[] = [];
  for (const [kindName, edgeDocument] of Object.entries(document.edges ?? {})) {
    const compiled = compileEdge(kindName, edgeDocument, nodeTypeByName);
    edges.push(compiled);
  }

  const ontology: OntologyRelation[] = [];
  for (const relation of document.ontology ?? []) {
    ontology.push(compileOntologyRelation(relation, nodeTypeByName));
  }

  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    ontology: Object.freeze(ontology),
  });
}

// ============================================================
// Node compilation
// ============================================================

function compileNode(
  kindName: string,
  document: RuntimeNodeDocument,
): CompiledNode {
  const schema = buildObjectSchema(document.properties);

  const type = defineNode(
    kindName,
    compactUndefined({
      schema,
      description: document.description,
      annotations: document.annotations,
    }),
  );

  const unique = (document.unique ?? []).map((constraint) =>
    compileUniqueConstraint(constraint),
  );

  return Object.freeze({ type, unique: Object.freeze(unique) });
}

// ============================================================
// Edge compilation
// ============================================================

function compileEdge(
  kindName: string,
  document: RuntimeEdgeDocument,
  nodeTypeByName: ReadonlyMap<string, NodeType>,
): CompiledEdge {
  const schema = buildObjectSchema(document.properties ?? {});

  const from = document.from.map(
    (name): NodeType | string => nodeTypeByName.get(name) ?? name,
  );
  const to = document.to.map(
    (name): NodeType | string => nodeTypeByName.get(name) ?? name,
  );

  const resolvedFrom = from.filter(
    (entry): entry is NodeType => typeof entry !== "string",
  );
  const resolvedTo = to.filter(
    (entry): entry is NodeType => typeof entry !== "string",
  );

  // Cast widens `defineEdge`'s narrowed overload return back to the
  // generic public `EdgeType`. The constructed EdgeType only sees the
  // resolved endpoints; merge-time rebuilds it with the full set.
  const type = defineEdge(
    kindName,
    compactUndefined({
      schema,
      description: document.description,
      annotations: document.annotations,
      from: resolvedFrom,
      to: resolvedTo,
    }),
  ) as unknown as EdgeType;

  return Object.freeze({
    type,
    from: Object.freeze(from),
    to: Object.freeze(to),
  });
}

function buildObjectSchema(
  properties: Readonly<Record<string, RuntimePropertyType>>,
): ZodObject<ZodRawShape> {
  const shape: Record<string, ZodType> = {};
  for (const [propertyName, propertyType] of Object.entries(properties)) {
    shape[propertyName] = applyOptional(
      compileProperty(propertyType),
      propertyType,
    );
  }
  return z.object(shape);
}

// ============================================================
// Property compilation (RuntimePropertyType -> z.ZodType)
// ============================================================

function compileProperty(property: RuntimePropertyType): ZodType {
  switch (property.type) {
    case "string": {
      return compileStringProperty(property);
    }
    case "number": {
      return compileNumberProperty(property);
    }
    case "boolean": {
      return z.boolean();
    }
    case "enum": {
      return compileEnumProperty(property);
    }
    case "array": {
      return compileArrayProperty(property);
    }
    case "object": {
      return compileObjectProperty(property);
    }
  }
}

function compileStringProperty(property: RuntimeStringProperty): ZodType {
  // `searchable` and `format` are mutually exclusive (rejected by
  // validation): the format-routed schemas aren't `z.ZodString`
  // subclasses we can chain `searchable()` through.
  if (property.searchable !== undefined) {
    return applyStringRefinements(searchable(property.searchable), property);
  }
  if (property.format === undefined) {
    return applyStringRefinements(z.string(), property);
  }
  switch (property.format) {
    case "datetime": {
      return z.iso.datetime();
    }
    case "date": {
      return z.iso.date();
    }
    case "uri": {
      return z.url();
    }
    case "email": {
      return z.email();
    }
    case "uuid": {
      return z.uuid();
    }
  }
}

function applyStringRefinements(
  base: z.ZodString,
  property: RuntimeStringProperty,
): z.ZodString {
  let schema = base;
  if (property.minLength !== undefined) schema = schema.min(property.minLength);
  if (property.maxLength !== undefined) schema = schema.max(property.maxLength);
  if (property.pattern !== undefined) {
    schema = schema.regex(new RegExp(property.pattern));
  }
  return schema;
}

function compileNumberProperty(property: RuntimeNumberProperty): ZodType {
  let schema: z.ZodNumber = z.number();
  if (property.int === true) {
    schema = schema.int();
  }
  if (property.min !== undefined) {
    schema = schema.min(property.min);
  }
  if (property.max !== undefined) {
    schema = schema.max(property.max);
  }
  return schema;
}

function compileEnumProperty(property: RuntimeEnumProperty): ZodType {
  // `z.enum([...])` requires at least one value; validation guarantees
  // this. The cast quiets the readonly-tuple check Zod's overload uses.
  return z.enum(property.values as unknown as [string, ...string[]]);
}

function compileArrayProperty(property: RuntimeArrayProperty): ZodType {
  if (property.embedding !== undefined) {
    // The embedding modifier replaces the ordinary `z.array(z.number())`
    // with the branded `embedding(dimensions)` schema so downstream
    // vector-search code recognises it via `getEmbeddingDimensions`.
    return embedding(property.embedding.dimensions);
  }
  const inner = compilePropertyForArrayItem(property.items);
  return z.array(inner);
}

function compilePropertyForArrayItem(item: RuntimeArrayItemType): ZodType {
  return applyOptional(compileProperty(item), item);
}

function compileObjectProperty(property: RuntimeObjectProperty): ZodType {
  return buildObjectSchema(property.properties);
}

function applyOptional(
  schema: ZodType,
  property: { optional?: boolean },
): ZodType {
  return property.optional === true ? schema.optional() : schema;
}

// ============================================================
// Unique constraint compilation
// ============================================================

function compileUniqueConstraint(
  document: RuntimeUniqueConstraint,
): UniqueConstraint {
  const base = {
    name: document.name,
    fields: document.fields,
    scope: document.scope ?? "kind",
    collation: document.collation ?? "binary",
  };
  if (document.where === undefined) {
    return base;
  }
  return {
    ...base,
    where: makeWherePredicate(document.where.field, document.where.op),
  };
}

/**
 * One-arg field-builder shape consumers pass into `where`. Exposed as
 * its own type so the predicate factory can be typed without leaking
 * the internal predicate-builder generic from `core/types.ts`.
 */
type UniquePredicateFieldBuilder = Readonly<{
  isNull: () => unknown;
  isNotNull: () => unknown;
}>;

type UniqueWhereCallback = (
  props: Readonly<Record<string, UniquePredicateFieldBuilder>>,
) => Readonly<{
  __type: "unique_predicate";
  field: string;
  op: "isNull" | "isNotNull";
}>;

/**
 * Builds the `where` callback `defineGraph`'s constraint plumbing
 * expects. The callback receives a per-field predicate builder and must
 * return `{ __type: "unique_predicate", field, op }`. Mirrors the shape
 * `serializeWherePredicate` walks at persistence time.
 */
function makeWherePredicate(
  field: string,
  op: "isNull" | "isNotNull",
): UniqueWhereCallback {
  return (props) => {
    const builder = props[field];
    if (builder === undefined) {
      // The runtime predicate object is the source of truth — even if the
      // builder is missing (which validation should have prevented) the
      // returned shape matches what consumers and serialization expect.
      return { __type: "unique_predicate", field, op };
    }
    const result = op === "isNull" ? builder.isNull() : builder.isNotNull();
    return result as ReturnType<UniqueWhereCallback>;
  };
}

// ============================================================
// Ontology compilation
// ============================================================

const META_EDGE_BY_NAME: Readonly<Record<MetaEdgeName, MetaEdge>> =
  Object.fromEntries(
    ALL_META_EDGE_NAMES.map((name) => [name, coreOntology[`${name}MetaEdge`]]),
  ) as Readonly<Record<MetaEdgeName, MetaEdge>>;

function compileOntologyRelation(
  relation: RuntimeOntologyRelation,
  nodeTypeByName: ReadonlyMap<string, NodeType>,
): OntologyRelation {
  // `relation.metaEdge` is typed as `MetaEdgeName` so the lookup is
  // total. Validation rejects out-of-range names before they ever
  // reach the compiler.
  const metaEdge = META_EDGE_BY_NAME[relation.metaEdge];

  const fromNode = nodeTypeByName.get(relation.from);
  const toNode = nodeTypeByName.get(relation.to);

  // Mirror the `OntologyRelation` shape used by compile-time relation
  // factories: NodeType references when resolvable, raw string for
  // external IRIs.
  return {
    metaEdge,
    from: fromNode ?? relation.from,
    to: toNode ?? relation.to,
  };
}
