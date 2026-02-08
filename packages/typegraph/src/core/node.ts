import { type z } from "zod";

import { ConfigurationError } from "../errors/index";
import { NODE_TYPE_BRAND, type NodeType } from "./types";

// ============================================================
// Reserved Keys
// ============================================================

/**
 * Property names that are reserved for system use and cannot appear in node schemas.
 * These are used for flattened node instances where props are spread at the top level.
 */
const RESERVED_NODE_KEYS = new Set(["id", "kind", "meta"]);

// ============================================================
// Node Factory Options
// ============================================================

/**
 * Options for defining a node type.
 */
export type DefineNodeOptions<S extends z.ZodObject<z.ZodRawShape>> = Readonly<{
  /** Zod schema for node properties */
  schema: S;
  /** Optional description for documentation */
  description?: string;
}>;

// ============================================================
// Node Factory
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
    RESERVED_NODE_KEYS.has(key),
  );
  if (conflicts.length > 0) {
    throw new ConfigurationError(
      `Node "${name}" schema contains reserved property names: ${conflicts.join(", ")}`,
      { nodeType: name, conflicts, reservedKeys: [...RESERVED_NODE_KEYS] },
      {
        suggestion: `Rename the conflicting properties. Reserved names (id, kind, meta) are added automatically to all nodes.`,
      },
    );
  }
}

/**
 * Creates a node type definition.
 *
 * @example
 * ```typescript
 * const Person = defineNode("Person", {
 *   schema: z.object({
 *     fullName: z.string().min(1),
 *     email: z.string().email().optional(),
 *   }),
 *   description: "A person in the system",
 * });
 * ```
 */
export function defineNode<
  K extends string,
  S extends z.ZodObject<z.ZodRawShape>,
>(name: K, options: DefineNodeOptions<S>): NodeType<K, S> {
  validateSchemaKeys(options.schema, name);

  return Object.freeze({
    [NODE_TYPE_BRAND]: true as const,
    name,
    schema: options.schema,
    description: options.description,
  }) as NodeType<K, S>;
}
