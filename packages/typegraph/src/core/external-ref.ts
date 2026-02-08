/**
 * External reference type for hybrid overlay patterns.
 *
 * Creates a Zod-compatible schema for referencing entities in external
 * data sources (e.g., existing application tables) from TypeGraph nodes.
 */
import { z } from "zod";

// ============================================================
// External Reference Metadata Symbol
// ============================================================

/**
 * Symbol key for storing external table name on the schema.
 * This allows the schema introspector to detect external reference types
 * and extract source information.
 */
export const EXTERNAL_REF_TABLE_KEY = "_externalRefTable" as const;

// ============================================================
// External Reference Value Type
// ============================================================

/**
 * The shape of an external reference value.
 * Contains the source table identifier and the ID of the referenced record.
 */
export type ExternalRefValue<T extends string = string> = Readonly<{
  table: T;
  id: string;
}>;

// ============================================================
// External Reference Schema Type
// ============================================================

/**
 * A Zod schema for external references with attached table metadata.
 */
export type ExternalRefSchema<T extends string = string> = z.ZodType<
  ExternalRefValue<T>
> &
  Readonly<{
    [EXTERNAL_REF_TABLE_KEY]: T;
  }>;

// ============================================================
// External Reference Factory
// ============================================================

/**
 * Creates a Zod schema for referencing external data sources.
 *
 * Use this when building a hybrid overlay where TypeGraph stores
 * graph relationships and metadata while your existing tables
 * remain the source of truth for entity data.
 *
 * @param table - The identifier for the external table/source (e.g., "users", "documents")
 * @returns A Zod schema that validates external reference objects
 *
 * @example
 * ```typescript
 * import { defineNode, externalRef, embedding } from "@nicia-ai/typegraph";
 *
 * // Reference documents from your existing application database
 * const Document = defineNode("Document", {
 *   schema: z.object({
 *     source: externalRef("documents"),
 *     embedding: embedding(1536).optional(),
 *     extractedTopics: z.array(z.string()).optional(),
 *   }),
 * });
 *
 * // Create a node referencing an external document
 * await store.nodes.Document.create({
 *   source: { table: "documents", id: "doc_abc123" },
 *   embedding: await generateEmbedding(docContent),
 * });
 *
 * // Query and hydrate with external data
 * const results = await store
 *   .query()
 *   .from("Document", "d")
 *   .whereNode("d", (d) => d.embedding.similarTo(query, 10))
 *   .select((ctx) => ctx.d.source)
 *   .execute();
 *
 * // Fetch full data from your app database
 * const externalIds = results.map((r) => r.id);
 * const fullDocs = await appDb.query.documents.findMany({
 *   where: inArray(documents.id, externalIds),
 * });
 * ```
 */
export function externalRef<T extends string>(table: T): ExternalRefSchema<T> {
  if (typeof table !== "string" || table.length === 0) {
    throw new Error(
      `External reference table must be a non-empty string, got: ${typeof table === "string" ? `"${table}"` : typeof table}`,
    );
  }

  const schema = z.object({
    table: z.literal(table),
    id: z.string().min(1, "External reference ID must be non-empty"),
  });

  // Attach table metadata for introspection
  return Object.assign(schema, {
    [EXTERNAL_REF_TABLE_KEY]: table,
  }) as unknown as ExternalRefSchema<T>;
}

// ============================================================
// Type Guards
// ============================================================

/**
 * Checks if a value is an external reference schema.
 */
export function isExternalRefSchema(
  value: unknown,
): value is ExternalRefSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    EXTERNAL_REF_TABLE_KEY in value &&
    typeof (value as Record<string, unknown>)[EXTERNAL_REF_TABLE_KEY] ===
      "string"
  );
}

/**
 * Gets the table name from an external reference schema.
 * Returns undefined if the schema is not an external reference schema.
 */
export function getExternalRefTable(schema: z.ZodType): string | undefined {
  if (isExternalRefSchema(schema)) {
    return schema[EXTERNAL_REF_TABLE_KEY];
  }
  return undefined;
}

// ============================================================
// Helper for creating reference values
// ============================================================

/**
 * Helper function to create a typed external reference value.
 * Useful when you want to avoid repeating the table name.
 *
 * @example
 * ```typescript
 * const docRef = createExternalRef("documents");
 *
 * await store.nodes.Document.create({
 *   source: docRef("doc_123"),
 *   embedding: [...],
 * });
 * ```
 */
export function createExternalRef<T extends string>(
  table: T,
): (id: string) => ExternalRefValue<T> {
  return (id: string) => ({ table, id });
}
