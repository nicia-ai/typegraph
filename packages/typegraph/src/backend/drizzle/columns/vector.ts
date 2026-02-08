/**
 * Custom Drizzle column type for pgvector's VECTOR type.
 *
 * Provides native support for PostgreSQL vector embeddings without
 * requiring runtime casts in queries.
 *
 * @example
 * ```typescript
 * import { pgTable, text, integer } from "drizzle-orm/pg-core";
 * import { vector } from "./columns/vector";
 *
 * const embeddings = pgTable("embeddings", {
 *   id: text("id").primaryKey(),
 *   embedding: vector("embedding"),
 *   dimensions: integer("dimensions"),
 * });
 * ```
 */
import { customType } from "drizzle-orm/pg-core";

/**
 * PostgreSQL vector column type for pgvector extension.
 *
 * Stores embeddings as native VECTOR type, enabling efficient
 * similarity search without runtime casts.
 *
 * The column type is unparameterized (`VECTOR` not `VECTOR(N)`)
 * to support multiple embedding dimensions in a single table.
 * Dimension validation is handled at the application level.
 *
 * @example
 * ```typescript
 * // In table definition
 * embedding: vector("embedding").notNull(),
 *
 * // In queries - no cast needed
 * db.execute(sql`
 *   SELECT * FROM embeddings
 *   WHERE embedding <=> ${formatVector([0.1, 0.2, 0.3])} < 0.5
 * `);
 * ```
 */
export const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions?: number };
}>({
  dataType(config) {
    // Use parameterized type if dimensions specified, otherwise unparameterized
    return config?.dimensions ? `vector(${config.dimensions})` : "vector";
  },

  toDriver(value: number[]): string {
    // Format as pgvector literal: [1.0,2.0,3.0]
    return `[${value.join(",")}]`;
  },

  fromDriver(value: string): number[] {
    // pgvector returns '[1,2,3]' format
    // Handle both string and already-parsed array (some drivers differ)
    if (Array.isArray(value)) {
      return value as number[];
    }
    // Parse the string representation
    const content = value.slice(1, -1); // Remove [ and ]
    if (content === "") {
      return [];
    }
    return content.split(",").map((s) => Number.parseFloat(s.trim()));
  },
});

/**
 * Formats a number array as a pgvector literal string.
 *
 * Use this when building raw SQL queries with embeddings.
 *
 * @example
 * ```typescript
 * const embedding = [0.1, 0.2, 0.3];
 * db.execute(sql`
 *   SELECT * FROM embeddings
 *   WHERE embedding <=> ${formatVector(embedding)}::vector < 0.5
 * `);
 * ```
 */
export function formatVector(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}
