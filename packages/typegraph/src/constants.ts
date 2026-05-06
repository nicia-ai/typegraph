/**
 * Shared constants used across the TypeGraph codebase.
 */

// ============================================================
// PostgreSQL Limits
// ============================================================

/**
 * PostgreSQL truncates identifiers longer than 63 bytes.
 * Used for column aliases, index names, and other generated identifiers.
 */
export const MAX_PG_IDENTIFIER_LENGTH = 63;

/** Maximum byte length for the truncated portion of a generated identifier. */
export const TRUNCATED_IDENTIFIER_MAX_LENGTH = 54;

/** Maximum length for a single component (kind name, field name) in a generated identifier. */
export const IDENTIFIER_COMPONENT_MAX_LENGTH = 20;

// ============================================================
// FNV-1a Hash Constants
// ============================================================

/** FNV-1a 32-bit offset basis. */
export const FNV1A_OFFSET_BASIS = 0x81_1c_9d_c5;

/** FNV-1a 32-bit prime. */
export const FNV1A_PRIME = 0x01_00_01_93;

// ============================================================
// Pagination
// ============================================================

/** Default page size for paginate() and cursor-based pagination. */
export const DEFAULT_PAGINATION_LIMIT = 20;

/** Default batch size for streaming query results. */
export const DEFAULT_STREAM_BATCH_SIZE = 1000;

// ============================================================
// Path Delimiters
// ============================================================

/** SQLite stores array paths as pipe-delimited strings: |id1|id2|id3| */
export const SQLITE_PATH_DELIMITER = "|";

/** PostgreSQL text arrays use comma-separated elements: {id1,id2,id3} */
export const PG_PATH_ELEMENT_SEPARATOR = ",";

/** PostgreSQL text array start delimiter. */
export const PG_ARRAY_START = "{";

/** PostgreSQL text array end delimiter. */
export const PG_ARRAY_END = "}";
