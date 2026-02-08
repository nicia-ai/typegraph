import { nanoid } from "nanoid";

/**
 * ID generation utilities.
 *
 * Default implementation uses nanoid.
 * Benefits:
 * - URL-safe
 * - Compact (21 characters by default)
 * - Secure random generation
 */

/**
 * Generates a new unique ID.
 */
export function generateId(): string {
  return nanoid();
}

/**
 * ID generator function type.
 */
export type IdGenerator = () => string;

/**
 * Default ID generator configuration.
 */
export type IdConfig = Readonly<{
  /** Generator for node IDs */
  nodeIdGenerator: IdGenerator;
  /** Generator for edge IDs */
  edgeIdGenerator: IdGenerator;
}>;
