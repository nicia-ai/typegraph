import { ConfigurationError } from "../errors";

/** The kind entity a property schema is declared for. */
type KindSchemaEntity = "Node" | "Edge";

const NOT_OBJECT_CODES = {
  Node: "NODE_SCHEMA_NOT_OBJECT",
  Edge: "EDGE_SCHEMA_NOT_OBJECT",
} as const satisfies Record<KindSchemaEntity, string>;

/**
 * The Zod schema type of `schema` (`"object"`, `"union"`, `"pipe"`, …), or
 * the JavaScript type of a value that is not a Zod schema at all.
 */
function receivedSchemaType(schema: unknown): string {
  if (typeof schema === "object" && schema !== null && "type" in schema) {
    const { type } = schema as Readonly<{ type: unknown }>;
    if (typeof type === "string") return type;
  }
  return schema === null ? "null" : typeof schema;
}

/**
 * Whether `schema` is a Zod object with a readable shape: what every kind's
 * properties are stored, validated and introspected as. Objects wrapped by
 * `.refine()` / `.superRefine()` and built with `.extend()` stay objects; a
 * union, intersection, record, a `.transform()` / `.pipe()`, or an object
 * wrapped by `.optional()` / `.readonly()` / `z.lazy()` and similar is not.
 */
function isObjectSchema(schema: unknown): boolean {
  if (receivedSchemaType(schema) !== "object") return false;
  const { def } = schema as Readonly<{ def?: Readonly<{ shape?: unknown }> }>;
  return typeof def?.shape === "object" && def.shape !== null;
}

/**
 * Refuses a kind schema that is not a Zod object, before anything walks its
 * shape. The type parameter already requires `z.ZodObject`; this is the
 * runtime refusal for callers the type checker does not reach.
 */
export function assertKindSchemaIsObject(
  entity: KindSchemaEntity,
  name: string,
  schema: unknown,
): void {
  if (isObjectSchema(schema)) return;
  const schemaType = receivedSchemaType(schema);
  throw new ConfigurationError(
    `${entity} "${name}" schema must be a Zod object (z.object({...})); received a ${schemaType} schema.`,
    {
      code: NOT_OBJECT_CODES[entity],
      [`${entity.toLowerCase()}Type`]: name,
      schemaType,
    },
    {
      suggestion:
        "Declare the properties as z.object({...}). Model alternatives as a property inside one object (a discriminator field, or a union-typed property), or as separate kinds; apply transforms to individual fields.",
    },
  );
}
