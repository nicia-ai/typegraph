import { type z } from "zod";

import {
  assertSchemaKeysAreFree,
  RESERVED_NODE_KEYS,
} from "../store/reserved-keys";
import { assertJsonValue } from "./json-value";
import { type KindAnnotations, NODE_TYPE_BRAND, type NodeType } from "./types";

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
  /**
   * Consumer-owned structured annotations for the kind.
   *
   * Stored in the canonical schema and **participates in schema hashing** —
   * any change bumps the schema version and shows up as a `safe`-severity
   * diff in `getSchemaChanges`. See `KindAnnotations` for the contract.
   */
  annotations?: KindAnnotations;
}>;

// ============================================================
// Node Factory
// ============================================================

function validateSchemaKeys(
  schema: z.ZodObject<z.ZodRawShape>,
  name: string,
): void {
  assertSchemaKeysAreFree(
    "Node",
    name,
    Object.keys(schema.shape),
    RESERVED_NODE_KEYS,
  );
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
  if (options.annotations !== undefined) {
    assertJsonValue(options.annotations, "annotations", `Node "${name}"`);
  }

  return Object.freeze({
    [NODE_TYPE_BRAND]: true as const,
    kind: name,
    schema: options.schema,
    description: options.description,
    annotations: options.annotations,
  });
}
