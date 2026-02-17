import { z } from "zod";

import { ConfigurationError } from "../errors/index";
import { EDGE_TYPE_BRAND, type EdgeType, type NodeType } from "./types";

// ============================================================
// Reserved Keys
// ============================================================

/**
 * Property names that are reserved for system use and cannot appear in edge schemas.
 * These are used for flattened edge instances where props are spread at the top level.
 */
const RESERVED_EDGE_KEYS = new Set([
  "id",
  "kind",
  "meta",
  "fromKind",
  "fromId",
  "toKind",
  "toId",
]);

// ============================================================
// Edge Factory Options
// ============================================================

/**
 * Options for defining an edge type.
 */
export type DefineEdgeOptions<
  S extends z.ZodObject<z.ZodRawShape>,
  From extends readonly NodeType[] | undefined = undefined,
  To extends readonly NodeType[] | undefined = undefined,
> = Readonly<{
  /** Zod schema for edge properties (defaults to empty object) */
  schema?: S;
  /** Optional description for documentation */
  description?: string;
  /** Node types that can be the source of this edge (domain constraint) */
  from?: From;
  /** Node types that can be the target of this edge (range constraint) */
  to?: To;
}>;

// ============================================================
// Empty Schema
// ============================================================

const EMPTY_SCHEMA = z.object({});
type EmptySchema = typeof EMPTY_SCHEMA;

// ============================================================
// Edge Factory
// ============================================================

/**
 * Validates that a schema does not contain reserved property names.
 */
function validateSchemaKeys(
  schema: z.ZodObject<z.ZodRawShape>,
  name: string,
): void {
  const shape = schema.shape;
  const conflicts = Object.keys(shape).filter((key) =>
    RESERVED_EDGE_KEYS.has(key),
  );
  if (conflicts.length > 0) {
    throw new ConfigurationError(
      `Edge "${name}" schema contains reserved property names: ${conflicts.join(", ")}`,
      { edgeType: name, conflicts, reservedKeys: [...RESERVED_EDGE_KEYS] },
      {
        suggestion: `Rename the conflicting properties. Reserved names are added automatically to all edges.`,
      },
    );
  }
}

/**
 * Creates an edge type definition.
 *
 * @example
 * ```typescript
 * // Edge with no properties
 * const hasEpisode = defineEdge("hasEpisode");
 *
 * // Edge with properties
 * const employedAt = defineEdge("employedAt", {
 *   schema: z.object({
 *     isPrimary: z.boolean().default(true),
 *     startedAt: z.date(),
 *   }),
 *   description: "Employment relationship",
 * });
 *
 * // Edge with domain/range constraints (can be used directly in defineGraph)
 * const worksAt = defineEdge("worksAt", {
 *   schema: z.object({ role: z.string() }),
 *   from: [Person],
 *   to: [Company],
 * });
 * ```
 */
// Overload: no options - returns edge without domain/range
export function defineEdge<K extends string>(name: K): EdgeType<K, EmptySchema>;

// Overload: options with both from and to - returns edge with domain/range
export function defineEdge<
  K extends string,
  S extends z.ZodObject<z.ZodRawShape>,
  From extends readonly NodeType[],
  To extends readonly NodeType[],
>(
  name: K,
  options: DefineEdgeOptions<S, From, To> & { from: From; to: To },
): EdgeType<K, S, From, To>;

// Overload: options without from/to - returns edge without domain/range
export function defineEdge<
  K extends string,
  S extends z.ZodObject<z.ZodRawShape>,
>(name: K, options: DefineEdgeOptions<S>): EdgeType<K, S>;

// Implementation
export function defineEdge<
  K extends string,
  S extends z.ZodObject<z.ZodRawShape>,
  From extends readonly NodeType[] | undefined,
  To extends readonly NodeType[] | undefined,
>(
  name: K,
  options?: DefineEdgeOptions<S, From, To>,
): EdgeType<K, S, From, To> | EdgeType<K, EmptySchema> {
  const schema = options?.schema ?? EMPTY_SCHEMA;
  validateSchemaKeys(schema, name);

  return Object.freeze({
    [EDGE_TYPE_BRAND]: true as const,
    kind: name,
    schema,
    description: options?.description,
    from: options?.from,
    to: options?.to,
  }) as EdgeType<K, S, From, To> | EdgeType<K, EmptySchema>;
}
